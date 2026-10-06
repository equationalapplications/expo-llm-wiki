# Spec: FTS5 Index Strategy for Keyword Search (Fix #257)

**Date:** 2026-10-05
**Status:** Approved
**Status revision (2026-10-05, PR #258 review):** Corrected the score contract — the pre-refactor `getMiniSearchScores` divided by `max(1, top)`, not by `top`, and `searchKeyword` returned raw scores. Strategies now return raw, non-negative, higher-is-better scores and `SearchService.getKeywordScores` keeps the `max(1, top)` scaling. Dropped `close?()` (no teardown path exists; PR-2 adds both if FTS5 needs them), documented `getEntryIdsByEntity?()`, and dropped the `getMiniSearchScores` alias (`SearchService` is not exported).

---

## Problem

`WikiMemory`'s keyword search index is **one in-RAM MiniSearch instance shared across every namespace** (`packages/core/src/services/SearchService.ts:47,79`). Every `upsertGraph`, `importDump`, `ingestDocument`, and `runPrune` that touches the keyword path adds documents to it. There is no disk-backed structure under it, so process RSS grows with total stored text.

Concrete evidence (SynapseTree S5 sizing gate, 2026-10-04, Fargate arm64):

| Task size | Build child heap cap | Result |
|---|---|---|
| 2048 MiB | 1536 MiB | SIGKILLed ~15s into pro (4800 MiB) build, empty stderr |
| 4096 MiB | 3072 MiB | SIGKILLed ~33s in, empty stderr |
| 16384 MiB | 6144 MiB | SIGKILLed ~67s in, empty stderr |

The 16 GiB run is decisive: the parent **survived** and reported the child's clean exit (code 1, `build pro failed:` with empty stderr) — so the kernel killed only the build child. Raising `--max-old-space-size` never produced a V8 heap OOM trace; growth is **outside old-space** — MiniSearch's externalized buffers + better-sqlite3's native page cache / transaction memory. The V8 cap cannot govern it.

Extrapolated: building a 4800 MiB database in-process plausibly needs tens of GiB RSS. Pro tier (5 GiB plan) is blocked on this engine work.

## Intent mismatch

This is a **fallback-primary inversion**. MiniSearch was designed as a *fallback* retrieval path for environments where `expo-sqlite` ships without FTS5 (web/OPFS); see `packages/core/__tests__/miniSearchFallback.test.ts`, the `embed` throw → keyword fallback contract in `types.ts:847-858`, and the 2026-05-03 spec that **dropped FTS5 entirely** in favor of semantic search (with MiniSearch as the keyword fallback).

For server-side SQLite-native deployments (SynapseTree writer pool: one writer, `withTransactionAsync` everywhere), the primary should be **SQLite FTS5**:

- Transactional with the data through the existing `SQLiteAdapter`.
- Indexes live inside the database file; flat memory at any size.
- Fixes both build *and* serve in one move.

`sqlite-vec` (the parallel story for vectors) is out of scope here.

## Root cause

Two design choices in `SearchService` make this unsalvageable with the current architecture:

1. **One MiniSearch instance for all entities.** No way to scope or evict per-entity memory pressure. Every index update pays full-process RAM cost.
2. **No disk persistence.** The index lives in the Node heap; rebuilding it on every cold start re-reads every row.

Both go away when the index lives in SQLite itself.

## Goals

- Make keyword search index memory flat at any database size, on Node/SQLite adapters.
- Preserve retrieval semantics: `searchKeyword` returns the same top-K facts in roughly the same order for queries that currently succeed.
- Default to FTS5 on adapters whose SQLite build has it; keep MiniSearch for adapters that do not.
- Keep `WikiMemory`'s public API (`read`, `syncSearchIndex`, `sync`) unchanged.
- Ship a retrieval-parity eval (regression net) before the default flips.

## Non-goals

- Changing the semantic (vector) ranking pipeline. `VectorRanker` and the `embedding_blob` path stay as-is. `rankSemantic`'s hybrid blend with `miniSearchScores` keeps its name and contract; this spec renames the *input* keyword-scores helper to `getKeywordScores`. No alias is kept: `SearchService` is internal (not exported from the package entry point).
- Vectors in SQLite (`sqlite-vec`). Out of scope; tracked separately.
- Per-entity FTS5 partitioning. One `{prefix}entries_fts` table for the whole DB, filtered by `entity_id` in the query. Multi-tenant isolation already uses the `entity_id` column on `entries`; FTS5 inherits it via the JOIN in the search query.
- Replacing MiniSearch for hosts whose adapter has FTS5. Hosts that explicitly pin `'minisearch'` (e.g., for behavioral stability) keep getting MiniSearch.

## Design

### IndexStrategy interface (new, `packages/core/src/services/search/IndexStrategy.ts`)

```ts
export interface IndexDocument {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  tags: string;          // JSON array, joined with ' ' for tokenization
}

export interface IndexSearchOptions {
  entityIds: string[];
  limit: number;
  preFilterLimit?: number;
}

export interface IndexSearchResult {
  id: string;
  /** Entity the result is from; populated from `IndexDocument.entity_id`. */
  entity_id: string;
  /**
   * Strategy-native relevance: non-negative, higher is better, comparable only
   * within one result set. Not normalized — `getKeywordScores` divides by
   * `max(1, top)`; `searchKeyword` passes scores through unscaled.
   */
  score: number;
}

export interface IndexStrategy {
  add(documents: readonly IndexDocument[]): Promise<void>;
  discard(ids: readonly string[]): Promise<void>;
  removeAll(): Promise<void>;
  search(query: string, options: IndexSearchOptions): Promise<IndexSearchResult[]>;
  /** For MiniSearch only — FTS5 is a no-op. Called at the end of every discard-bearing turn. */
  vacuum?(): Promise<void>;
  /** Ids indexed under `entityId`, for per-entity rebuilds. MiniSearch only; FTS5 omits it. */
  getEntryIdsByEntity?(entityId: string): ReadonlySet<string> | undefined;
}
```

The interface is **deliberately narrow** — no `replace`, no `update`, no `commit`. Operations are append-only on `add` and removal on `discard`. This matches the existing SearchService usage (it always reads-then-writes a snapshot through `findMiniSearchRows[ByIds]`) and avoids the trigger-vs-explicit-indexing debate.

### MiniSearchIndexStrategy (new, `packages/core/src/services/search/MiniSearchIndexStrategy.ts`)

Extracted **verbatim** from `SearchService`'s existing implementation: `createMiniSearch()`, `miniSearchEntryIdsByEntity` tracking, the `addAll`/`discard`/`has()` dance from `syncEntries`, the `removeAll` reset, the `dirtCount > 0 → vacuum` rule, and the `clearAll` swap. `search()` returns raw MiniSearch scores, as `searchKeyword` did; the `max(1, top)` scaling from `getMiniSearchScores` stays in `SearchService.getKeywordScores`.

`SearchService` retains ownership of `staleEntities`, `staleEpochs`, `syncChain`, and the orchestration logic (rebuild, markStale, syncStale, evictCache, rankSemantic). Only the **direct MiniSearch API calls** move out. This is the smallest refactor that introduces the seam.

### Fts5IndexStrategy (new, `packages/core/src/services/search/Fts5IndexStrategy.ts`)

Backed by a single `{prefix}entries_fts` virtual table:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS {prefix}entries_fts USING fts5(
  id UNINDEXED,
  entity_id UNINDEXED,
  title,
  body,
  tags,
  tokenize = 'porter unicode61'
);
```

Operations map as follows:

| IndexStrategy method | FTS5 SQL |
|---|---|
| `add(docs)` | `INSERT INTO {prefix}entries_fts (id, entity_id, title, body, tags) VALUES (?,?,?,?,?)` per doc, chunked to `?`-limit × 5 columns. Inside an immediate transaction so a half-applied batch is impossible. |
| `discard(ids)` | `DELETE FROM {prefix}entries_fts WHERE id IN (?,?,…)`. Same chunking. |
| `removeAll()` | `DELETE FROM {prefix}entries_fts`. |
| `search(query, opts)` | `SELECT id, bm25({prefix}entries_fts) AS score FROM {prefix}entries_fts WHERE {prefix}entries_fts MATCH ? AND entity_id IN (?,?,…) ORDER BY score ASC LIMIT ?`. bm25 returns negative values; lower (more negative) is better, so we sort ASC and flip the sign for the IndexSearchResult contract. |

**Explicit indexing, no triggers.** The existing `SearchService` control model (read-then-write through `entryRepo.findMiniSearchRows[ByIds]`, which already filters `deleted_at IS NULL`) applies cleanly. We do not add `entries_ai/ad/au` — soft-delete and `valid_from`/`valid_to` lifecycle (migration v13) make trigger-based sync incorrect: a soft-delete row must leave the index, and the existing `findMiniSearchRows` already excludes it. Triggers would also fire on every ALTER/UPDATE that has nothing to do with text, multiplying writes.

**`search()` filters by `entity_id` via the `IN (?,?,…)` clause**, mirroring the current `filter: (r) => entityIdSet.has(r.entity_id)` predicate in MiniSearch. Multi-entity reads (the `string[]` overload of `WikiMemory.read`) work without per-entity partitioning.

**Score sign** — `bm25()` returns negative numbers; we negate them so the result is non-negative and higher-is-better, per the `IndexSearchResult` contract. `getKeywordScores` then applies the same `max(1, top)` scaling it applies to MiniSearch scores before the `weight * Math.max(0, cosSim) + (1 - weight) * kwScore` blend in `rankSemantic`. Negated FTS5 `bm25()` and MiniSearch BM25+ are on similar but not identical scales, so PR-2 must check that the hybrid blend and the keyword-fallback `factScores` stay comparable across strategies.

### Capability detection (`packages/core/src/services/search/createIndexStrategy.ts`)

```ts
export async function createIndexStrategy(
  db: SQLiteAdapter,
  prefix: string,
  preferred: 'fts5' | 'minisearch' | 'auto',
): Promise<IndexStrategy> {
  if (preferred === 'minisearch') return new MiniSearchIndexStrategy();
  const useFts5 = preferred === 'fts5' ? true : await probeFts5(db, prefix);
  return useFts5
    ? new Fts5IndexStrategy(db, prefix)
    : new MiniSearchIndexStrategy();
}

async function probeFts5(db: SQLiteAdapter, prefix: string): Promise<boolean> {
  const probeName = `${prefix}_fts5_probe_${Math.random().toString(36).slice(2)}`;
  try {
    await db.execAsync(`CREATE VIRTUAL TABLE ${probeName} USING fts5(content)`);
    return true;
  } catch {
    return false;
  } finally {
    try { await db.execAsync(`DROP TABLE IF EXISTS ${probeName}`); } catch {}
  }
}
```

The probe runs at most once per `createIndexStrategy` call (i.e., once per `WikiMemory` instance), at `setup()` time. It is silent — no `console.warn` for the missing-FTS5 path, since that is the supported fallback path for Expo/OPFS.

### `WikiConfig.indexStrategy` (additive)

```ts
interface WikiConfig {
  // …existing…
  /**
   * Default keyword-index backend.
   * 'fts5' — always use FTS5; throw at setup() if the adapter's SQLite lacks it.
   * 'minisearch' — always use the in-RAM index (current behavior).
   * 'auto' (default) — probe FTS5 at setup(); use it if present, else MiniSearch.
   */
  indexStrategy?: 'fts5' | 'minisearch' | 'auto';
}
```

Default is `'auto'`. No existing config key changes; no host opt-in is required to benefit from FTS5.

### Migration v14 (`packages/core/src/db/migrations.ts`)

```ts
{
  version: 14,
  description: 'Add entries_fts virtual table for FTS5 keyword index (#257)',
  run: async (db, prefix) => {
    await db.execAsync(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${prefix}entries_fts USING fts5(
         id UNINDEXED,
         entity_id UNINDEXED,
         title,
         body,
         tags,
         tokenize = 'porter unicode61'
       );`
    );
  },
}
```

The migration is **conditional on the adapter's SQLite having FTS5**. `setup()` already runs each migration inside the existing `setupDatabase` flow; we wrap migration v14 in a try/catch that downgrades to a no-op when `CREATE VIRTUAL TABLE … USING fts5` throws "no such module: fts5". The detection memoizes the outcome in `metadataRepo.setMeta('fts5_available', '1'|'0')` so we don't re-probe on every subsequent `setup()`.

The legacy FTS-detection probe in `WikiMemory.setup()` (lines 271-274) checks for the `porter` tokenizer on the **pre-v2** `entries_fts` schema and routes the legacy upgrade path. Migration v14 is a no-op against an already-installed legacy table (the FTS-table-name `IF NOT EXISTS` guard makes it idempotent), and `setup()`'s legacy detection logic continues to work unchanged.

### Retrieval parity eval (`packages/core/__tests__/searchParity.test.ts`)

A regression net built from the existing **financebench** calibration fixture set (see `packages/benchmarks/results/calibration-7.7.7.json`):

1. **Fixture set**: 50 fact-sets × 5 queries each = 250 queries. Each fact-set has at least one query where the keyword path currently contributes (embed absent, low-DB cardinality, or deliberately disabled).
2. **Golden results**: Run MiniSearch against each fixture, record `{ query, topK=10, factIds }`.
3. **Parity check**: Run FTS5 against the same fixture. For each query, compute:
   - **Recall@K**: fraction of golden's `factIds` present in FTS5's top-K.
   - **Rank distance**: for each gold fact in FTS5's top-K, `|rank_FTS5 - rank_MiniSearch|`.
   - Pass criteria: `recall@10 ≥ 0.85` AND `mean rank distance ≤ 3.0` over the 250 queries.
4. **Per-spec gate**: run as part of the PR-2 CI matrix. Failing the gate blocks the default switch from `'minisearch'` to `'auto'`. Override requires explicit `WikiConfig.indexStrategy: 'fts5'` (acceptable for `SynapseTree` deployments that know the engine behind the adapter).

A pre-flight JSON file (`packages/benchmarks/fixtures/searchParity.json`) holds the queries + golden top-K, so the parity test runs without re-touching the LLM provider.

### Cross-adapter smoke (`packages/core/__tests__/searchParity.test.ts`)

Same test suite runs against:
- `better-sqlite3` (Node, FTS5 always present) — primary case.
- `sql.js` 1.14.x (web/Node, FTS5 present in this build).

Expo-sqlite is exercised in `packages/expo`'s own test suite at the strategy-factory boundary (probe FTS5, fall back gracefully). We do not require Expo FTS5 availability to ship PR-2.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `bm25()` ranking diverges sharply from MiniSearch's TF-IDF for some queries. | Retrieval-parity gate (§retrieval parity eval). Hosts that can't tolerate divergence set `WikiConfig.indexStrategy: 'minisearch'`. |
| sql.js 1.14.x ships without FTS5 in some downstream builds (e.g., custom WASM). | `probeFts5()` handles it; falls back to MiniSearch silently. `console.warn` only on **requested** FTS5 that is unavailable. |
| A `valid_from`/`valid_to` row flips in/out of liveness — does the FTS5 row reflect it? | FTS5 row lives as long as its `entries` row exists. The index join filters by `deleted_at IS NULL` and `valid_*` semantics on the query side, mirroring the SQL liveness check in `liveAtSql` (`packages/core/src/utils/temporal.ts:14`). |
| `bm25()` weights aren't tuned to corpus shape (titles boosted 2× in MiniSearch). | First pass: ship with the FTS5 defaults. Second pass: PR-tune `bm25()` weights on the financebench fixture set, scoped to a follow-up issue. |
| Cold-start sync cost. FTS5 `INSERT … VALUES` per row is slower than MiniSearch `addAll`. | `SearchService.syncEntries` already chunks; we keep the chunking. FTS5 is on disk, so it's a SQLite write inside the serialized transaction — same mutex as `withTransactionAsync`, no extra contention. |

## Rollout

- PR-1 (refactor): no behavior change, ships behind existing gating tests. Default stays `'minisearch'` until PR-2 lands.
- PR-2 (feature): default flips to `'auto'`. Hosts that want to opt out set `indexStrategy: 'minisearch'`. Follow-up issue filed for per-host FTS5 tuning.

## Out of scope

- Cross-tenant FTS5 partitioning (`{prefix}entries_fts_entity_<id>`). One virtual table is enough.
- Storing the bm25 weights on the row. FTS5 uses schema-level weights.
- Per-query synonyms (the dropped `synonymMap` from `2026-05-03-embedding-retrieval.md`).
- `sqlite-vec` (parallel story for vectors). Tracked separately.

## Spec references

- `docs/superpowers/specs/2026-05-03-embedding-retrieval.md` — the spec that *removed* FTS5 in v2. This spec **reintroduces** it as the primary keyword backend; the embedding rationale in that spec stands for the *semantic* ranking pipeline, which is unchanged.
- `docs/superpowers/specs/2026-09-28-incremental-search-index-design.md` — the spec for the existing per-entity incremental sync logic that PR-1 refactors.
- `docs/superpowers/specs/2026-05-01-next-version-improvements.md` — the migration registry this spec adds v14 to.

## Test references

- `packages/core/__tests__/miniSearchFallback.test.ts` — the existing fallback semantics this spec preserves.
- `packages/core/__tests__/SearchService.test.ts` — covered by PR-1's no-behavior-change invariant.
- `packages/core/__tests__/incrementalSearchIndex.test.ts` — incremental sync invariants preserved.
- `packages/benchmarks/src/calibrate.ts` — the calibration pipeline whose fixture set the parity eval starts from.