import { describe, it, expect } from 'vitest';
import { formatSkipError } from '../src/services/MaintenanceService';

describe('formatSkipError', () => {
  it('returns Error.message verbatim', () => {
    expect(formatSkipError(new Error('boom'))).toBe('boom');
  });

  it('returns a string as-is', () => {
    expect(formatSkipError('boom')).toBe('boom');
  });

  it('stringifies primitive values', () => {
    expect(formatSkipError(42)).toBe('42');
    expect(formatSkipError(true)).toBe('true');
    expect(formatSkipError(null)).toBe('null');
    expect(formatSkipError(undefined)).toBe('undefined');
    expect(formatSkipError(10n)).toBe('10');
  });

  it('JSON.stringify’s a plain object', () => {
    expect(formatSkipError({ code: 500, msg: 'oops' })).toBe('{"code":500,"msg":"oops"}');
  });

  // Regression: JSON.stringify(Symbol('x')) returns `undefined`. Before the
  // fix, the formatter assigned `undefined` to `text` and then called
  // `text.length` inside the bound check, which threw a TypeError from
  // `onSkip` and rejected the batch operation. The contract is "always a
  // string," so every coercion failure mode below must be covered.
  it('falls through to String() when JSON.stringify returns undefined (Symbol)', () => {
    const result = formatSkipError(Symbol('skip'));
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Symbol(skip)');
  });

  it('falls through to String() when JSON.stringify returns undefined (function)', () => {
    const result = formatSkipError(function skipped() { return 1; });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('skipped');
  });

  it('falls through to String() when JSON.stringify returns undefined (toJSON returns undefined)', () => {
    const result = formatSkipError({ toJSON: () => undefined });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back to Object.prototype.toString when both JSON.stringify and String() throw', () => {
    const err = {
      toJSON() { throw new Error('toJSON blew up'); },
      toString() { throw new Error('toString blew up'); },
    };
    const result = formatSkipError(err);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back to Object.prototype.toString when JSON.stringify throws on circular structure', () => {
    const circ: any = {};
    circ.self = circ;
    const result = formatSkipError(circ);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('truncates strings longer than SKIP_ERROR_LOG_CHARS', () => {
    const huge = 'x'.repeat(5000);
    const result = formatSkipError(huge);
    expect(result.length).toBeGreaterThan(4096);
    expect(result).toContain('truncated');
    expect(result.startsWith('xxxx')).toBe(true);
  });

  it('returns the bound character count in the truncated marker', () => {
    const huge = 'x'.repeat(5000);
    const result = formatSkipError(huge);
    // 5000 - 4096 = 904 chars truncated
    expect(result).toContain('+904 chars truncated');
  });

  it('never throws on a Proxy that rejects every property access (incl. Symbol.toStringTag)', () => {
    // Regression: previously, JSON.stringify(err) threw (proxy.get throws),
    // the catch block ran Object.prototype.toString.call(err), which also
    // reads Symbol.toStringTag via the proxy — and that threw too. The
    // throw escaped the catch and rejected the surrounding runBatched.
    // The fix delegates the unknown→string coercion to safeErrorToString,
    // whose static `[unstringifiable error]` marker is the last-resort
    // fallback. `formatSkipError` is documented to never throw; this test
    // pins that contract.
    const proxyErr = new Proxy({}, {
      get(_target, prop) {
        throw new Error('proxy rejects ' + String(prop));
      },
    });
    expect(() => formatSkipError(proxyErr)).not.toThrow();
    const result = formatSkipError(proxyErr);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  // Regression: an Error subclass with a tampered `message` (non-string or
  // throwing getter) used to throw `TypeError: Cannot read properties of
  // undefined (reading 'length')` from the bound check. `safeErrorToString`
  // now defensively coerces `message`/`name`; formatSkipError inherits the
  // hardening via delegation.
  it('does not throw on an Error with undefined message', () => {
    const err = new Error('x');
    (err as { message?: unknown }).message = undefined;
    expect(() => formatSkipError(err)).not.toThrow();
    const result = formatSkipError(err);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('does not throw on an Error with non-string message', () => {
    const err = new Error('x');
    (err as { message?: unknown }).message = 42;
    expect(() => formatSkipError(err)).not.toThrow();
    const result = formatSkipError(err);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('does not throw on an Error with throwing message getter', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'message', {
      get() { throw new Error('msg getter throws'); },
    });
    expect(() => formatSkipError(err)).not.toThrow();
    const result = formatSkipError(err);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  // Regression: issue #96. `err instanceof Error` invokes the
  // getPrototypeOf trap on err. A Proxy whose trap rejects throws out
  // of this helper, escaping the surrounding runBatched. This test pins
  // the documented "never throw" contract for the operator-level path.
  it('does not throw on a Proxy whose getPrototypeOf trap rejects', () => {
    const hostileProxy = new Proxy({}, {
      getPrototypeOf() { throw new Error('proxy rejects prototype access'); },
    });
    expect(() => formatSkipError(hostileProxy)).not.toThrow();
    const result = formatSkipError(hostileProxy);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
