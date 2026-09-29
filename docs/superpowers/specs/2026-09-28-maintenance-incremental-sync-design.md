# MaintenanceService incremental search index syncs: Design

**Date:** 2026-09-28
**Status:** Implemented (r2)
**Branch:** `perf/core-maintenance-incremental-sync-235`
**Source baseline:** `61f7700` (verified against the tree issue #235 cites; line numbers below are deliberately avoided — see §1)
**PR:** #236

**Delivery:** one PR on this branch, per the #232 pattern: the spec is committed first (`docs(core)`), then the code. Merged as a merge commit, never squash.

## 1. Decision and scope

#233 converted `importDump` and `ingestDocument` to `SearchService.syncEntries`. The six `MaintenanceService` `sync(entityId)` call sites still pay O(entity) per call. This spec converts all six — they sit in four methods:

- `forget` (the sync after the delete transaction)
- `runPrune` (the partial-failure path and the success path)
- `doRunLibrarian` (the sync after `diagBuffer.flush`)
- `doRunHeal` (the empty-candidate early return and the main return)

The other `sync()` caller, `WikiMemory.setup()`'s global `sync()` (a different method, not one of the six), stays unchanged: setup and recovery are exactly what full rebuild is for.

**Correction to the issue's analysis (verified against `61f7700`).** The issue frames librarian and heal as "the genuinely blocked" callers that need repository calls threaded to return touched ids first. That is wrong on both counts:

1. `EntryRepository.markOrphaned` and `downgradeStaleInferred` **already return `string[]`** via `RETURNING id` / a select-then-update pair, added for `HealResult` counting in `doRunHeal`. The ids the issue says heal cannot surface are already surfaced.
2. `doRunLibrarian` already collects `insertedFacts` — it inserts only fresh-id rows, so inserts are the complete mutation set. Nothing is blocked.

The only repository change the issue correctly identifies is real, and it is smaller than claimed: `softDeleteBySource` returns a change count, and `forget`'s by-source branch uses it. But the change is **unnecessary**: `forget` already collects those ids — `findIdsBySource(entityId, sourceRef, sourceHash, tx, /* includeDeleted */ true)` runs inside the same transaction with the same predicate, so it enumerates exactly the rows `softDeleteBySource` soft-deletes. This is the same select-before-delete pattern #233 used for `ingestDocument`, and it is race-free here: `forget` holds the `forget` job lock and runs inside `withTransactionAsync`, and `withSerializedTransactions` orders it against any concurrent writer.

So: **no repository signature changes at all.** The conversion is service-layer only, which keeps the code commit free of public-signature churn (the `softDeleteBySource` return type appears in `packages/core/dist` typings).

`softDeleteBySource` is left untouched; its other caller (`IngestionService.upsertGraphCore`) uses `findIdsBySource` separately and needs nothing.

## 2. Per-caller conversions

### 2.1 `forget` [REQ-235-FORGET]

Move `const uniqueDeletedIds = Array.from(new Set(deletedEntryIds))` to just before the sync, and replace the sync with:

```ts
await this.searchService.syncEntries(entityId, uniqueDeletedIds);
```

Every branch that soft-deletes entries also enumerates the ids into `deletedEntryIds` inside the same transaction: the entryId branch, the by-source branch (see §1), and the `clearAll` branch (`findIdsBySource(entityId, null, null, tx, true)`). A `forget` that deletes nothing produces an empty id list; per #233 spec §4.1 (r4), `syncEntries` with empty ids on a tracked, non-stale entity still awaits the chain and makes no repository call — strictly less work than today's full rebuild, same serialization guarantee.

Everything after the sync (the ANN cleanup hook loop over `uniqueDeletedIds`) is unchanged.

**Accepted worst case (Opus review, r2):** the `clearAll` id list includes every row the entity *ever* soft-deleted (`includeDeleted=true`), not just rows deleted by this call, so `syncEntries` runs ⌈N/500⌉ `IN (...)` chunk queries that return empty for ids already absent from the live read. For entities with a long soft-delete history this can exceed the single full-rebuild read the old `sync()` paid. It is kept because (a) it stays correct in all cases — the fallback covers untracked/stale entities — and (b) the same id list already drives the per-id ANN hook loop immediately after, so the token cost was already being paid; only the empty index reads are new, and they are bounded and index-only. Not worth the complexity of intersecting with the pre-delete live set.

### 2.2 `runPrune` [REQ-235-PRUNE]

Both paths convert to `syncEntries(entityId, succeededIds)`:

- partial-failure path: `succeededIds` is in scope.
- success path: declare `let syncedIds: string[] = []` at the top of `runPrune`, assign `succeededIds` inside the `retainSoftDeletedFor` block, sync at the end. When `retainSoftDeletedFor === null`, the list is empty and `syncEntries` is a cheap no-op on the chain — correct, because nothing was pruned from entries (only tasks/events, which are not indexed).

The issue is right that prune's sync is drift repair, not the primary delete mechanism: `getPrunableMetadata` selects `deleted_at IS NOT NULL` rows and `findMiniSearchRows` filters `deleted_at IS NULL`, so every pruned row was already absent from the index. `syncEntries(entityId, succeededIds)` preserves the property: a stale document for an id that some earlier path soft-deleted without an index update is dropped when prune finally hard-deletes it, because `syncEntries` discards every passed id from the tracked set and re-adds only what the live read returns. What prune **stops** repairing is drift on ids it does not touch — that residual is accepted and is covered by §5's note.

### 2.3 `doRunLibrarian` [REQ-235-LIBRARIAN]

Replace with:

```ts
await this.searchService.syncEntries(entityId, insertedFacts.map((f) => f.id));
```

`insertedFacts` collects exactly the rows the transaction wrote; every insert uses a fresh `generateId('fact_')` and there are no updates or deletes anywhere in the librarian transaction (verified across the full transaction body). Tasks and edges are not indexed.

### 2.4 `doRunHeal` [REQ-235-HEAL]

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

- Empty-candidate early return: `syncEntries(entityId, healSyncIds)` — `orphanedIds`/`staleDowngradedIds` may be non-empty even with zero candidates (the in-code comment documents exactly this), so the early return still re-indexes everything the SQL passes touched.
- Main return: the same list, now including batch-derived ids.

**Why this is complete — the issue's orphan/stale-drift concern, resolved.** The issue warns that heal's "orphan/stale SQL can mutate rows the candidate list does not enumerate" and that narrowing to candidate ids would under-index. Verified: the only un-enumerated mutation fear is unfounded. `markOrphaned` returns every row it updates (`RETURNING id`), `downgradeStaleInferred` returns the same rows it updates (select-then-update with identical predicates), and the batch passes are enumerated by `outcome.results` with the mutable-ids guard. There is no other `entries` write in `doRunHeal`.

Residual accepted: a row whose *index document content* changed only because of a column `syncEntries` reads that heal did not touch does not exist — `findMiniSearchRowsByIds` reads `id, entity_id, title, body, tags`; heal's non-enumerated mutations (there are none) would have been the only risk. Note `downgradeStaleInferred`/`downgradeByIds` change `confidence`, which is not indexed — those ids are included anyway (cheap, and keeps the invariant "pass every id the pass touched" mechanical rather than reasoned).

### 2.5 Unchanged

`WikiMemory.setup()`'s global `sync()`, `ImportExportService`/`IngestionService` (already on `syncEntries` since #233), `softDeleteBySource`, `clearVectorCache`, `markStale`, the epoch contract (#233 spec §5/r6). None of these paths run inside a host-owned transaction core cannot see, so the #233 epoch caveat does not apply.

## 3. Behavioral parity

No index-content change is intended. For every converted call site, the post-call index equals what `sync(entityId)` produced before, because `syncEntries`'s full-rebuild fallback (untracked or stale entity) is byte-identical to `sync(entityId)` (#233 spec §4.2 step 1), and the incremental path converges to the live rows in SQLite by construction.

Two intentional differences, both already pinned by #233's `SearchService` tests:

1. Vacuum happens only when a turn discards something (add-only turns never vacuum).
2. Equal-score tie order is `id`-sorted, not insertion-order — unaffected by *which* caller invokes `syncEntries`.

## 4. Tests [REQ-235-TEST — delivered in `packages/core/__tests__/maintenanceIncrementalSync.test.ts` (real SQLite, chunk-size-independent)]

1. **forget by entryId**: O(deleted) reads, zero full-entity reads; the forgotten fact leaves the index, the rest of the entity stays searchable.
2. **runPrune success**: O(touched) reads, zero full reads; both pruned documents leave the index.
3. **runPrune partial failure**: `PrunePartialFailureError` still throws after `syncEntries` ran with the succeeded ids — the succeeded row is hard-deleted and unindexed at O(touched); the failed row stays soft-deleted for the next pass.
4. **forget by clearAll**: every live id enumerated; entity stays tracked; index empties with no full rebuild.
5. **librarian**: O(inserted) reads; inserted fact searchable, ballast untouched.
6. **heal empty-candidate early return**: with only the stale pass mutating rows, `syncEntries` carries exactly those ids (the pre-existing early-return contract, now pinned).
7. **heal full path**: O(touched) reads for deleted + downgraded + inserted; end-state search verifies each.
8. **drift repair**: a row soft-deleted by raw SQL (a pre-#233-style path that skipped index updates) keeps a stale index document until `runPrune` hard-deletes it — the incremental sync scrubs it at O(touched), preserving prune's drift-repair duty.

`MaintenanceService.test.ts`/`healAnchorBounding.test.ts` mocks gain `syncEntries`; `importDump.test.ts`'s busy-key test stalls `syncEntries` (forget's index path). All #233 `SearchService` tests are untouched.

## 5. Delivery

1. `docs(core): spec MaintenanceService incremental index syncs (#235)` — this file.
2. `perf(core): convert MaintenanceService syncs to incremental syncEntries (#235)` — `MaintenanceService.ts` + tests. No public signature changes.
3. `fix(deps): bump fast-uri override floor to 3.1.7 (GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g)` — ride-along CI fix, not part of the conversion: the repo's audit gate (fail on fixable HIGH advisories) began failing on `main` and would have blocked this PR's merge regardless. The lockfile regen also moved ~20 transitive packages (metro 0.87.0→0.87.1 — drops `hermes-parser`/`image-size`, adds `flow-parser` — plus rollup, yaml, the expo 57.0.x family, compression, brace-expansion); all cleared the 14-day `minimumReleaseAge` gate at resolution time. Noted in the PR for reviewer visibility. (Opus review r2: acceptable to keep in this PR given the audit gate blocks everything until it lands.)
4. PR against `main`, merged as a **merge commit** (never squash). No `BREAKING CHANGE` footer; no body line may start with that phrase.
5. After merge: comment on #235 noting where the analysis differed (librarian/heal were not blocked; `softDeleteBySource` did not need to change), set the spec's Status to `Implemented`, close the issue.

Manual benchmark is not required for this PR: the four maintenance passes are user/CI-triggered operations, not import loops, so there is no quadratic-accumulation case to demonstrate. The §4 real-SQLite tests carry the O(touched) assertion instead.

## 6. Revision log

- **r1 (2026-09-28):** initial design, written after verifying all six call sites and the repository layer against `61f7700`. Diverges from the issue: no repository changes needed.
- **r2 (2026-09-28, post-Opus review):** removed `:NNN` line citations (stale as soon as the branch's own edits shift lines); fixed §1 wording ("four of them" / remaining-callers framing); §2.1 documents the clearAll worst case; §4 rewritten to describe the delivered tests instead of a plan that did not match; §5 commit titles corrected and the ride-along deps fix disclosed.
