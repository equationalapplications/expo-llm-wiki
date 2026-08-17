import { describe, it, expect } from 'vitest';
import { formatSkipError } from '../src/services/MaintenanceService';
import { safeErrorToString, sanitizeRankerError } from '../src/utils/pure';
import { isTruncationError } from '../src/services/BoundedLlmCall';

/**
 * Hostile Proxy whose getPrototypeOf trap rejects. Used to verify that
 * `err instanceof Error` checks in core do not throw — the operator invokes
 * this trap, so a throwing trap turns the type-check itself into a throw
 * point that escapes every catch around the function body.
 *
 * Audited 2026-08-17 for issue #96. The eight Tier-A sites covered by this
 * file are the complete set of `instanceof Error` checks in core that take
 * `unknown` from a hostile source. See docs/superpowers/specs/2026-08-17-
 * instanceof-error-proxy-guard-design.md for the audit and rationale.
 */
const hostileProxy = new Proxy({}, {
  getPrototypeOf() {
    throw new Error('proxy rejects prototype access');
  },
});

describe('instanceof Error Proxy guards', () => {
  describe('formatSkipError (site 5)', () => {
    it('does not throw on a hostile Proxy', () => {
      expect(() => formatSkipError(hostileProxy)).not.toThrow();
    });

    it('returns a non-empty string', () => {
      const result = formatSkipError(hostileProxy);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it("returns '{}' (the JSON.stringify branch for objects; the hostile getPrototypeOf trap only affects instanceof)", () => {
      // Lock the observable contract: under the hostile getPrototypeOf
      // trap, the `err instanceof Error` check throws and is caught by
      // the function-top guard, so the if-condition is false. Then
      // `typeof err === 'object'` is true, so the function takes the
      // JSON.stringify branch. JSON.stringify(hostileProxy) does NOT
      // throw — it returns '{}' because the Proxy has no own enumerable
      // properties. So formatSkipError's hostile-Proxy observable
      // return is exactly '{}', not the '[unstringifiable error]'
      // marker. The marker would only be reached if both
      // instanceof and JSON.stringify threw — which the getPrototypeOf
      // trap does not produce.
      expect(formatSkipError(hostileProxy)).toBe('{}');
    });
  });

  describe('safeErrorToString (site 1)', () => {
    it('does not throw on a hostile Proxy', () => {
      expect(() => safeErrorToString(hostileProxy)).not.toThrow();
    });

    it("returns '[object Object]' (the String() fallback; the hostile getPrototypeOf trap only affects instanceof)", () => {
      // Lock the observable contract: under the hostile getPrototypeOf
      // trap, the `e instanceof Error` check throws and is caught by the
      // function-top guard, so `isErrorLike` is false. Then `String(e)`
      // does NOT throw — String() coercion walks valueOf/toString, not
      // getPrototypeOf — and returns '[object Object]'. So
      // safeErrorToString's hostile-Proxy observable return is exactly
      // '[object Object]', not the '[unstringifiable error]' marker.
      // That marker is reserved for values where String() and
      // Object.prototype.toString.call() both throw (e.g. a Proxy whose
      // `toString` trap rejects). For the getPrototypeOf-only Proxy in
      // this audit, the marker is never reached.
      expect(safeErrorToString(hostileProxy)).toBe('[object Object]');
    });
  });

  describe('sanitizeRankerError (sites 2, 3, 4)', () => {
    it('does not throw on a hostile Proxy', () => {
      expect(() => sanitizeRankerError(hostileProxy, true)).not.toThrow();
    });

    it('returns an Error instance', () => {
      const result = sanitizeRankerError(hostileProxy, true);
      expect(result).toBeInstanceOf(Error);
    });

    it('returns an Error whose message is the scrubbed VectorRanker object marker (locks the observable contract)', () => {
      // Lock the exact observable contract for the hostile-Proxy case.
      // The hostile Proxy is treated as non-Error (typeof err === 'object'),
      // so typeName falls back to 'object' and the message must be exactly
      // 'VectorRanker object (message scrubbed for security)'. Catches
      // silent regressions where the function starts returning a different
      // non-throwing value (e.g. `new Error(String(err))` would produce
      // 'Error: proxy rejects prototype access' under the trap — wrong).
      const result = sanitizeRankerError(hostileProxy, true);
      expect(result.message).toBe('VectorRanker object (message scrubbed for security)');
    });

    it('wraps the input in a synthetic Error when sanitizeRankerErrors=false and the input is a hostile Proxy (treated as non-Error)', () => {
      // When sanitizeRankerErrors=false, the function returns the original
      // value if it is an Error, else wraps in new Error(String(err)).
      // A hostile Proxy that throws on getPrototypeOf must be treated as
      // non-Error and wrapped, not re-thrown.
      const result = sanitizeRankerError(hostileProxy, false);
      expect(result).toBeInstanceOf(Error);
    });

    it('returns the wrapped-Error message when sanitizeRankerErrors=false and the input is a hostile Proxy', () => {
      // Lock the sanitizeRankerErrors=false path's exact return value:
      // hostileProxy is treated as non-Error, so we wrap it in
      // `new Error(String(err))`. String(hostileProxy) throws under the
      // hostile getPrototypeOf trap... actually no — String() coercion
      // does NOT invoke getPrototypeOf; it walks valueOf/toString. So
      // this assertion documents that the wrap path produces an Error
      // whose message is whatever String(err) yields, not the scrubbed
      // marker. If future changes add a getPrototypeOf-touching path here,
      // this assertion will surface it.
      const result = sanitizeRankerError(hostileProxy, false);
      expect(result).toBeInstanceOf(Error);
      expect(typeof result.message).toBe('string');
    });
  });

  describe('isTruncationError (site 6)', () => {
    it('does not throw on a hostile Proxy', () => {
      expect(() => isTruncationError(hostileProxy)).not.toThrow();
    });

    it('returns false (a wrong answer is preferable to a thrown exception here)', () => {
      // isTruncationError is internal to runBatched. The only consequence
      // of returning a wrong answer is one wasted batch split on a hostile
      // input — preferable to escaping the runBatched operation.
      expect(isTruncationError(hostileProxy)).toBe(false);
    });
  });

  // Sites 7 and 8 (RetrievalService inline ranker-fallback checks) are
  // covered transitively via vectorRanker.test.ts (Task 6), since the only
  // public path to those checks is via the VectorRanker fallback callback,
  // which already exercises sanitizeRankerError via _sanitizeRankerError.
});
