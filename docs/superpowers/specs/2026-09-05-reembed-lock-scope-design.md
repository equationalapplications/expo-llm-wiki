# Reembed Lock Scope: Defer-While-Sweeping Promotion — Design

**Status:** Approved, not yet implemented (2026-09-05)

**Status (2026-09-05, self-review):** Corrected before implementation. §1.2
gained the per-entity-sweep confinement finding; §3.2's deferral-safety
argument was wrong as first written (the mismatch key is *not* set on every
path) and now argues both reachable states; §3.2 records why the gate has no
TOCTOU; §5 test 2 dropped an unreachable global-reembed variant. No decision
changed — §2's rule and §3's changes stand as approved.

**Status (2026-09-05):** Implemented. §3.1 `isAnyReembedActive`, §3.2 importDump
gate, §3.3 auto-heal exclusion, §3.4 docstrings all landed with tests in
`__tests__/jobs.test.ts` and `__tests__/reembedLockScope.test.ts`.

**Status (2026-09-05, post-implementation review):** Corrected docs, no code
change. §2's "the promotion deterministically completes at the next sweep
tail" overstates liveness: the tail is conditional — `runReembed` calls
`reconcileEmbeddingDimension` only `if (embedded > 0)`, so a sweep that
embeds nothing (all rows skipped/deferred/permanently-failed) runs no tail
reconciliation. The accurate promise: a deferred promotion completes at a
later importDump reconciliation or at the next *productive* sweep tail (one
that embeds > 0 rows). The pending state is harmless — it is exactly the
pre-import state — and the sticky mismatch key preserves promotion intent
through any number of unproductive sweeps. §2's original text stands as the
approved record; importDump's gate comment now states the condition.

**Issue addressed:** #134 (marker clear during dimension promotion is not
transactional with a concurrent sweep)

**Extends:** `2026-09-04-marker-lifecycle-and-scopelab-hygiene-design.md`
(spec §2 — marker lifecycle), whose §2 shipped the promotion-clears-markers
behavior this spec now makes concurrency-safe, and
`2026-09-04-embedding-failure-and-scope-hygiene-design.md`, which shipped the
marker system itself.

---

## 1. Problem and scope decision

Issue #134 (filed from the #133 review) describes two concurrency gaps:

1. A row classified `permanent` by `runReembed`'s per-row loop has its
   markers cleared mid-sweep by a concurrent `upsert`/`upsertForImport`
   carrying a valid blob; the next sweep re-embeds a row the previous sweep
   had excluded. Bounded cost: one extra embed attempt.
2. A concurrent `importDump` triggers dimension promotion
   (`reconcileEmbeddingDimension`) while a separate `runReembed` sweep is in
   flight against the same DB.

The issue framed both as open lock-granularity questions ("row-level?
whole-DB? per-entity against reembed only?") requiring a spec-level decision.
This spec records that decision.

### 1.1 Concurrency model (constraint agreed 2026-09-05)

The `JobManager` is an in-process, in-memory lock table constructed per
`WikiMemory` instance (`WikiMemory.ts:112`). Its existence as the sole
serialization point dictates the contract: **one `WikiMemory` instance per
database**. Cross-instance or multi-JS-context access to one SQLite file is
out of scope — no in-memory lock can enforce anything there, and the design
does not try. If that requirement ever arises, it needs SQLite-level
guarantees, not wider `JobManager` keys.

The correctness bar is **bounded redundant work**, matching the issue's own
framing: a mid-sweep clear may cost one redundant embed attempt, but no
interleaving may lose data, strand rows, or un-bound the work.

### 1.2 Investigation finding: the issue's gap 1 is already closed; gap 2 is one granularity mismatch

Verification against the code (2026-09-05) materially narrows the issue:

- **Same-row upsert during a sweep cannot happen in the single-instance
  model.** Every marker-mutating write path checks reembed activity at lock
  acquisition: `ingest` blocks on `_isReembedActive(entityId)`
  (`JobManager.ts:243`), and `acquireImportLocks` checks every imported
  entity (`JobManager.ts:415`). `_isReembedActive` covers both the
  per-entity and the global reembed key (`JobManager.ts:115-118`). Since a
  sweep holds its lock for the whole loop
  (`MaintenanceService.ts:367`), an `upsert`/`upsertForImport` carrying a
  blob for a row in the swept entity cannot start mid-sweep. Gap 1's
  upsert-for-same-entity scenario is reachable only via gap 2's escape hatch
  (below) or by violating the single-instance contract.
- **The one mutation that escapes those checks is global while its locks are
  entity-scoped.** `reconcileEmbeddingDimension` calls
  `clearEmbeddingFailureMarkers` with no entity filter
  (`EntryRepository.ts:962-970`), wiping markers for **all** entities inside
  the promotion transaction (`EmbeddingService.ts:74-78`). Both of its
  callers can hold entity-scoped locks only: `runReembed(entityId)` holds
  `reembed:<A>`, and `importDump` of entity B passes
  `acquireImportLocks([B])` while a sweep on entity A is in flight. The
  promotion then erases A's rows — including classifications the in-flight
  sweep just made. **Both issue gaps collapse into this one granularity
  mismatch.**
- **The defect is confined to per-entity sweeps.** `_isReembedActive` returns
  true for the *global* reembed key regardless of entity
  (`JobManager.ts:115-118`), so `acquireImportLocks` already throws
  `WikiBusyError` for any import attempted during a `runReembed()` with no
  entityId. Only `runReembed(entityId)` — which holds solely `reembed:<A>` —
  leaves the window open, and only for an import of some entity B ≠ A. This
  boundary matters for testing: an importDump-level test of the global
  variant cannot reach the promotion call site at all (§5).
- **Latent hole (not in the issue):** `tryAcquireAutoHealLock`
  (`JobManager.ts:359-365`) checks only the heal self-key, so an auto-heal
  pass can run during a sweep. It is benign today only because heal upserts
  exclusively blob-less new facts and the marker-clear in `upsert`/
  `upsertForImport` is guarded by
  `CASE WHEN excluded.embedding_blob IS NOT NULL`
  (`EntryRepository.ts:222-224, 382-384`). A future edit that lets heal
  carry blobs would silently reopen gap 1. §4.3 makes the exclusion
  structural instead of accidental.

---

## 2. Decision: the lock-scope rule

The rule this spec records (also to be stated in `runReembed`'s docstring):

> **A marker mutation is legal while a reembed sweep is in flight if and
> only if it cannot resurrect a row that sweep has classified.**
>
> - Mutation scoped to entities *not* under an active sweep key: legal
>   (existing entity-scoped `ingest`/`import` lock checks enforce this).
> - The one global mutation (`reconcileEmbeddingDimension`'s
>   promotion-transaction marker clear): legal only by **deferring** —
>   never by widening a lock.

Deferral works because `embedding_dimension_mismatch` is sticky: skipping
the promotion leaves the key set, and the promotion deterministically
completes at the next sweep tail (`runReembed` calls
`reconcileEmbeddingDimension` after its loop, `MaintenanceService.ts:424-426`)
or the next importDump reconciliation. No state is lost by waiting; a
promotion that lands one sweep later has identical semantics to one that
lands mid-sweep, minus the resurrected-row race.

Approaches considered and rejected:

- **Global mutual exclusion** (import/ingest block on *any* active reembed):
  trivially correct, but importDump of entity B would throw `WikiBusyError`
  because a network-bound sweep on entity A is running — user-visible
  failures for zero added safety, since same-row mutation is already blocked.
- **Per-row freshness re-check** (sweep re-reads markers before each embed):
  tolerates multi-instance, but adds a SELECT per attempted row, leaves the
  `embedding_dimension` metadata flip racing the sweep, and sidesteps the
  lock-scope question rather than deciding it. Reconsider only if the
  single-instance constraint is ever lifted.

---

## 3. Changes

### 3.1 `JobManager.isAnyReembedActive(): boolean`

New public, read-only query: true when the global reembed key is held **or**
any `<prefix>:<entity>:reembed` key is held. Implementation is a thin public
wrapper over the existing `_isAnyMaintenanceActiveWithSuffix(':reembed')`
(`JobManager.ts:129-135`) plus the global-key check — the same predicate
`global_reembed` acquisition already uses (`JobManager.ts:210`). No new lock
types, no lock widening, no side effects. `JobManager` is not re-exported
from `packages/core/src/index.ts`, so the new method adds no public API
surface and `publicExports.test.ts` needs no update.

### 3.2 Gate the `importDump` promotion call site

`ImportExportService.ts:524`: before calling
`this.embeddingService.reconcileEmbeddingDimension()`, check
`this.jobManager.isAnyReembedActive()`. If true, skip the call and log at
info level: `[WikiMemory] importDump: embedding-dimension promotion
deferred; a reembed sweep is in flight`.

Deferring is safe in both of the states reachable at that line, for two
different reasons. Where `embedding_dimension_mismatch` is set, the key is
sticky and the promotion fires at the next sweep tail or import. Where it is
*not* set — the `canonicalDim === null` fresh-DB branch, in which
`storeEmbeddingDimension` writes the canonical dimension and the
`staleMismatchValue` guard writes nothing — `reconcileEmbeddingDimension`
returns immediately at its own `if (!mismatchValue) return;`
(`EmbeddingService.ts:61-62`). Skipping it there defers a no-op. Nothing is
lost in either case.

**The gate is free of a TOCTOU of its own, non-obviously.** Line 524 executes
inside `doImportEntity`, within the `try` block that holds the global import
key (`ImportExportService.ts:65-72`), and `acquireLock` rejects every
operation except `global_import` while that key is held
(`JobManager.ts:168-170`). No sweep can therefore start between the
`isAnyReembedActive()` check and the promotion transaction. Do not add
re-checking or locking here on suspicion of a race; there is none while that
invariant holds.

The gate lives at the call site, not inside `reconcileEmbeddingDimension`:
the sweep's own tail call would see its *own* lock and defer forever unless a
reentrancy flag were threaded through, and the two existing call sites are
the complete caller set. `EmbeddingService` keeps no `JobManager` reference —
no constructor churn, no wiring reorder in `WikiMemory.ts`. The contract is
documented on `reconcileEmbeddingDimension`'s docstring instead:

> Callers must not invoke while a reembed sweep is in flight unless they hold
> that sweep's lock. External callers gate on `JobManager.isAnyReembedActive()`
> and defer; `runReembed`'s tail call is exempt (it holds the sweep lock).

### 3.3 `tryAcquireAutoHealLock` refuses during sweeps

`JobManager.ts:359-365`: return false when `isAnyReembedActive()` is true.
Effect: auto-heal passes started from `write()` skip while a sweep runs and
retry on a later write — the existing checkpoint-holdback semantics
(`WriteService.maybeRunHeal`) already make a skipped pass safe. This converts
heal's current accidental safety (§1.2, latent hole) into a stated invariant.

### 3.4 Documentation

- `runReembed`'s docstring ("Residual, by design" paragraph,
  `MaintenanceService.ts:341-353`) gains the §2 lock-scope rule.
- `reconcileEmbeddingDimension`'s docstring gains the caller contract (§3.2).

---

## 4. Error handling and observability

Deferral is not an error. No `WikiBusyError` is thrown by any change in this
spec; no public return shape changes (`importDump`'s result and
`reconcileEmbeddingDimension`'s `void` are unchanged). The deferral is
observable via the info-level log and via `embedding_dimension_mismatch`
remaining set. Callers cannot distinguish "promoted" from "deferred" in
return values — deliberate; promotion is eventual and polling it would add
API surface for no action a caller could take.

---

## 5. Testing

Unit tests (vitest, `packages/core`):

1. `isAnyReembedActive()` — false when idle; true for per-entity reembed
   key; true for global reembed key; false again after release; true when
   only a non-reembed maintenance key (e.g. prune) is held.
2. importDump promotion deferral — hold a **per-entity** reembed lock for
   entity A, then importDump entity B: the reconciliation leaves
   `embedding_dimension_mismatch` set and leaves A's pre-existing failure
   markers intact; after the lock is released and a sweep tail runs, the
   promotion completes and markers clear.

   Do **not** write the global-reembed variant of this test at the importDump
   level: `acquireImportLocks` throws `WikiBusyError` before the promotion
   call site is reached (§1.2), so such a test would assert on an unreachable
   path. Cover the global key through test 1 instead, which exercises
   `isAnyReembedActive()` directly.
3. Sweep tail promotion unaffected — `runReembed` holding its own lock still
   promotes in the same call (guards against the §3.2 gate ever migrating
   into `reconcileEmbeddingDimension` and self-deadlocking).
4. Auto-heal — `tryAcquireAutoHealLock` returns false while any reembed is
   active, true after release; an existing write→auto-heal flow still
   converges once the sweep ends.

---

## 6. Out of scope

- Multi-instance / multi-JS-context concurrency (§1.1).
- Per-row freshness re-checks (§2, rejected approach).
- Same-dimension provider swap leaving markers stranded — documented
  residual of spec §2, still escaped via `runReembed({ force: true })`.
- Any change to `storeEmbeddingDimension`'s mismatch bookkeeping
  (`EmbeddingService.ts:27-42`); the metadata writes it performs during a
  sweep are per-dimension values, not marker mutations, and are outside the
  §2 rule.

---

## 7. Implementation shape

Single PR against `packages/core`: §3.1 + §3.2 + §3.3 + §3.4 land together
(the rule, its enforcement, and its documentation are one atomic decision);
§5's tests in the same PR. Closes #134 on merge. Commit message must keep
any breaking-change wording out of line-start position (repo convention).
