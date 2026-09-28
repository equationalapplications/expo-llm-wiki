# MaintenanceService incremental search index syncs: Design

**Date:** 2026-09-28
**Status:** Draft — revision 1
**Branch:** `perf/core-maintenance-incremental-sync-235`
**Source baseline:** `61f7700` (core 7.7.6)
**Issue:** #235
**Delivery:** one PR on this branch, per the #232 pattern: the spec is committed first (`docs(core)`), then the code. Merged as a merge commit, never squash.

## 1. Decision and scope

#233 converted `importDump` and `ingestDocument` to `SearchService.syncEntries`. The six `MaintenanceService` `sync(entityId)` call sites still pay O(entity) per call. This spec converts four of them to `syncEntries(entityId, ids)`:

- `forget` (:538)
- `runPrune` (:278, :308)
- `doRunLibrarian` (:772)
- `doRunHeal` (:854, :1093)

The remaining `sync()` callers — `WikiMemory.setup()`'s global `sync()` (`WikiMemory.ts:287`) — stay unchanged: setup and recovery are exactly what full rebuild is for.

**Correction to the issue's analysis (verified against `61f7700`).** The issue frames librarian and heal as "the genuinely blocked" callers that need repository calls threaded to return touched ids first. That is wrong on both counts:

1. `EntryRepository.markOrphaned` and `downgradeStaleInferred` **already return `string[]`** via `RETURNING id` / a select-then-update pair (`EntryRepository.ts:808-832`, `842-865`), added for `HealResult` counting (lines 823-827 of `MaintenanceService`). The ids the issue says heal cannot surface are already surfaced.
2. `doRunLibrarian` already collects `insertedFacts` (`:671`, `:742`) — it inserts only fresh-id rows, so inserts are the complete mutation set. Nothing is blocked.

The only repository change the issue correctly identifies is real, and it is smaller than claimed: `softDeleteBySource` (`EntryRepository.ts:520`) returns a change count, and `forget`'s by-source branch uses it. But the change is **unnecessary**: `forget` already collects those ids at `:511` — `findIdsBySource(entityId, sourceRef, sourceHash, tx, true)` (`includeDeleted=true`) runs inside the same transaction with the same predicate, so it enumerates exactly the rows `softDeleteBySource` soft-deletes. This is the same select-before-delete pattern #233 used for `ingestDocument`, and it is race-free here: `forget` holds the `forget` job lock and runs inside `withTransactionAsync`, and `withSerializedTransactions` orders it against any concurrent writer.

So: **no repository signature changes at all.** The conversion is service-layer only, which keeps the code commit free of public-signature churn (the `softDeleteBySource` return type appears in `packages/core/dist` typings).

`softDeleteBySource` is left untouched; its other caller (`IngestionService.ts:713`, inside `upsertGraphCore`) uses `findIdsBySource` separately and needs nothing.

## 2. Per-caller conversions

### 2.1 `forget` (:538) [REQ-235-FORGET]

Move `const uniqueDeletedIds = Array.from(new Set(deletedEntryIds))` from `:540` to just before the sync, and replace `:538` with:

```ts
await this.searchService.syncEntries(entityId, uniqueDeletedIds);
```

The `clearAll` branch already collects ids at `:477` (`findIdsBySource(entityId, null, null, tx, true)`). A `forget` that deletes nothing produces an empty id list; per #233 spec §4.1 (r4), `syncEntries` with empty ids on a tracked, non-stale entity still awaits the chain and makes no repository call — strictly less work than today's full rebuild, same serialization guarantee.

Everything after the sync (the ANN cleanup hook loop, `:541-555`) is unchanged.

### 2.2 `runPrune` (:278, :308) [REQ-235-PRUNE]

Both paths convert to `syncEntries(entityId, succeededIds)`:

- `:278` (partial-failure path): `succeededIds` is in scope (`:268`).
- `:308` (success path): declare `let syncedIds: string[] = []` at the top of `runPrune`, assign `succeededIds` inside the `retainSoftDeletedFor` block, sync at `:308`. When `retainSoftDeletedFor === null`, the list is empty and `syncEntries` is a cheap no-op on the chain — correct, because nothing was pruned from entries (only tasks/events, which are not indexed).

The issue is right that prune's sync is drift repair, not the primary delete mechanism: `getPrunableMetadata` selects `deleted_at IS NOT NULL` rows (`EntryRepository.ts:573-584`) and `findMiniSearchRows` filters `deleted_at IS NULL` (`:116`), so every pruned row was already absent from the index. `syncEntries(entityId, succeededIds)` preserves the property: a stale document for an id that some earlier path soft-deleted without an index update is dropped when prune finally hard-deletes it, because `syncEntries` discards every passed id from the tracked set and re-adds only what the live read returns. What prune **stops** repairing is drift on ids it does not touch — that residual is accepted and is covered by §5's note.

### 2.3 `doRunLibrarian` (:772) [REQ-235-LIBRARIAN]

Replace with:

```ts
await this.searchService.syncEntries(entityId, insertedFacts.map((f) => f.id));
```

`insertedFacts` collects exactly the rows the transaction wrote (`:742`); every insert uses a fresh `generateId('fact_')` and there are no updates or deletes anywhere in the librarian transaction (verified: `:697-767`). Tasks and edges are not indexed.

### 2.4 `doRunHeal` (:854, :1093) [REQ-235-HEAL]

Touched-id set, assembled before each sync:

```ts
const healSyncIds = Array.from(new Set([
  ...orphanedIds,          // soft-deleted by markOrphaned (RETURNING id)
  ...staleDowngradedIds,   // confidence downgraded by downgradeStaleInferred
  ...safeDowngraded,       // downgraded by the model, mutable-ids-guarded
  ...uniqueDeletedFactIds, // soft-deleted by softDeleteByIds (deduped from safeDeleted)
  ...insertedFacts.map((f) => f.id), // fresh-id inserts
]));
```

- `:854` (empty-candidate early return): `syncEntries(entityId, healSyncIds)` — `orphanedIds`/`staleDowngradedIds` may be non-empty even with zero candidates (the comment at `:851-853` documents exactly this), so the early return still re-indexes everything the SQL passes touched.
- `:1093` (main return): the same list, now including batch-derived ids.

**Why this is complete — the issue's orphan/stale-drift concern, resolved.** The issue warns that heal's "orphan/stale SQL can mutate rows the candidate list does not enumerate" and that narrowing to candidate ids would under-index. Verified: the only un-enumerated mutation fear is unfounded. `markOrphaned` returns every row it updates (`RETURNING id`), `downgradeStaleInferred` returns the same rows it updates (select-then-update with identical predicates, `:849-865`), and the batch passes are enumerated by `outcome.results` with the mutable-ids guard (`:962-965`). There is no other `entries` write in `doRunHeal`.

Residual accepted: a row whose *index document content* changed only because of a column `syncEntries` reads that heal did not touch does not exist — `findMiniSearchRowsByIds` reads `id, entity_id, title, body, tags`; heal's non-enumerated mutations (there are none) would have been the only risk. Note `downgradeStaleInferred`/`downgradeByIds` change `confidence`, which is not indexed — those ids are included anyway (cheap, and keeps the invariant "pass every id the pass touched" mechanical rather than reasoned).

### 2.5 Unchanged

`WikiMemory.setup()`'s global `sync()`, `ImportExportService`/`IngestionService` (already on `syncEntries` since #233), `softDeleteBySource`, `clearVectorCache`, `markStale`, the epoch contract (#233 spec §5/r6). None of these paths run inside a host-owned transaction core cannot see, so the #233 epoch caveat does not apply.

## 3. Behavioral parity

No index-content change is intended. For every converted call site, the post-call index equals what `sync(entityId)` produced before, because `syncEntries`'s full-rebuild fallback (untracked or stale entity) is byte-identical to `sync(entityId)` (#233 spec §4.2 step 1), and the incremental path converges to the live rows in SQLite by construction.

Two intentional differences, both already pinned by #233's `SearchService` tests:

1. Vacuum happens only when a turn discards something (add-only turns never vacuum).
2. Equal-score tie order is `id`-sorted, not insertion-order — unaffected by *which* caller invokes `syncEntries`.

## 4. Tests [REQ-235-TEST]

`packages/core/__tests__/services/MaintenanceService.test.ts` — the mock at `:63` and `:207` gains `syncEntries: vi.fn().mockResolvedValue(undefined)`; add assertions per path:

1. **forget**: `syncEntries` receives the entity and exactly the deleted ids (entryId case; sourceRef case; clearAll case; the no-op case asserts `sync` is *not* called and `syncEntries` gets `[]`).
2. **runPrune success**: `syncEntries` receives the pruned ids; `findMiniSearchRows` (the full-rebuild read) is not called.
3. **runPrune partial failure**: the `PrunePartialFailureError` still throws *after* `syncEntries` ran with the succeeded ids.
4. **librarian**: `syncEntries` receives the inserted fact ids.
5. **heal empty-candidate early return**: with only orphan-pass deletions, `syncEntries` receives the orphaned ids (this is the `:851-853` contract, now pinned).
6. **heal full path**: `syncEntries` receives the union of orphaned + stale-downgraded + model-downgraded + model-deleted + inserted ids.

`packages/core/__tests__/incrementalSearchIndex.test.ts` (real SQLite) — chunk-size-independence coverage in the spirit of the #233 acceptance tests:

7. Seed 1000 facts, run `forget({ clearAll: true })`: the number of rows read back for indexing is bounded by the deleted set, and search returns nothing for the entity afterwards.
8. Seed 1000 facts, soft-delete 50 out-of-band (raw SQL, mimicking a pre-#233 path that skipped index updates), then `runPrune`: the 50 stale documents leave the index (drift-repair property from §2.2), and the read count is O(50), not O(1000).

Existing `MaintenanceService` tests must pass unchanged apart from the mock addition; all #233 `SearchService` tests are untouched.

## 5. Delivery

1. `docs(core): spec MaintenanceService incremental index syncs (#235)` — this file.
2. `perf(core): index only the rows maintenance passes touch (#235)` — `MaintenanceService.ts` + tests. No public signature changes.
3. PR against `main`, merged as a **merge commit** (never squash). No `BREAKING CHANGE` footer; no body line may start with that phrase.
4. After merge: comment on #235 noting where the analysis differed (librarian/heal were not blocked; `softDeleteBySource` did not need to change), set the spec's Status to `Implemented`, close the issue.

Manual benchmark is not required for this PR: the four maintenance passes are user/CI-triggered operations, not import loops, so there is no quadratic-accumulation case to demonstrate. The §4 real-SQLite tests carry the O(touched) assertion instead.

## 6. Revision log

- **r1 (2026-09-28):** initial design, written after verifying all six call sites and the repository layer against `61f7700`. Diverges from the issue: no repository changes needed.
