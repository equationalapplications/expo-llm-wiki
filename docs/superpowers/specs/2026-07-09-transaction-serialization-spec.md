# Spec: Transaction Serialization & Connection-Wedge Hardening

**Date:** 2026-07-09
**Status:** Implemented
**Packages:** `core-llm-wiki` (primary), `expo-llm-wiki` (adapter + docs)

---

## Problem

Production incident (host app, web, 2026-07-09): concurrent wiki operations on a single
shared SQLite connection produced:

```text
Error code 1: cannot start a transaction within a transaction
Error code 1: cannot rollback - no transaction is active
```

followed by a wedged connection cascade: `importDump timed out after 8000ms`,
`Sync timeout for entity … after 60000ms`, and endless
`librarian already running … retrying` loops.

Root cause chain:

1. `WikiMemory` is constructed over **one** `SQLiteAdapter` (one connection). Every
   write path opens its own transaction via `db.withTransactionAsync(...)`:
   - `WriteService.write` (`packages/core/src/services/WriteService.ts`)
   - `ImportExportService.importDump` (`packages/core/src/services/ImportExportService.ts`)
   - `WikiMemory.setOntologyManifest` (`packages/core/src/WikiMemory.ts`)
   - `WikiMemory.setup` source-ref migration (`packages/core/src/WikiMemory.ts`)
   - `IngestionService` (1 site), `MaintenanceService` (5 sites), `db/migrations.ts`
2. Neither core nor the Expo adapter serializes these calls. The Expo adapter
   (`packages/expo/src/adapter.ts`) forwards straight to
   `expo-sqlite`'s `db.withTransactionAsync`.
3. Two overlapping callers (e.g. a host app syncing two entities concurrently, or a
   fire-and-forget `setOntologyManifest` racing an `importDump`) issue nested `BEGIN`
   → SQLite error 1.
4. The failed transaction's cleanup then issues `ROLLBACK` with no active transaction,
   producing a *second* error that masks the first and leaves the connection in an
   inconsistent state for subsequent callers.

The library's implicit contract today is "never call two write APIs concurrently" —
undocumented, unenforced, and violated by realistic host-app code. For adoption, the
library must be **safe by construction**: adopters should never need to know SQLite
forbids nested `BEGIN`.

---

## Solution

Serialize all transactions **inside core** with an internal async mutex, guard
rollback cleanup so a failed `BEGIN` cannot mask the original error, and document the
concurrency contract publicly. No public API changes; ship as a `fix:` patch release
via semantic-release.

---

## Design Decisions

### 1. Core owns serialization (not adapters, not host apps)

A promise-chain mutex wraps `withTransactionAsync` **once**, in the `WikiMemory`
constructor, before the adapter is handed to any repository or service:

```ts
// packages/core/src/db/serializedAdapter.ts (new)
const DEADLOCK_WARN_MS = 10_000;

export function withSerializedTransactions(db: SQLiteAdapter): SQLiteAdapter {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    ...db,
    withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
      // Warn if a call waits too long for the lock — the signature of the
      // closure-capture deadlock in Decision 2 (calling the outer `db` instead
      // of `tx` inside a callback). Cleared the instant the lock is acquired,
      // so it measures queue wait only and never trips on a legitimately long
      // transaction.
      const warn = setTimeout(() => {
        console.warn(
          '[core-llm-wiki] Transaction queued >10s — possible deadlock. ' +
          'Inside a transaction callback, use the `tx` parameter, never the ' +
          'outer database handle.'
        );
      }, DEADLOCK_WARN_MS);

      // Proceed from a settled state (swallow the previous outcome), then run.
      const run = queue
        .catch(() => undefined)
        .then(() => {
          clearTimeout(warn);
          // Re-wrap the tx handed to the callback so a *nested*
          // withTransactionAsync throws synchronously (Decision 2). The
          // reentrancy guard lives HERE, not "on the tx" — underlying adapters
          // decide what `tx` is (the expo adapter passes the outer adapter
          // itself as `tx`; see below), so core must inject the guard.
          return db.withTransactionAsync((tx) =>
            fn(guardReentrancy(tx))
          );
        })
        // Name the failure and lift the SQLite code (Decision 4), but do NOT
        // re-wrap errors that are already domain errors thrown from inside the
        // callback (Decision 4, error-passthrough) — those must reach callers
        // with their original `instanceof` intact.
        .catch((e) => {
          throw isDriverError(e)
            ? new WikiTransactionError('Transaction failed', { cause: e })
            : e;
        });

      // Advance the tail. The next caller's leading `.catch()` absorbs any
      // rejection, so a failed transaction never poisons the queue (see
      // Decision 3's error-isolation test).
      queue = run;
      return run;
    },
  };
}

// Reentrancy guard: same object, withTransactionAsync overridden to throw.
function guardReentrancy(tx: SQLiteAdapter): SQLiteAdapter {
  return {
    ...tx,
    withTransactionAsync() {
      throw new Error(
        'Nested withTransactionAsync is not supported: you are already ' +
        'inside a transaction. Pass the current `tx` down instead of ' +
        'opening a new transaction.'
      );
    },
  };
}
```

The queue holds a single promise chain; each resolved link is dropped as the
tail advances, so V8/JSC reclaims settled transactions over a long-running app.

> **Adapter contract.** The wrapper (and `guardReentrancy`) use prototype
> delegation (`Object.create(...)`), not object spread, so inherited methods and
> `this` binding are preserved — a class-instance adapter keeps its prototype
> methods through the wrap.
>
> **Expo `tx` aliasing.** `packages/expo/src/adapter.ts` passes the outer adapter
> object itself as the `tx` argument (it wraps `expo-sqlite`'s own
> `withTransactionAsync`, which supplies no per-tx handle). Core's re-wrap above
> (`guardReentrancy(tx)`) makes this safe: whatever the adapter hands back, the
> callback receives a handle whose `withTransactionAsync` throws.

```ts
// WikiMemory constructor
this.db = withSerializedTransactions(db);
```

Rationale:

- **Single chokepoint.** All 11 transaction call sites (services, repos, migrations)
  receive the wrapped adapter through the constructor — no per-call-site changes.
- **Fixes every adopter on every platform.** An app-level fix (e.g. dropping sync
  concurrency to 1) would only fix one app; the race between two library entry points
  is the library's bug.
- **Non-transactional reads stay concurrent.** Only `withTransactionAsync` queues;
  `getAllAsync`/`getFirstAsync` outside transactions are untouched, so read latency
  is unaffected.
- Errors propagate to the original caller; the internal chain swallows them only to
  keep the queue alive (no unhandled-rejection noise, no head-of-line poisoning).

### 2. Reentrancy: nested `withTransactionAsync` throws a clear error

The `tx: SQLiteAdapter` passed to a transaction callback structurally includes
`withTransactionAsync`. Before this change, calling it inside a callback produced the
raw SQLite nested-`BEGIN` error; after this change it would deadlock against the
mutex — strictly worse. Therefore core re-wraps the `tx` handed to callbacks
(`guardReentrancy` in Decision 1) so its `withTransactionAsync` throws synchronously:

> The guard is injected by `withSerializedTransactions`, **not** assumed to be
> present on whatever `tx` the underlying adapter supplies. The expo adapter passes
> the *outer adapter itself* as `tx` (it has no per-transaction handle), so a guard
> that lived only in the adapter layer would be absent there; injecting it in core
> covers every adapter uniformly.

```text
Nested withTransactionAsync is not supported: you are already inside a
transaction. Pass the current `tx` down instead of opening a new transaction.
```

- Audit confirms no core code nests today; this is a guard for future core code and
  for adopters composing custom logic.
- **Residual hazard (documented, not solved):** code inside a callback that calls
  the *outer* wrapped `db.withTransactionAsync` (captured via closure/`this.db`)
  rather than `tx` will deadlock — the mutex cannot distinguish a nested caller from
  a concurrent one without AsyncLocalStorage, which React Native lacks. Mitigations,
  layered:
  1. **Reentrancy throw** covers the discoverable path (`tx`).
  2. **Runtime deadlock warning** (Decision 1): a queued call that waits >10s emits a
     loud `console.warn` naming the closure footgun — because an async deadlock freezes
     silently with no thrown error, this is the only signal an adopter gets at runtime.
     Fires **once per queued call** (the timer is cleared on lock acquisition, never
     rescheduled), so a genuine multi-hour wedge logs one line, not a flood — the
     signal is "something is wedged," and one line per stuck call carries it.
  3. **Docs** state the rule ("inside a transaction callback, only ever use the `tx`
     parameter").
  4. **Static enforcement.** For this patch, a strict code-review convention keeps core
     honest. A custom ESLint rule (`no-outer-db-in-tx-callback`) is authored as a
     fast-follow to enforce this programmatically in CI — human review will eventually
     miss a closure capture, and on React Native (no `AsyncLocalStorage`) that means a
     silent, never-thrown deadlock, the worst class of bug to debug. See Out of Scope.

### 3. Rollback guard: never let cleanup mask the original error

Adapters that implement BEGIN/COMMIT/ROLLBACK manually (the core test helper at
`packages/core/__tests__/helpers/sqliteAdapter.ts`, and any future Node adapter)
must guard rollback:

```ts
} catch (e) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Connection may have no active transaction (BEGIN itself failed, or SQLite
    // auto-rolled-back). Never mask the original error with a rollback error.
  }
  throw e;
}
```

For `expo-llm-wiki`, BEGIN/ROLLBACK live inside `expo-sqlite`'s own
`withTransactionAsync` and cannot be patched from the adapter. This is acceptable:
with core-level serialization (Decision 1), a failed `BEGIN` due to concurrency can
no longer occur, which removes the trigger for the misleading
`cannot rollback - no transaction is active` error in practice. The spec makes this
dependency explicit rather than pretending the adapter can fix it.

### 4. Wedge visibility: name transaction errors

Transaction failures currently surface as raw `Error: Error code 1: …` with no
indication of which wiki operation opened the transaction. Core wraps transaction
execution errors in a typed error carrying the original as `cause`:

```ts
export class WikiTransactionError extends Error {
  /** Best-effort SQLite code lifted from the driver error, e.g. 'SQLITE_BUSY'. */
  readonly sqliteErrorCode?: string;
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'WikiTransactionError';
    this.sqliteErrorCode = extractSqliteCode(options.cause);
  }
}

// Shared driver-error detection + code extraction. `isDriverError` gates whether
// the wrapper re-wraps (Decision 4 passthrough); `extractSqliteCode` populates
// `sqliteErrorCode`. Both are best-effort and driver-specific.
//
//   better-sqlite3: err.code === 'SQLITE_BUSY' (string, SQLITE_-prefixed)
//   expo-sqlite:    err.message starts with 'Error code N: …' (numeric)
function extractSqliteCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  // better-sqlite3 and node:sqlite expose a string `SQLITE_*` code.
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
  // expo-sqlite embeds a numeric code in the message.
  if (typeof message === 'string') {
    const m = /^Error code (\d+):/.exec(message);
    if (m) return `SQLITE_${m[1]}`;
  }
  return undefined;
}

export function isDriverError(err: unknown): boolean {
  return extractSqliteCode(err) !== undefined;
}
```

`isDriverError` is defined as "a SQLite code could be extracted." This deliberately
couples the two: an error the wrapper wraps is exactly an error it can attach a
`sqliteErrorCode` to. A driver error whose code we *cannot* parse (neither shape
matches) falls through to passthrough — it reaches the caller unwrapped rather than
being wrapped with an empty `sqliteErrorCode`. Acceptable: the only errors that must be
wrapped for observability are the ones we can classify anyway.

- Thrown by the serialized wrapper **only when the rejection is a driver error**
  (nested-`BEGIN`, `SQLITE_BUSY`, constraint violation — anything raised by the SQLite
  layer). Message includes nothing entity-specific (the wrapper has no context) but
  gives adopters a stable `instanceof` target, mirroring the existing `WikiBusyError`
  pattern already consumed by hosts.
- **Error passthrough for domain errors.** A callback runs arbitrary core logic that
  may throw its own typed errors (validation failures, `WikiBusyError`, etc.). The
  wrapper must **not** re-wrap those — they reach the caller with their original
  `instanceof` intact, or existing suites that catch them break. Discrimination is via
  `isDriverError(e)`: true only when `e` carries a SQLite code (`cause.code` on
  better-sqlite3, an `Error code N` prefix on expo-sqlite). Everything else rethrows
  untouched. This is what keeps "existing suites pass unchanged" true.
- **Error code lifted to the top level.** The constructor extracts the SQLite code
  from the driver error (`cause.code` on better-sqlite3, the parsed `Error code N`
  prefix on expo-sqlite) and exposes it as `sqliteErrorCode` when present. This lets
  observability pipelines (Sentry/Datadog) group by `SQLITE_BUSY` vs. a constraint
  violation without brittle recursive `error.cause` inspection. Extraction is
  driver-specific and best-effort — absent when the code can't be determined.
- Callers with context (e.g. `setOntologyManifest`) keep their existing
  message-enrichment behavior; the `cause` chain now bottoms out at the driver error
  instead of a rollback red herring.

### 5. Docs ship with the code change

Documentation lands in the same commit as the fix — not as a lagging follow-up.

**a. README Concurrency section** (both `core-llm-wiki` and `expo-llm-wiki`):

- "All write APIs are safe to call from concurrent async contexts; transactions are
  serialized internally on the single database connection."
- "Inside a transaction callback, only use the provided `tx` — never the outer
  database handle."
- One connection per database file per process remains the supported topology
  (unchanged; now stated).

This is an adoption selling point, not just documentation of a fix.

**b. `WikiTransactionError` in the error-handling docs.** Document alongside the
existing `WikiBusyError`: the stable `instanceof` target, the `cause` chain (bottoms
out at the driver error), and the best-effort `sqliteErrorCode`. Adopters wiring
Sentry/Datadog need this to know what to catch and group on.

**c. JSDoc on `withTransactionAsync`.** The reentrancy rule ("use the `tx` parameter,
never the outer database handle") goes on the method signature, not just in prose — so
it surfaces on editor hover, at the exact call site where the closure footgun (Decision
2) is written.

### 6. Adapter follow-up (out of this patch): `withExclusiveTransactionAsync`

`expo-sqlite` offers `withExclusiveTransactionAsync`, which runs the transaction on
an isolated connection and would additionally protect against non-wiki writes on the
shared handle interleaving with wiki transactions. Deliberately **not** in this
patch:

- Behavior on `expo-sqlite` web (wa-sqlite/OPFS) needs verification first.
- It changes isolation semantics (separate connection = separate snapshot), which
  needs its own test pass.

Tracked as a follow-up investigation; Decision 1 alone closes the production defect.

---

## Test Plan

New suite `packages/core/__tests__/transactionSerialization.test.ts`:

1. **Concurrent-writes regression (the production repro).**
   `Promise.all` of overlapping `importDump`, `setOntologyManifest`, and `write`
   calls against one `WikiMemory` over the better-sqlite3 test adapter. Without
   Decision 1 this reproduces `cannot start a transaction within a transaction`
   (better-sqlite3 raises the same SQLite error 1); with it, all resolve and
   post-conditions hold (manifest persisted, dump imported, entry written).
2. **Serialization order.** Instrumented adapter asserts no `BEGIN` is issued while
   another transaction is open (depth counter never exceeds 1).
3. **Error isolation / poison pill.** `Promise.all([A, B, C])` enqueued together, where
   `B` throws a fatal **driver** error mid-callback. Assert: `A` commits, `B` rejects
   with `WikiTransactionError` (original error as `cause`, `sqliteErrorCode` populated
   when the driver supplies one), and `C` still executes and commits. Proves a rejection
   neither stalls the queue nor bleeds into a sibling.
3b. **Domain-error passthrough.** A callback throws a non-driver error (e.g. a plain
   `Error` or a `WikiBusyError`). Assert the caller receives it **unwrapped** — same
   `instanceof`, not a `WikiTransactionError` — and the queue still advances for the
   next caller. Guards the `isDriverError` discrimination (Decision 4).
4. **Reentrancy guard.** Calling `tx.withTransactionAsync` inside a callback throws
   the descriptive error synchronously; outer transaction still rolls back cleanly.
5. **Rollback guard.** Test-helper adapter: force `BEGIN` to fail; assert the surfaced
   error is the `BEGIN` failure, not `cannot rollback - no transaction is active`.
6. **Reads unaffected (interleaving).** Open a transaction whose callback holds open
   via a `setTimeout`-gated promise; concurrently fire a `getAllAsync` outside any
   transaction. Assert the read resolves **before** the transaction settles — proving
   the wrapper serializes `withTransactionAsync` only and has not accidentally queued
   non-transactional reads. Keep the `setTimeout` gate comfortably long (e.g. ≥50ms)
   so the ordering assertion can't flake on a slow CI box with the synchronous
   better-sqlite3 driver.

Existing suites (`WikiMemory.test.ts`, `write.test.ts`, `ingest.test.ts`,
`okfStorageConformance.test.ts`, integration package) must pass unchanged — the
wrapper is behavior-preserving for sequential callers.

---

## Release

- Commit `fix(core): serialize transactions on the shared connection` → semantic-release
  cuts a patch on `core-llm-wiki`; `expo-llm-wiki` picks it up via dependency bump (test
  helper + README changes ride along). Changelog and version bumps are auto-generated by
  semantic-release — not hand-edited.
- Put the production symptom strings (`cannot start a transaction within a transaction`,
  `cannot rollback - no transaction is active`) in the commit body so they land in the
  generated changelog and adopters searching the error message find the fix.

---

## Out of Scope

**Fast-follow to this patch:**

- Custom ESLint rule `no-outer-db-in-tx-callback` enforcing transaction closure safety
  (Decision 2) — flags references to `this.db` / the captured outer adapter inside a
  `withTransactionAsync` callback. Tracked as a fast-follow chore; ships with the
  convention + runtime warning in the meantime.

**Handled in host-app specs (not these packages):**

- Host-app fire-and-forget ontology bootstrap races in orchestration code
  (logical race independent of this fix).
- Shared Vertex AI text-generation helper (empty-response retry, `finishReason`
  logging) for `summarizeText` / `wikiLlm` / heal functions.
- `thinkingBudget` increases for wiki heal and librarian model calls.
- `wikiLlm` degenerate `responseSchema: {type: OBJECT}`.
