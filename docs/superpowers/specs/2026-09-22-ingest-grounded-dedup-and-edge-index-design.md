# Ingest Grounded Dedup & Edge Paging Index: Design

**Date:** 2026-09-22
**Status:** Implemented — revision 2
**Branch:** `spec/dedup-grounding-edge-index`
**Source baseline:** `4ebf1bb` (core 7.7.0, after #216 merged)
**Issues:** #214, #217
**Delivery:** one docs PR (this spec), then two independent code PRs (§5). PR A is a `fix(core)`, PR B is a `perf(core)`. Neither may carry a breaking-change footer.

## 1. Decision and scope

Two follow-ups from the grounding series (`2026-09-21-grounding-diagnostics-classifier-design.md`):

- **#214:** when ingest dedupes facts by exact title, keep the duplicate with the best grounding verdict, not whichever came first.
- **#217:** replace `edges_entity_idx (entity_id)` with a composite `edges(entity_id, id)` index, so `lint()`'s keyset paging reads each page as a bounded range scan.

Out of scope:

- The partial ingest path's dedup against facts already stored for the same `sourceRef` (`IngestionService.appendPartialFacts`). A stored fact still wins over any new one. Replacing a stored draft is a separate question.
- The Jaccard `fuzzy_title` dedup in librarian and heal.
- Any change to the `fact_deduplicated` diagnostic's shape or reason slugs.

## 2. Verified baseline facts

Checked against `4ebf1bb`:

1. Ingest dedup is a single pass in `IngestionService.ingestDocument` (`IngestionService.ts:243-275`). It keeps a `seen: Set<titleKey>` across chunks in chunk order. The first fact seen for a `normalizeTitleKey` wins. Every later one gets `fact_deduplicated` with `detail: { sourceRef, chunkIndex, itemIndex, reason: 'exact_title' }`.
2. Grounding verdicts are computed per chunk, before dedup, in `slot.verdicts[k]`. They're parallel to `slot.facts` and `slot.itemIndexes`, and empty when ingest isn't a grounding writer. `groundingLedger` (keyed by fact object identity) is filled during the same pass, for kept facts only.
3. `GroundingVerdict.status` is `'grounded' | 'missing' | 'failed'` (`utils/grounding.ts:57`). `groundingOutcome` maps `grounded` to `stable` + `okf_verified`, and both others to `draft` with a warn diagnostic.
4. `runFullUpsertGraph` walks `orderedChunkFacts` slot by slot. In `emergent` mode it merges a slot's `ontology_updates` into the manifest **before** validating that slot's facts (`IngestionService.ts:723-730`). A fact validated in an earlier slot than its own would miss the types its own chunk introduced.
5. Edge resolution (pass 2 of `runFullUpsertGraph`) runs after every fact is in `titleIndex`, so the slot a fact sits in doesn't affect which edges resolve.
6. The partial path flattens `orderedChunkFacts` in order and dedupes that list against live titles for the `sourceRef`.
7. `edges` has a TEXT primary key and `UNIQUE(entity_id, source_id, target_id, edge_type)`. Its only other index is `edges_entity_idx ON edges(entity_id)`, created in `schema.ts:94` and in the v5 migration at `migrations.ts:97`.
8. Fresh databases are built from `schema.ts` and stamped `schema_version = CURRENT_SCHEMA_VERSION`, so they skip every migration (`WikiMemory.setup`). Existing databases run each migration newer than their stored version. `CURRENT_SCHEMA_VERSION` is derived from the last `MIGRATIONS` entry and is currently 11.
9. Every edges query filters on `entity_id` by equality: `EdgeRepository` (`getByEntityId`, `bulkDeleteByEntityId`, `softDeleteBySourceFactIds`, and `getNeighborhood`'s traversal join and edge fetch) and `LintRepository` (`countDanglingEdges`, `sampleDanglingEdgeIds`, `pageLiveEdges`). No query names an index (`INDEXED BY`).
10. `migration2.test.ts` pins version 11 in three places: the `describe` title (line 63) and the `schema_version` literals `'11'` (lines 80, 104).

## 3. PR A: keep the best-grounded duplicate (#214) [REQ-DEDUP-01]

### 3.1 Rule

Give each ok fact a **rank**: `1` if its verdict is `grounded`, else `0`. With grounding off for ingest, `slot.verdicts` is empty and every fact ranks `0`.

Among facts in one ingest call with the same `normalizeTitleKey`, keep the one with the highest rank. On equal rank, keep the one seen first (chunk order, then item order within a chunk). `missing` and `failed` tie, because both are stored as `draft`.

With grounding off, every rank is equal, so the winner is always the first one seen: the same as the baseline.

### 3.2 Mechanics

The one pass becomes two passes over the chunk results. Failure collection, `fact_rejected` diagnostics, and the `ingestedChunks` / `failedChunks` counts stay as they are.

1. **Select winners.** Walk ok slots in chunk order and facts in item order. Keep `winners: Map<titleKey, { chunkIndex, k, rank }>`.
   - First sighting of a title: it becomes the winner.
   - Later sighting with rank strictly greater than the winner's: it replaces the winner, and the **displaced** fact gets `fact_deduplicated`.
   - Otherwise the **new** fact gets `fact_deduplicated`.
   - Each losing fact gets exactly one diagnostic, carrying its **own** `chunkIndex` and `itemIndex` (`slot.itemIndexes[k]`), with `reason: 'exact_title'`.
2. **Build slots.** Walk ok slots in chunk order again. Each slot keeps only the facts that won, in their original item order, plus its `ontology_updates` (unchanged, even when the slot has no winners left). `groundingLedger` is filled for winners only, from their own `slot.verdicts[k]`, `chunkIndex` and `itemIndex`.

**A winner stays in its own chunk's slot.** It never moves into the slot of the duplicate it replaced. This keeps baseline fact 4 true: an emergent-mode fact is validated against a manifest that already includes its own chunk's `ontology_updates`.

### 3.3 Accepted side effects

- When a later grounded duplicate wins, that title's fact is inserted with its later chunk's facts, so insertion order and `insertedFacts` (and so embed order) change for that title. Edge resolution is unaffected (baseline fact 5).
- Diagnostic buffer order can differ from the baseline when a winner is displaced: the displaced fact's `fact_deduplicated` is buffered when the later duplicate is seen, so it lands after that chunk's `fact_rejected` entries and any diagnostics buffered in between. Only the contents are fixed (§3.2). Tests must not assert on buffer position for these entries.

### 3.4 Partial path

The partial path gets the same winners, because it flattens the slots from §3.2. Its dedup against stored facts runs afterwards and is unchanged: a stored fact still beats a new grounded one.

### 3.5 Spec amendment

In a separate spec-only commit in PR A, append **rev 10** to the grounding spec's revision log, add one line to its §6.5 saying which duplicate is kept when titles match, and move its header to revision 10. Existing revision entries stay as they are.

### 3.6 Tests

In the ingest diagnostics / grounding test files, with a stub LLM returning per-chunk facts:

1. Grounding on. Chunk 0 gives "X" with no evidence, chunk 1 gives "X" with a quote from its chunk. The stored fact is chunk 1's: `stable`, with an `okf_verified` entry. One `fact_deduplicated` at `{ chunkIndex: 0, itemIndex: <X's index> }`. No `grounding_missing` for X.
2. Grounding on. Grounded first, missing second: the first is kept, and the second is deduplicated at its own indexes.
3. Grounding on. Missing first, failed second (a tie): the first is kept as `draft` with `grounding_missing`. No `grounding_failed` for X.
4. Grounding on, two grounded duplicates: the first is kept.
5. Same-chunk duplicates (items 0 and 2, item 2 grounded): item 2 is kept, and item 0 is deduplicated with `chunkIndex` equal to that chunk.
6. Emergent mode. Chunk 1's `ontology_updates` introduces type `T`, and chunk 1's grounded "X" has `okf_type: 'T'` and beats chunk 0's ungrounded "X". The stored fact has `okf_type = 'T'` and its edges are kept.
7. Grounding off: the existing dedup test (`diagnosticsIngest.test.ts:70`) passes unchanged, and first-wins holds even when a later duplicate carries evidence.
8. Partial path (a third chunk fails). Scenario 1's winner is chosen, and a fact already stored for the `sourceRef` still wins over a new grounded one.

Gate: every existing test passes unchanged, in particular `groundingIngest.test.ts`, `groundingOff.test.ts`, `groundingHeal.test.ts`, `instructions.test.ts` and `diagnosticsIngest.test.ts`. If an existing test's fixture has duplicate titles with grounding on and its expectation shifts, stop and record the case in the plan. Don't edit the expectation to make it pass.

## 4. PR B: composite edges index (#217) [REQ-EDGEIDX-01]

### 4.1 Schema

- `schema.ts`: replace `edges_entity_idx ON edges(entity_id)` with `edges_entity_id_idx ON edges(entity_id, id)`.
- `migrations.ts`, new migration **v12** ("Replace edges_entity_idx with composite edges(entity_id, id) for keyset paging"):

  ```sql
  CREATE INDEX IF NOT EXISTS <prefix>edges_entity_id_idx ON <prefix>edges(entity_id, id);
  DROP INDEX IF EXISTS <prefix>edges_entity_idx;
  ```

  Create first, then drop, so the table is never left without an `entity_id` index. Both statements are idempotent. `CURRENT_SCHEMA_VERSION` becomes 12 through the existing derivation. The v5 migration that creates `edges_entity_idx` stays as it is. v12 removes that index on upgrade.

No query text changes. Every edges query filters on `entity_id =` (baseline fact 9), and SQLite serves that from the composite index's leading column.

### 4.2 Tests

- **`migration12.test.ts`**, following `migration11.test.ts`:
  - `CURRENT_SCHEMA_VERSION` equals the last migration's version and is at least 12.
  - A fresh database has `edges_entity_id_idx` with columns `(entity_id, id)` and no `edges_entity_idx`.
  - A database stamped at v11 with the old index upgrades: new index present, old index gone, `schema_version = '12'`.
  - Running v12 twice is a no-op.
  - A fresh database's edges index set equals an upgraded database's.
- **Query plans** (`EXPLAIN QUERY PLAN` on the test adapter):
  - `pageLiveEdges` uses `edges_entity_id_idx` and has no `USE TEMP B-TREE FOR ORDER BY`.
  - `sampleDanglingEdgeIds`, `countDanglingEdges`, `getByEntityId`, `bulkDeleteByEntityId` and `softDeleteBySourceFactIds` each use an index on `e` (no `SCAN e` / full scan of `edges`).
- `migration2.test.ts`: replace the literal `'11'` (lines 80, 104) with `String(CURRENT_SCHEMA_VERSION)`, and drop the hardcoded version from the `describe` title at line 63 ("setup ends at version 11" → "setup ends at CURRENT_SCHEMA_VERSION"). The assertion becomes a tautology, which is acceptable because `migration12.test.ts` pins the derivation independently.
- `lint.test.ts` passes unchanged, including `sample` ordering by `id`.

## 5. Delivery sequence

1. **Docs PR:** this spec.
2. **PR A** (#214), `fix(core)`: the code and tests from §3, plus the grounding-spec amendment (§3.5) in its own spec-only commit.
3. **PR B** (#217), `perf(core)`: §4.

PR A and PR B don't depend on each other and can merge in either order. Merge every PR as a merge commit; never squash.

> **As delivered (rev 2):** the planned separate PRs were not used. At the user's request, the docs, PR A and PR B commits all landed on one branch (`spec/dedup-grounding-edge-index`) as one PR (#219). The commits stay separate: `cab5909` (PR A), `d58f089` (PR B), `43c914b` (grounding amendment).

## 6. Revision log

- **rev 1 (2026-09-22):** initial approved design, with pre-PR review fixes folded in: §3.3 buffer-order wording, §3.6 regression gate, and the `migration2.test.ts` title in §4.2. `fix(core)` for PR A was kept after review: #214 is a dedup-quality bug that grounding exposed, and the change only affects ingests with grounding on and duplicate titles. Decisions made with the user: one spec for two PRs, and drop the redundant `edges_entity_idx` in v12 instead of keeping it. The kept duplicate stays in its own chunk's slot because of emergent-mode manifest ordering (baseline fact 4).
- **rev 2 (2026-09-22):** status — Implemented. PR A landed as commit `cab5909` (#214), PR B as `d58f089` (#217). Both delivered on a single branch (`spec/dedup-grounding-edge-index`) at the user's request; the spec amendment (grounding rev 10) landed in commit `43c914b`.
