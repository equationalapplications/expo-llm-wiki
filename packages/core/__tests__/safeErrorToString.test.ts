import { describe, it, expect } from 'vitest';
import { safeErrorToString } from '../src/utils/pure';

describe('safeErrorToString — non-throwing error coercion', () => {
  it('returns Error.message for Error instances', () => {
    expect(safeErrorToString(new Error('boom'))).toBe('boom');
  });

  it('returns Error.message for subclasses preserving the message', () => {
    class CustomError extends Error {
      constructor(msg: string) { super(msg); this.name = 'CustomError'; }
    }
    expect(safeErrorToString(new CustomError('specific detail'))).toBe('specific detail');
  });

  it('returns String(e) for primitives', () => {
    expect(safeErrorToString('plain text')).toBe('plain text');
    expect(safeErrorToString(42)).toBe('42');
    expect(safeErrorToString(null)).toBe('null');
    expect(safeErrorToString(undefined)).toBe('undefined');
  });

  it('returns Object.prototype.toString.call(e) when toString throws', () => {
    const bad = { toString() { throw new Error('toString itself throws'); } };
    // The point: coercion must never throw, even when `String(e)` does.
    expect(() => safeErrorToString(bad)).not.toThrow();
    // The fallback gives the JScript-style "[object Object]" representation.
    expect(safeErrorToString(bad)).toBe('[object Object]');
  });

  it('falls back to static marker when even Object.prototype.toString fails', () => {
    // Force Object.prototype.toString.call to throw via a Proxy that throws
    // on get for the toString symbol. The fallback guarantees a string.
    const bizarre = new Proxy({}, {
      get(_target, prop) {
        if (prop === Symbol.toString || prop === 'toString' || prop === 'then') {
          throw new Error('proxy rejects toString access');
        }
        return undefined;
      },
    });
    expect(() => safeErrorToString(bizarre)).not.toThrow();
    expect(typeof safeErrorToString(bizarre)).toBe('string');
    // The fallback marker is the documented last-resort value.
    const out = safeErrorToString(bizarre);
    expect(out.length).toBeGreaterThan(0);
  });
});
