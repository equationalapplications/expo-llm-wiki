import { describe, it, expect } from 'vitest';
import { parseJsonResponse } from '../src/utils/pure';
import { WikiParseError } from '../src/types';

describe('parseJsonResponse — tier 1 (strict scanner)', () => {
  it('returns parsed object for strict happy path', () => {
    expect(parseJsonResponse<{ facts: unknown[] }>('{"facts":[]}')).toEqual({ facts: [] });
  });

  it('returns parsed array for array happy path', () => {
    expect(parseJsonResponse<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('does not run tier 2 when already valid', () => {
    // Array with normal commas — would survive a no-op walker.
    expect(parseJsonResponse<string[]>('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('object with multiple string values parses cleanly', () => {
    expect(parseJsonResponse<Record<string, string>>('{"a":"b","c":"d"}')).toEqual({ a: 'b', c: 'd' });
  });
});

describe('parseJsonResponse — tier 2 (container-aware repair)', () => {
  it('repairs a bare quote inside an object string body', () => {
    // The model emitted a literal "hi" inside the body without escaping it.
    const result = parseJsonResponse<{ body: string }>('{"body":"she said "hi""}');
    expect(result).toEqual({ body: 'she said "hi"' });
  });

  it('repairs a bare quote inside an array element string', () => {
    const result = parseJsonResponse<string[]>('["he said "hi""]');
    expect(result).toEqual(['he said "hi"']);
  });

  it('repairs multiple bare quotes in a prose-shape body', () => {
    const result = parseJsonResponse<{ body: string }>('{"body":"He said "hi", then left."}');
    expect(result).toEqual({ body: 'He said "hi", then left.' });
  });

  it('repairs a bare quote adjacent to the closing structural pair', () => {
    // closing pair: "hi"  — both quotes are content; walker must escape both.
    const result = parseJsonResponse<{ body: string }>('{"body":"He said "hi""}');
    expect(result).toEqual({ body: 'He said "hi"' });
  });

  it('repairs a bare quote inside a nested object', () => {
    const result = parseJsonResponse<{ a: { b: string } }>('{"a":{"b":"he said "x""}}');
    expect(result).toEqual({ a: { b: 'he said "x"' } });
  });

  it('does not close a value string on a `:` peek-ahead (key-vs-value role)', () => {
    // Regression: the walker previously treated every `"` followed by `:`
    // as a structural close, which prematurely ended the value string here
    // and produced unparsable JSON. The fix tracks `stringRole` so the `:`
    // signal only fires for object-key strings.
    const result = parseJsonResponse<{ body: string }>('{"body":"Example: "key": value"}');
    expect(result).toEqual({ body: 'Example: "key": value' });
  });

  it('repairs single bare quote before a later property (comma-ambiguity)', () => {
    // Regression: the walker previously chose the comma-ambiguity
    // interpretation by parity alone, which silently corrupted inputs like
    // this — title is `24" monitor` (single bare quote) followed by a real
    // `,` close; the odd count used to make the walker treat the close
    // as content, consuming `,"body":"ok"` into the title and dropping
    // the body field. The fix runs the walker twice under opposing
    // comma-ambiguity policies and accepts either parse-success.
    const result = parseJsonResponse<{ title: string; body: string }>(
      '{"title":"24" monitor","body":"ok"}',
    );
    expect(result).toEqual({ title: '24" monitor', body: 'ok' });
  });

  it('arbitrates opposing policies by minimal mutation, not trial order', () => {
    // Regression: the odd-parity pass used to be preferred whenever its
    // candidate parsed. For an EVEN number of bare quotes immediately
    // before the structural close (`He said "hi"` as a complete value),
    // the odd-parity pass swallows `,"body":"ok"` into the title — the
    // swallowed candidate still parses, so the corrupted value was
    // returned and the body field silently dropped. Both policies now run
    // and the one that escaped fewer quotes (the minimal repair) wins.
    const result = parseJsonResponse<{ title: string; body: string }>(
      '{"title":"He said "hi"","body":"ok"}',
    );
    expect(result).toEqual({ title: 'He said "hi"', body: 'ok' });
  });

  it('arbitrates inside a realistic facts array payload', () => {
    const result = parseJsonResponse<{ facts: Array<{ title: string; body: string }> }>(
      '{"facts":[{"title":"He said "hi"","body":"the full quote context"}]}',
    );
    expect(result.facts[0].title).toBe('He said "hi"');
    expect(result.facts[0].body).toBe('the full quote context');
  });

  it('repairs an even-count bare-quote value followed by a later property', () => {
    const result = parseJsonResponse<{ facts: Array<{ body: string; confidence: string }> }>(
      '{"facts":[{"title":"quote","body":"he said "hi" and "bye"","confidence":"tentative"}]}',
    );
    expect(result.facts[0].body).toBe('he said "hi" and "bye"');
    expect(result.facts[0].confidence).toBe('tentative');
  });

  it('repairs a bare-quoted span in an array element (doubled close quote)', () => {
    const result = parseJsonResponse<{ tags: string[] }>('{"tags":["say "hi"", "z"]}');
    expect(result).toEqual({ tags: ['say "hi"', 'z'] });
  });

  it('repairs a raw newline inside a string body', () => {
    // The model emitted a literal line break inside the JSON string.
    // Deterministic repair (no comma-parity ambiguity): escape it as \n.
    const result = parseJsonResponse<{ facts: Array<{ body: string }> }>(
      '{"facts":[{"title":"a","body":"line1\nline2"}]}',
    );
    expect(result.facts[0].body).toBe('line1\nline2');
  });

  it('repairs a raw tab inside a string body', () => {
    const result = parseJsonResponse<{ body: string }>('{"body":"col1\tcol2"}');
    expect(result.body).toBe('col1\tcol2');
  });

  it('falls through to a later sibling span after an unrepairable span', () => {
    // The first balanced span is unrepairable, but a complete valid object
    // follows it. The walker resets its output buffer at the failed span's
    // close so the sibling is emitted standalone rather than concatenated
    // onto the rejected prefix (which could never parse).
    const result = parseJsonResponse<{ facts: unknown[] }>(
      'noise {"bad"} tail {"facts":[]}',
    );
    expect(result).toEqual({ facts: [] });
  });
});

describe('parseJsonResponse — repair tier surfaces failed candidate', () => {
  it('balanced but invalid JSON throws WikiParseError with tier=repair and the failed slice', () => {
    // `{"facts":}` is balanced (the walker finds a complete outer span) but
    // JSON.parse rejects it. The public contract documents that
    // `WikiParseError` for `tier: 'repair'` carries the candidate slice +
    // parse position — keeping the diagnostic instead of falling through to
    // the generic `tier: 'all'` throw.
    //
    // Position is best-effort: V8 reports the position of the unexpected
    // token in the older "in JSON at position N" format. Newer V8 emits
    // "Unexpected token 'X', "..." is not valid JSON" without an explicit
    // position, so `position` is null in that case. The slice is the more
    // important diagnostic — it always carries the candidate.
    expect(() => parseJsonResponse('{"facts":}')).toThrow(WikiParseError);
    try {
      parseJsonResponse('{"facts":}');
    } catch (e) {
      const err = e as WikiParseError;
      expect(err.tier).toBe('repair');
      expect(err.slice).toBe('{"facts":}');
      if (err.position !== null) {
        expect(typeof err.position).toBe('number');
      }
    }
  });
});

describe('parseJsonResponse — failure modes throw WikiParseError', () => {
  it('truncated input (no balanced close) throws with tier=strict', () => {
    expect(() => parseJsonResponse('{')).toThrow(WikiParseError);
    try {
      parseJsonResponse('{');
    } catch (e) {
      const err = e as WikiParseError;
      expect(err.tier).toBe('strict');
      expect(err.position).toBe(0);
      expect(err.slice).toBe('{');
    }
  });

  it('input with no JSON delimiters throws with tier=strict and position=null', () => {
    expect(() => parseJsonResponse('no braces at all')).toThrow(WikiParseError);
    try {
      parseJsonResponse('no braces at all');
    } catch (e) {
      const err = e as WikiParseError;
      expect(err.tier).toBe('strict');
      expect(err.position).toBeNull();
      expect(err.slice).toBe('no braces at all');
    }
  });
});
