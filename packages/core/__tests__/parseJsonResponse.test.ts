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
