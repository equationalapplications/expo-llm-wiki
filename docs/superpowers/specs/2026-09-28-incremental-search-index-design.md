# Incremental Keyword Search Index: Design

**Date:** 2026-09-28
**Status:** Implemented — revision 6
**Branch:** `fix/core-incremental-search-index-232`
**Source baseline:** `854ac92` (core 7.7.5)
**Issue:** #232
**Delivery:** one PR on this branch. The spec is committed separately from the code (§8). The code commit is a `perf(core)` and must not carry a breaking-change footer: no public signature changes.

## 1. Decision and scope

`importDump` and `ingestDocument` finish every call with `SearchService.sync(entityId)`, which rebuilds the entity's whole MiniSearch index and then vacuums it. The cost of one call is proportional to the entity's size, not to what the call wrote. For a host that imports in chunks, the total cost grows quadratically. In #232, a 1000-note import took 18.9 s in 25-fact chunks and 1.1 s in one call (Node), and ~122 s on an Android emulator.

Decision: **update the index incrementally for the rows a write touched**, through a new `SearchService.syncEntries(entityId, ids)`. `importDump` and `ingestDocument` switch to it. `sync()` stays as the full rebuild for setup, maintenance, and recovery.

Rejected alternatives:

- **`importDump(dump, { deferIndex: true })` + public `wiki.syncSearch(entityId)`** (the issue's fallback). This adds public API, makes hosts responsible for keeping the index consistent, and does nothing for `ingestDocument`.
- **Turning MiniSearch `autoVacuum` back on.** It was turned off on purpose in #64. Auto-vacuum runs outside the serialized chain, and a vacuum that traverses the tree while a rebuild is in progress threw the uncaught `TypeError`. §4.3 vacuums on a threshold instead, inside the chain.
- **Indexing from the descriptors the write paths already hold** (`insertedFacts` in ingest, `clippedTextByFactId` in import). `upsertGraphCore` can drop or normalize nodes, and import clips text. Re-reading the touched rows by id makes SQLite the only source of truth, and the read is O(touched).

Out of scope:

- The `MaintenanceService` callers (`runPrune` at `MaintenanceService.ts:278/308`, `forget` at 538, `doRunLibrarian` at 772, `doRunHeal` at 854/1093). They keep `sync(entityId)`. Librarian and heal update, downgrade, and soft-delete rows through several repository calls that don't all return ids. Converting them is a follow-up once those calls return their touched ids.
- Making `upsertGraph` index its own nodes. The host owns that transaction and core never sees the commit (§3.7). §5 keeps today's behavior, where the next core write catches the index up, without adding a post-commit hook.
- Any change to ranking, tokenization, or `searchKeyword`/`getMiniSearchScores`.

## 2. Evaluation of the issue's proposal

The issue's plan (incremental upsert, vacuum less, keep `sync`) is correct in direction. The first draft of this design followed it, but review against the code found five problems it had to fix:

1. **`MiniSearch.discard(id)` throws when the id isn't in the index** (`minisearch@7.2.0`: "cannot discard document with ID …: it is not in the index"), and `add` throws on a duplicate id. "Discard those ids if present" has to check against state we track, never assume. §4.2 discards only ids in the entity's tracked set.
2. **Discarding before the read loses documents if the read fails.** `rebuildIndex` already reads first. `syncEntries` does the same: read, then discard and add synchronously with no `await` between, so the index never shows a half-applied update.
3. **Running removals and additions as two separate calls is unnecessary.** Soft-deleted rows don't come back from a `deleted_at IS NULL` read, so one call with the union of touched ids handles inserts, updates, and deletes.
4. **The index stops catching up on rows written outside core's post-commit path.** Today any row written without an index update (by `upsertGraph`, by a failed rebuild, or inserted raw in tests) gets indexed on the next import or ingest for that entity, because that call rebuilds the whole entity. Incremental updates remove this side effect. §5 restores it on purpose with a per-entity stale flag.
5. **Never vacuuming lets dirt grow without bound**, because `autoVacuum` is off. Vacuuming on every call is the O(index) cost we're removing. §4.3 vacuums inside the chain once dirt crosses MiniSearch's own default thresholds. That spreads the cost across discards and bounds memory.

The acceptance test is also changed. "Chunked and one-shot times are within a small constant factor" is flaky in CI. §7 proves the same thing deterministically by counting the rows read back from the repository.

## 3. Verified baseline facts

Checked against `854ac92`:

1. `SearchService.sync(entityId?)` chains onto `syncChain`, runs `rebuildIndex(entityId)`, then `miniSearch.vacuum()`, and evicts the vector cache in a `finally`. Any error is caught and logged as `[WikiMemory] search index rebuild failed for …`, so the chain never rejects (`SearchService.ts:86-106`).
2. `rebuildIndex(entityId)` reads `findMiniSearchRows(entityId)` (every live row of the entity), discards every id in `miniSearchEntryIdsByEntity.get(entityId)`, calls `addAll` on the rows, and replaces the tracked set (`SearchService.ts:233-253`). With no argument it runs `removeAll` and rebuilds from every live row.
3. MiniSearch is constructed with `autoVacuum: false` (#64). `minisearch@7.2.0` exposes `has(id)`, `dirtCount`, `dirtFactor`, and `vacuum()`. Its default vacuum conditions are `minDirtCount: 20`, `minDirtFactor: 0.1`.
4. `WikiMemory.setup()` ends with a global `searchService.sync()` (`WikiMemory.ts:287`), so the index is warm after setup, and every entity with live rows has a tracked set.
5. `doImportEntity` (`ImportExportService.ts:127-434`):
   - On `merge=false`, it collects `softDeletedFactIds` (all live ids from `findIdsBySource(entityId, null, null, tx, false)`) and then bulk soft-deletes the entity.
   - Every fact it writes goes through `upsertForImport` and is added to `upsertedFactIds`. That set includes facts imported with `deleted_at` set (also tracked in `upsertedDeletedFactIds`).
   - Facts skipped for a cross-entity collision or a stale `updated_at` under `merge` are not added to it.
   - Tasks, events, edges, and the summary are not in the keyword index.
   - It calls `sync(entityId)` at line 434, after the transaction.
6. `ingestDocument`'s full path (`runFullUpsertGraph` → `upsertGraphCore`) captures `deletedSourceFactIds = findIdsBySource(entityId, sourceRef, null, tx, false)` before `softDeleteBySource(entityId, tx, sourceRef, null)`. Both run in the same transaction with the same predicate, so the two sets match. Every node is written with a freshly generated id and returned in `insertedFacts`. The partial path (`appendPartialFacts`) only inserts rows with fresh ids, returned in `insertedDescriptors`. No other `entries` row is written on either path. `ingestDocument` calls `sync(entityId)` at line 447, after the transaction.
7. `WikiMemory.upsertGraph` calls `upsertGraphCore` inside the host's adapter/transaction and never touches `SearchService` (`WikiMemory.ts:694-738`).
8. `EntryRepository` chunks `IN (…)` lists by `this.chunkSize = 500` (`EntryRepository.ts:109`, used by `findExistingMetadataByIds`).
9. `ImportExportService.test.ts` mocks `searchService` as `{ sync, evictCache }`. `SearchService.test.ts` pins `sync`'s behavior, including "vacuums explicitly and does not leave auto-vacuum armed" and chain survival.

## 4. `SearchService.syncEntries` [REQ-SEARCH-INC-01]

### 4.1 Signature

```ts
/**
 * Re-indexes only `ids` for `entityId`: drops each from the index, then re-adds
 * the ones still live in SQLite. Soft-deleted or missing ids end up absent.
 * Serialized with sync() on the same chain; never rejects.
 */
async syncEntries(entityId: string, ids: Iterable<string>): Promise<void>
```

It returns immediately, without joining the chain, when `ids` is empty and the entity is not stale (§5).

### 4.2 Algorithm (one turn of `syncChain`)

1. If `entityId` is in `staleEntities`, or has no tracked set (it has never been indexed), run `rebuildIndex(entityId)` and an unconditional `vacuum()`, which is exactly what `sync(entityId)` does today. Then clear the stale flag and go to step 5. The fallback is cheap for a new entity: its first chunk rebuilds from only the rows it just wrote.
2. `rows = await entryRepo.findMiniSearchRowsByIds(entityId, uniqueIds)`. This is the turn's only `await` before the index is mutated.
3. Synchronously, with no `await` from here to the end of this step:
   - For each id in `uniqueIds` that is in the entity's tracked set, call `miniSearch.discard(id)` and remove it from the set. An id in the tracked set is always in the index, so `discard` can't throw. Ids that belong to other entities are never in this entity's set, so they're never touched.
   - Call `miniSearch.addAll(rows.map(normalizeMiniSearchRow))` and add each id to the tracked set. After the discard pass, none of these ids is in the index, so `addAll` can't hit a duplicate: the repository read is entity-scoped, and `entries.id` is the primary key.
4. Run a conditional vacuum (§4.3).
5. In a `finally`, call `evictCache(entityId)`, the same as `sync`.

Errors use the same guard as `sync`: they are caught, the entity is added to `staleEntities`, and a warning is logged: `[WikiMemory] search index incremental sync failed for ${entityId}:`. The chain survives. A failure in step 2 leaves the index unchanged. A failure in step 3 can leave it partly updated, and the stale flag makes the entity's next index call a full rebuild.

The step-1 fallback has a subtle case. When a tracked set is missing but documents for the entity are still in the index, `addAll` would throw on a duplicate id. This can't happen: the set is only created by `rebuildIndex` and `syncEntries`, and only removed by `clearAll`, which also runs `removeAll`. §7 has a test that pins this invariant.

### 4.3 Conditional vacuum

After an incremental turn, vacuum only if `miniSearch.dirtCount >= 20 && miniSearch.dirtFactor >= 0.1`. These are MiniSearch's own `defaultVacuumConditions`. Declare them as named constants in `SearchService` with a comment citing that source, and await the vacuum inside the chain turn. A vacuum then runs only after at least 10% of the index has been discarded, so its O(index) cost averages out to O(1) per discard, and dirt stays bounded to about 10% of the index. For a merge-mode chunked import of new facts, which discards nothing, the vacuum never runs.

`sync()` keeps its unconditional vacuum. The #64 test "vacuums explicitly and does not leave auto-vacuum armed" still holds, and `autoVacuum` stays `false`.

### 4.4 Repository read [REQ-SEARCH-INC-02]

```ts
async findMiniSearchRowsByIds(entityId: string, ids: readonly string[], tx?: SQLiteAdapter):
  Promise<Array<{ id: string; entity_id: string; title: string; body: string; tags: string }>>
```

`SELECT id, entity_id, title, body, tags FROM ${prefix}entries WHERE deleted_at IS NULL AND entity_id = ? AND id IN (…)`, chunked by `this.chunkSize`. It returns `[]` for an empty `ids` without querying. Its columns match `findMiniSearchRows` exactly, so both reads produce identical documents.

## 5. Stale entities [REQ-SEARCH-INC-03]

`SearchService` gains `private staleEntities = new Set<string>()` and a public `markStale(entityId: string): void`, which is synchronous, touches no chain, and only adds to the set.

- `syncEntries` sets the flag when it fails (§4.2) and clears it after its full-rebuild fallback.
- `sync(entityId)` clears the entity's flag after a successful rebuild. `sync()` with no argument clears every flag. `clearAll()` also clears every flag.
- `WikiMemory.upsertGraph` calls `this.searchService.markStale(entityId)` after `upsertGraphCore` returns. Today, `upsertGraph` nodes become keyword-searchable on the entity's next import or ingest, or after a restart. The flag keeps exactly that behavior. If the host rolls back, the extra rebuild just reads the committed truth, so no harm is done.

## 6. Call-site changes [REQ-SEARCH-INC-04]

### 6.1 `ImportExportService.doImportEntity` (line 434)

```ts
await this.searchService.syncEntries(entityId, [...softDeletedFactIds, ...upsertedFactIds]);
```

- `merge=true`: the touched set is the facts this call wrote, so the cost is O(chunk). This is the #232 case.
- `merge=false`: the touched set is every previously live id plus the bundle, so the cost is O(entity), the same as today. A non-merge import replaces the entity, so it can't be cheaper.

Everything else after the transaction (embedding and blob handling) is unchanged.

### 6.2 `IngestionService.ingestDocument` (line 447)

```ts
await this.searchService.syncEntries(entityId, [...deletedSourceFactIds, ...insertedFacts.map((f) => f.id)]);
```

This works for both paths: `deletedSourceFactIds` is empty on the partial path. The cost is O(facts retired + facts inserted by this document), no longer O(journal).

### 6.3 Unchanged

`sync()`, `rebuildIndex`, `setup()`'s global sync, every `MaintenanceService` caller, `clearVectorCache`, and the `WikiMemoryTestAccess` surface.

## 7. Tests

`packages/core/__tests__/SearchService.test.ts`, new `describe('syncEntries')`:

1. Adds new ids: search finds them, and `findMiniSearchRowsByIds` is called with the entity and exactly those ids. `findMiniSearchRows` is not called.
2. Updates an existing id: the old term is gone and the new term is found.
3. A soft-deleted id (absent from the repo result) is removed from search.
4. An id tracked under a different entity is neither discarded nor re-added, and the other entity's search result is unchanged.
5. Unknown ids (not in the index and not in the repo) don't throw.
6. An empty `ids` array on a fresh, tracked entity makes no repository call.
7. An untracked entity falls back to `findMiniSearchRows(entityId)` (the full rebuild).
8. Failure: when `findMiniSearchRowsByIds` throws, the call resolves, logs a warning, leaves the index unchanged, and the entity's next `syncEntries` does a full rebuild. The chain survives.
9. `markStale(e)`: the next `syncEntries(e, …)` does a full rebuild, and a later call is incremental again.
10. Serialization: concurrent `sync` and `syncEntries` never overlap (the scripted-repo pattern from the existing #64 tests).
11. Vacuum: no `vacuum()` call while dirt is below threshold, one call once the threshold is crossed, and `autoVacuum` stays `false`.
12. Invariant: after `clearAll()`, `syncEntries` takes the full-rebuild fallback, not a duplicate-id `addAll`.

`packages/core/__tests__/repositories/EntryRepository.test.ts`: `findMiniSearchRowsByIds` filters by entity and `deleted_at`, chunks past 500 ids, and returns `[]` for empty input without querying.

`packages/core/__tests__/importDump.test.ts` (real SQLite), for acceptance:

13. **Chunk-size independence.** Import 1000 facts once in one `merge: true` call and once in 25-fact chunks on a fresh wiki. Spy on the two repository reads. Across the chunked import, the total number of rows read back for indexing is at most 1000 plus the setup read, not ~20 000. A small set of keyword queries returns identical id lists in both wikis.
14. **Non-merge still replaces.** A `merge: false` import drops the previous facts from search.

`packages/core/__tests__/ingest.test.ts`:

15. `ingestDocument` on an entity seeded with 1000 facts doesn't call `findMiniSearchRows(entityId)`. It reads only the superseded and inserted ids. The new facts are keyword-searchable and the superseded ones are not.

`packages/core/__tests__/services/ImportExportService.test.ts`: add `syncEntries` to `mockSearchService`, and assert it receives the union of soft-deleted and upserted ids.

`packages/core/__tests__/upsertGraphContract.test.ts`: after `upsertGraph` commits, the entity's next `ingestDocument` or `importDump` makes the upserted nodes keyword-searchable. This pins §5.

All existing `sync()` tests must still pass unchanged.

The issue's wall-clock benchmark (25/100/250/1000 fact chunks) is not a CI test. Run it by hand once before merge with the Curated Journal seed (`N=1000 npm run seed:night-shift`), and record the numbers in the PR description.

## 8. Delivery

1. `docs(core): spec incremental search index (#232)`: this file only.
2. `perf(core): index only the rows importDump and ingestDocument touch (#232)`: `SearchService`, `EntryRepository`, `ImportExportService`, `IngestionService`, `WikiMemory.upsertGraph`, and tests.
3. PR against `main`, merged as a **merge commit** (never squash). No `BREAKING CHANGE` footer, and no body line may start with that phrase.
4. After merge, set this spec's Status to `Implemented` in an appended revision. Open a follow-up issue for converting the `MaintenanceService` callers (§1).

## 9. Revision log

- **r1 (2026-09-28):** initial design.
- **r2 (2026-09-28):** implemented. Delivery deviations, decided while planning: (a) the real-SQLite acceptance tests live in the new `__tests__/incrementalSearchIndex.test.ts`, because `importDump.test.ts` and `ingest.test.ts` drive `WikiMemory` through a regex mock database that can't run keyword search. The unit-level assertions still live in `ImportExportService.test.ts` and `ingest.test.ts`. (b) The code ships as four commits: two `refactor(core)` commits (repository read, `syncEntries`), one `perf(core)` commit (call sites; the only changelog entry), and one `test(core)` commit. That replaces §8's single code commit. On-branch benchmark (1000 facts, 25/100/250/1000-fact chunks): 790 / 736 / 722 / 757 ms — within 1.04× across chunk sizes, well inside the ≤ 2× target. Baseline re-run was skipped during this session; the PR description carries the on-branch numbers only.
- **r3 (2026-09-28):** review remediation. `clearAll()` now swaps in a fresh `MiniSearch` (via a new `createMiniSearch()` factory shared with the constructor) instead of calling `removeAll()`: minisearch 7.2.0's `removeAll()` empties the index but leaves `dirtCount` and vacuum bookkeeping at their old values, which could trip §4.3's conditional vacuum early after a clear and made the "fully resets" doc false. This supersedes §4.2's mechanism note that `clearAll` "also runs `removeAll`"; the invariant that note supports (no documents survive `clearAll`, so the missing-tracked-set `addAll` fallback can't hit a duplicate id) is unchanged — a fresh index is trivially empty. A new test in `SearchService.test.ts` pins `dirtCount === 0` after `clearAll`. A second review finding — replacing `[...new Set(ids)]` in `syncEntries` with a manual dedupe loop — was evaluated and rejected: the dedupe is API-boundary hygiene for a public `Iterable<string>` (duplicate ids would also inflate the chunked SQL placeholder count), and the proposed loop runs the same passes.
- **r4 (2026-09-28):** review remediation. The §4.1 early return now also requires the index to track the entity (`miniSearchEntryIdsByEntity.has(entityId)`), so it agrees with step 1's `needsRebuild()` definition of "rebuild in full": an empty `ids` list on a never-indexed entity falls through to the full rebuild instead of returning. This supersedes §4.1's sentence that the early return fires on empty `ids` for any non-stale entity. No in-repo write path could actually strand live rows in an untracked, non-stale entity (ingest and `importDump` pass the ids they wrote, which forces the rebuild; `upsertGraph` marks stale), so nothing observable had regressed — but the skipped rebuild also skipped the registration that makes the entity's later syncs incremental. Cost: one entity-scoped `SELECT`, usually returning zero rows, per no-op ingest on a fresh entity. A new `SearchService.test.ts` case pins the rebuild-and-register behavior and that the follow-up sync stays incremental.
- **r5 (2026-09-28):** review remediation of a second round (eight findings: five fixed, two rejected, one both). The fixes, each its own commit:
  1. **Score inversion and tie order (supersedes §4.3 and the §1 out-of-scope claim for ranking).** Verified against minisearch 7.2.0: one un-vacuumed `discard` — soft-delete, retire-then-insert, or update-in-place — splits every term-sharing cohort into two sign-inverted score groups (ids indexed before the discarded id drop below ids indexed after, at any index size; a realistic tag query reorders wholesale), and the §4.3 conditional vacuum left that resident below minisearch's default thresholds, which do not bound it. `syncEntries` now vacuums whenever a turn leaves `dirtCount > 0`. Discard-bearing turns pay the O(index) vacuum — never worse than the per-write rebuild+vacuum the `sync()` path has always done — while add-only turns (merge-mode chunked imports, §1's case) accrue no dirt and never vacuum; re-running the r2 benchmark shape after the change gave 125/101/99/141 ms for 25/100/250/1000-fact chunks, flat as before. Separately, equal-score results were ordered by MiniSearch internal insertion order, which `syncEntries` perturbs (a re-indexed id moves to the end), so `searchKeyword`/`getMiniSearchScores` — all of whose callers truncate to a limit — could return a write-history-dependent id set at a tie boundary. Both now re-sort exact score ties by `id`, the same final tie-break `_compareScoredRows` applies. The threshold constants are gone; the tests that pinned them now pin "add-only never vacuums, discarding turns always do."
  2. **The r4 early return now awaits the chain** (`return this.syncChain`) instead of resolving immediately, restoring the read-after-write guarantee of the `await sync(entityId)` tail it replaced: a write that dedups to nothing while a `forget()` or global `sync()` rebuild is queued must not let the host's next search read a pre-rebuild index. Still no repository call.
  3. **The §4.2 step-3 invariant "an id in the tracked set is always in the index" was not guaranteed** — `rebuildIndex` discards the previous ids before replacing the set, so a throw in between leaves the set claiming ids the index has dropped, and `discard()` throws on those. The loop now tests `miniSearch.has(id)`; a drifted set costs one skipped discard instead of a caught throw, a stale flag, and a forced rebuild with a misleading warning.
  4. **`merge=false` calls `sync(entityId)` again** (supersedes §6.1's one-call-site rule): its touched set is every previously live fact plus the bundle, so `syncEntries` was doing O(entity) work through chunked id-parameterized reads — strictly more SQL than the single entity scan it replaced. End state is identical; the real-SQLite replacement acceptance test is unchanged.
  5. **§4.4 is enforced by construction:** `findMiniSearchRows` and `findMiniSearchRowsByIds` build their SQL from shared constants (`MINI_SEARCH_COLUMNS`, `MINI_SEARCH_LIVE_WHERE`) instead of hand-copied literals, and the two call sites pass plain arrays, leaving dedupe at the public `Iterable<string>` boundary as r3 settled.
  The rejections:
  - **Per-id `upsertGraph` invalidation** (to keep interleaved-upsertGraph hosts at O(touched)): unsafe under host rollback — §5's own argument. ids recorded from an uncommitted (or rolled-back) `upsertGraph` would be discarded from the index and read back absent, dropping live documents; the entity-coarse flag heals by re-reading committed truth. The interleaving cost is the pre-#232 status quo, not a regression.
  - **Bounding `staleEntities`:** an LRU or clearing flags on unrelated rebuilds silently drops needed rebuilds (rebuilding entity A says nothing about entity B's drift) — a correctness loss for one id string per `markStale`'d entity, which is dwarfed by `miniSearchEntryIdsByEntity` itself and shrinks only on that entity's rebuild or a global `sync()`, both already implemented.
- **r6 (2026-09-28):** PR review remediation. A bot review flagged the fast path's post-read re-check as a race; that claim is false — §4.2 step 2's re-check (`tracked && !staleEntities.has(entityId)`) runs after the only `await`, and from there to `addAll` the turn is synchronous, so no `clearAll()`/`markStale()` can interleave, and both cases fall through to a full rebuild in the same call. Verifying it did surface a genuinely open window next door: `markStale()` runs inside the host's still-open transaction, so a call landing while a rebuild's read is in flight belongs to rows that read cannot have seen — yet the rebuild's completion unconditionally deleted the flag, losing the catch-up until some unrelated full rebuild. §5's flag clearing is now epoch-guarded: `markStale` bumps a per-entity counter, and a rebuild clears the entity's flag only when the counter it snapshotted before its read still holds afterwards (`sync()`'s global clear included). Residual, accepted: a `markStale` that lands *before* a concurrent turn's read with the transaction still uncommitted at the snapshot moment remains indistinguishable from a stale flag the read already covers — that is the host-owned-transaction gap §1/§5 already scope out.
