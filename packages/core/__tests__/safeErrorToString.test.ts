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

  // Regression: an Error subclass (or a tampered native Error) could set
  // `message` to undefined, a non-string, or a throwing getter. The
  // contract is "non-throwing coercion" so this must never escape.
  it('does not throw when Error.message is undefined', () => {
    const err = new Error('x');
    (err as { message?: unknown }).message = undefined;
    expect(() => safeErrorToString(err)).not.toThrow();
    // Fallback chain: message -> name -> '[Error]'
    expect(safeErrorToString(err)).toBe('Error');
  });

  it('does not throw when Error.message is a non-string', () => {
    const err = new Error('x');
    (err as { message?: unknown }).message = 42;
    expect(() => safeErrorToString(err)).not.toThrow();
    expect(safeErrorToString(err)).toBe('Error');
  });

  it('does not throw when Error.message is a throwing getter', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'message', {
      get() { throw new Error('msg getter throws'); },
    });
    expect(() => safeErrorToString(err)).not.toThrow();
    expect(safeErrorToString(err)).toBe('Error');
  });

  it('falls back to Error.name when message is empty', () => {
    const err = new Error('');
    expect(safeErrorToString(err)).toBe('Error');
  });

  it('uses a custom name when message is missing', () => {
    class CustomError extends Error {
      constructor() {
        super('');
        this.name = 'CustomError';
      }
    }
    const err = new CustomError();
    expect(safeErrorToString(err)).toBe('CustomError');
  });

  // Regression: issue #96. The `e instanceof Error` check invokes the
  // getPrototypeOf trap on e. After the safeErrorToString patch, the
  // trap throw is caught and the function falls through to the
  // String() fallback — which does NOT invoke getPrototypeOf and so
  // returns '[object Object]'. This test pins both the no-throw
  // contract and the actual observable return value.
  it("returns '[object Object]' on a Proxy whose getPrototypeOf trap rejects", () => {
    const hostileProxy = new Proxy({}, {
      getPrototypeOf() { throw new Error('proxy rejects prototype access'); },
    });
    expect(() => safeErrorToString(hostileProxy)).not.toThrow();
    expect(safeErrorToString(hostileProxy)).toBe('[object Object]');
  });
});
