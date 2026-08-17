# Defensive `instanceof Error` Guards for Hostile Proxies

Status: Implemented (PR open — awaiting merge).
Originates: Issue #96 (follow-up to PR #95, which was docs-only after #93 squash-merged onto `main`).

## Problem

JavaScript's `err instanceof X` operator invokes the `getPrototypeOf` trap on `err`. A `Proxy` whose `getPrototypeOf` trap throws turns the type-check itself into a throw point, escaping every `try/catch` placed around the *body* of the function being protected.

```js
const hostile = new Proxy({}, {
  getPrototypeOf() { throw new Error('proxy rejects prototype access'); },
});
hostile instanceof Error; // throws
```

Eight sites in `packages/core/src/` rely on `err instanceof Error` to dispatch on the shape of an `unknown` value flowing in from external or plugin-controllable sources (LLM provider errors, the VectorRanker plugin, the `onSkip` callback). Each site's docstring or name promises non-throwing behavior; the underlying operator breaks that contract when a hostile Proxy arrives.

Reproduces for the function CodeRabbit flagged on PR #95:

```ts
import { formatSkipError } from '@equationalapplications/core-llm-wiki/services/MaintenanceService';
const proxyErr = new Proxy({}, { getPrototypeOf() { throw new Error(); } });
formatSkipError(proxyErr); // throws — escapes the surrounding runBatched
```

## Scope

### In scope — eight Tier-A sites

All take `unknown` (or `unknown`-shaped values from plugin callbacks) and rely on `instanceof Error` to dispatch. Every one has a documented contract of "never throw" or "sanitize", which the current implementation does not honor under a hostile Proxy.

| #   | File:line                                       | Function                          | Source of `err`                          |
| --- | ----------------------------------------------- | --------------------------------- | ---------------------------------------- |
| 1   | `packages/core/src/utils/pure.ts:545`           | `safeErrorToString`               | callers (provider errors, parse errors)  |
| 2   | `packages/core/src/utils/pure.ts:592`           | `sanitizeRankerError`             | VectorRanker plugin                      |
| 3   | `packages/core/src/utils/pure.ts:592`           | `sanitizeRankerError`             | VectorRanker plugin                      |
| 4   | `packages/core/src/utils/pure.ts:592`           | `sanitizeRankerError`             | VectorRanker plugin                      |
| 5   | `packages/core/src/services/MaintenanceService.ts:125` | `formatSkipError`            | `onSkip` callback (provider errors)      |
| 6   | `packages/core/src/services/BoundedLlmCall.ts:70`     | `isTruncationError`          | LLM provider, called from `runBatched`   |
| 7   | `packages/core/src/services/RetrievalService.ts:350`  | (inline in ranker fallback)  | VectorRanker plugin                      |
| 8   | `packages/core/src/services/RetrievalService.ts:513`  | (inline in catch block)      | caught from inner try                    |

Sites 2–4 collapse to one boolean (`sanitizeRankerError` runs three `instanceof Error` checks against the same value; the fix hoists them into a single `try { isErrorLike = err instanceof Error } catch {}` at `utils/pure.ts:592`). Sites 7–8 share a similar shape inside one method.

### Out of scope — Tier-B sites

| Pattern                                                | Why excluded                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `instanceof WikiBusyError` / `WikiParseError` / `WikiTransactionError` (4 sites) | Project-defined error classes constructed with `new` at known throw sites; values reaching the checks come from internal try blocks, not from `unknown` flowing in across a trust boundary. |
| `instanceof Uint8Array` (2 sites) and `instanceof Float32Array` (2 sites)       | Values come from SQLite or from the embedding service's typed output. Real typed arrays, not Proxies. No attack surface in practice.        |

Hardening Tier-B would add ~12 lines of defensive boilerplate without closing an actual vulnerability. The audit command for future re-runs is documented in the "Verification" section.

## Design

### Rationale

The bug is a structural property of the `instanceof` operator, not of the data flow around it. The fix has to intercept the operator, not pad the body with more try/catch.

Three properties make inline `try/catch` the right shape:

1. **Locality of intent.** Each site already has a docstring contract ("never throw", "non-throwing by construction", "sanitize"). The fix lives next to that contract.
2. **One primitive, no new surface.** `try { return x instanceof Y } catch { return false }` is four lines, no exports, no API to version. `safeErrorToString` already uses this exact pattern (`readErrorField` at `utils/pure.ts:576–582`) — matching the local convention rather than introducing a new one.
3. **Per-site control of the fallback.** A helper forces one policy; inline lets each site pick. In practice all eight sites want `false`-on-throw (treat as non-Error, fall through), but keeping them inline means future divergence is one edit, not one helper signature.

### Alternatives considered

- **New `safeInstanceof<T>(value, ctor): boolean` helper in `utils/pure.ts`.** Reusable and grep-auditable, but adds a public export, forces one policy across call sites, and isn't justified at eight call sites with identical intent. Rejected.
- **Manual `Object.getPrototypeOf` chain walk.** Doesn't solve the problem — `Object.getPrototypeOf` invokes the same trap. Rejected.
- **Duck-type check (`typeof err.message === 'string'`).** Wrong contract: domain error classes (`WikiParseError`, custom provider errors) wouldn't be detected and would silently fall into the JSON branch. Also still walks properties on a Proxy, so it doesn't remove the trap risk. Rejected.
- **ESLint rule banning bare `instanceof` outside a whitelist.** Out of scope; would require build-config changes and per-site judgment about whether the operand is `unknown` or typed. Deferred to "Future work".

### Per-site code change

The pattern is identical across all eight sites. Showing the canonical case; the rest are mechanical.

**Canonical (Site 5 — `MaintenanceService.formatSkipError`):**

```ts
// Before
if (err instanceof Error || (typeof err !== 'object' && typeof err !== 'function')) {

// After
let isErrorLike = false;
try {
  isErrorLike = err instanceof Error;
} catch {
  // Hostile Proxy whose getPrototypeOf trap rejects — treat as non-Error
  // and fall through to the JSON.stringify / safeErrorToString branch.
}
if (isErrorLike || (typeof err !== 'object' && typeof err !== 'function')) {
```

This is the canonical pattern. Sites 1, 6, 7, 8 use the same shape. Sites 2–4 (`sanitizeRankerError`) use a single boolean at function top because three sequential checks share the same `err`.

**Sites 2–4 (`sanitizeRankerError`):** Three sequential checks against the same `err`; one local boolean replaces three throws.

```ts
export function sanitizeRankerError(err: unknown, sanitizeRankerErrors: boolean | undefined): Error {
  let isErrorLike = false;
  try { isErrorLike = err instanceof Error; }
  catch { /* already false */ }
  if (sanitizeRankerErrors === false) {
    return isErrorLike ? err : new Error(String(err));
  }
  const typeName = isErrorLike ? (err.constructor?.name ?? 'Error') : typeof err;
  const innerCause =
    isErrorLike && err.cause !== undefined
      ? new Error(`Caused by: ${(err.cause as Error)?.constructor?.name ?? typeof err.cause}`)
      : undefined;
  // ...rest unchanged
}
```

**Site 6 (`isTruncationError`):** The function returns a boolean used internally by `runBatched`; if the underlying `err instanceof Error` throws, the only consequence is a wrong answer (one wasted batch split). The contract is explicit: `isTruncationError` should return `false` (treating the value as non-truncation-related) when a hostile Proxy appears — never throw. The try/catch wraps the entire expression:

```ts
let message: string;
try {
  message = err instanceof Error ? err.message : String(err ?? '');
} catch {
  return false;
}
```

**Sites 7–8 (`RetrievalService`):** Same single-guard-at-top pattern as `sanitizeRankerError`, applied to each method body.

## Risk analysis

| Risk                                                                                | Likelihood | Impact | Mitigation                                                                                                |
| ----------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------- |
| Fix breaks an existing call site that *expected* the throw                          | Low        | High   | All eight sites have "never throw" contracts; no callers catch and inspect the throw type. Full vitest run before PR. |
| `try { ... } catch { return false }` changes V8/JIT optimization shape              | Low        | None   | Both branches are trivial; not in any steady-state hot path.                                                |
| Forgetting a future `instanceof Error` site                                          | Medium     | Medium | Audit command documented in "Verification" so future audits are mechanical. ESLint rule deferred to follow-up. |
| Inline duplication feels copy-pasted                                                 | Low        | Low    | 4 lines × 8 sites. Helper not justified at this scale; revisit if it grows past ~12.                       |
| `sanitizeRankerError` fix changes observable behavior of `onVectorRankerFallback`   | Low        | Medium | Callers still receive an `Error`. With the fix, a hostile Proxy returns `Error('VectorRanker object (message scrubbed for security)')` instead of throwing through the callback — matching the function's name. Tested via `vectorRanker.test.ts`. |

## Test strategy

### One new dedicated regression file

`packages/core/__tests__/instanceofErrorProxyGuard.test.ts`

- Defines one helper that constructs a `Proxy` whose `getPrototypeOf` trap throws.
- For each Tier-A function, imports it and asserts:
  1. The call does not throw.
  2. The return value is well-typed (`string` for the string-returning helpers; `Error` instance for `sanitizeRankerError`; `boolean` for `isTruncationError`).
  3. The specific observable return value for the hostile-Proxy case matches the function's contract — e.g. `_sanitizeRankerError` returns `new Error('VectorRanker object (message scrubbed for security)')`, `isTruncationError` returns `false`, `formatSkipError` returns `'{}'` (via the `JSON.stringify` branch — `JSON.stringify(hostileProxy)` returns the empty-object literal because the Proxy has no own enumerable properties and does not invoke `getPrototypeOf`). This locks the observable contract and catches silent regressions where the function starts returning a different non-throwing value.

This file is the single grep target for future audits of the same vulnerability class.

### Per-function smoke tests in existing files

| Test file                                                | New test                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/core/__tests__/formatSkipError.test.ts`        | `does not throw on a Proxy whose getPrototypeOf trap rejects` (the literal issue #96 case)                            |
| `packages/core/__tests__/safeErrorToString.test.ts`      | `does not throw on a Proxy whose getPrototypeOf trap rejects` — assert returns `'[object Object]'` (`String(e)` and `Object.prototype.toString.call(e)` do NOT invoke `getPrototypeOf`, so both return `'[object Object]'` under the hostile `getPrototypeOf`-only trap; the `[unstringifiable error]` marker is reserved for inputs where both throw) |
| `packages/core/__tests__/BoundedLlmCall.test.ts`         | `isTruncationError returns false on a Proxy whose getPrototypeOf trap rejects`                                         |
| `packages/core/__tests__/vectorRanker.test.ts`           | `_sanitizeRankerError returns an Error instance on a hostile Proxy` (covers RetrievalService call sites transitively) |

Neither layer is redundant. The dedicated file is a single grep target. The per-file tests keep the regression discoverable when reading the function in isolation.

## Files touched

**Modified (4 source files):**

- `packages/core/src/utils/pure.ts` — sites 1, 2, 3, 4
- `packages/core/src/services/BoundedLlmCall.ts` — site 6
- `packages/core/src/services/MaintenanceService.ts` — site 5
- `packages/core/src/services/RetrievalService.ts` — sites 7, 8

**Modified (4 test files):** the four listed in the per-function smoke-tests table above.

**New (1 test file):**

- `packages/core/__tests__/instanceofErrorProxyGuard.test.ts`

## Verification

After implementation:

1. `pnpm --filter @equationalapplications/core-llm-wiki test` — full suite green.
2. ```bash
   # Total instanceof Error code sites in core (filter out documentation
   # comment lines that mention the pattern; the fix's comments do, which
   # would otherwise inflate the count).
   TOTAL=$(grep -rn 'instanceof Error' packages/core/src | grep -vE ':\s*(//|\*)' | wc -l)
   # Sites protected with try/catch — handles both forms:
   #   - multi-line:  `try {` on the line(s) above `instanceof Error`
   #   - single-line: `try { ... instanceof Error ... } catch {}` on one line
   # A simple `grep -B1` only matches the multi-line form, so this script
   # uses awk to track whether a `try {` has been seen on any recent line.
   PROTECTED=$(awk -F: '
     {
       line = $0
       sub(/^[^:]+:/, "", line)
       sub(/^[0-9]+:/, "", line)
       if (line ~ /try \{/) has_try = 1
       if (line ~ /instanceof Error/) {
         if (has_try) count++
         has_try = 0
       }
     }
     END { print count+0 }
   ' <(grep -rn -E 'instanceof Error|try \{' packages/core/src | grep -vE ':\s*(//|\*)'))
   echo "Protected: $PROTECTED / $TOTAL"
   test "$PROTECTED" -eq "$TOTAL"
   ```
   Asserts `$PROTECTED == $TOTAL` — every `instanceof Error` code site is wrapped in a `try` block. The comment filter is required: the fix patches themselves add comments that mention `instanceof Error` to document the rationale, which would otherwise inflate `TOTAL`. Sites listed as out-of-scope (Tier-B) should be excluded via additional filtering.
3. The dedicated regression test fails on every Tier-A function before the fix and passes after.
4. The new `formatSkipError` smoke test fails on `main` before the source fix lands and passes after.

### Audit gate (for code-review time)

To verify that all Tier-A `instanceof Error` checks are properly guarded, run the following audit command. It counts total `instanceof Error` sites and verifies that each is within its corresponding try block (scoped to the same block, not carrying `has_try` across unrelated code).

```bash
# Count total instanceof Error sites in packages/core/src
TOTAL=$(grep -rn 'instanceof Error' packages/core/src | grep -vE ':\s*(//|\*)' | wc -l | tr -d ' ')
echo "Total: $TOTAL"

# Count protected sites (instanceof Error within its own try block)
# Uses structural parsing: reset has_try at each instanceof, only count if try appeared AFTER the last instanceof
PROTECTED=$(awk -F: '
  {
    line = $0
    sub(/^[^:]+:/, "", line)
    sub(/^[0-9]+:/, "", line)
    # Reset has_try when we encounter instanceof Error (new check starts)
    if (line ~ /instanceof Error/) {
      if (has_try) count++
      has_try = 0
    } else if (line ~ /try \{/) {
      # Set has_try only after last instanceof was reset
      has_try = 1
    }
  }
  END { print count+0 }
' <(grep -rn -E 'instanceof Error|try \{' packages/core/src | grep -vE ':\s*(//|\*)'))
echo "Protected: $PROTECTED / $TOTAL"
test "$PROTECTED" -eq "$TOTAL" || { echo "FAIL: $PROTECTED/$TOTAL instanceof Error sites are guarded"; exit 1; }
```

## Future work (out of scope for this fix)

- **ESLint rule** banning bare `instanceof` outside an explicit whitelist, with `// eslint-disable-next-line` justification required. Worth doing once the pattern repeats in a third place.
- **Re-audit** of any newly-added `instanceof Error` site at code-review time. The audit command in "Verification" should be in the reviewer checklist for core-package PRs.
