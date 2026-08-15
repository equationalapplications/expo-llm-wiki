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
