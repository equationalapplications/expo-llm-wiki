# Spec: FTS5 Index Strategy for Keyword Search (Fix #257)

**Date:** 2026-10-05
**Status:** Approved
**Status revision (2026-10-05, PR #258 review):** Corrected the score contract — the pre-refactor `getMiniSearchScores` divided by `max(1, top)`, not by `top`, and `searchKeyword` returned raw scores. Strategies now return raw, non-negative, higher-is-better scores and `SearchService.getKeywordScores` keeps the `max(1, top)` scaling. Dropped `close?()` (no teardown path exists; PR-2 adds both if FTS5 needs them), documented `getEntryIdsByEntity?()`, and dropped the `getMiniSearchScores` alias (`SearchService` is not exported).
**Status revision (2026-10-05, PR #258 review, round 2):** Replaced `add`/`discard`/`removeAll` with three single-step writes, `replace`, `replaceEntity` and `replaceAll`. Searches do not wait for `syncChain`, so splitting a write into awaited steps let a concurrent search see a half-applied index. The pre-refactor code avoided this by never awaiting between discard and `addAll`. Scores must be finite. Specified FTS5 per-entity replacement (`DELETE … WHERE entity_id = ?`) and upsert-by-delete, because FTS5's `id` column is not unique.
**Status revision (2026-10-06, PR #258 widening):** Reshaped `IndexStrategy` so the entity-scoping invariant is typecheck-enforced and the strategy owns its id-tracking structure. `replace(entityId, ids, documents)`; `getEntryIdsByEntity` is gone, replaced by `hasIndexedEntity?(entityId): boolean | undefined`. `SearchService.syncEntries` no longer filters ids to drop against a returned id set — the strategy ignores ids it does not track under the named entity. The MiniSearch impl adds an `entityIdById` reverse map. The "PR-2 must keep the incremental path open for FTS5" caveat is gone; the FTS5 `replace` SQL is `DELETE … WHERE entity_id = ? AND id IN (?,?,…)`, scoped in one statement.
**Status revision (2026-10-06, PR #258 review round 4):** Made `replace(entityId, [], [])` register the entity as indexed (was already a contract requirement; MiniSearchIndexStrategy now sets the empty set on every `replace`, not only on `replaceEntity`). Closed a cross-entity write hole: a document whose `entity_id` does not match the call's `entityId` is rejected by both `replace` and `replaceEntity` before any discard, so the strategy cannot accidentally land a doc in another entity's tracking set. MiniSearchIndexStrategy's `addDocuments` switched from `addAll` to a per-document `add` so a duplicate-id throw part-way leaves the strategy with the index and the tracking maps in the same shape (every doc already added is tracked); the next rebuild can then discard those ids instead of failing on the same duplicate forever. FTS5 must apply the same atomic-add property per row (one `INSERT` per doc inside the transaction, not a single multi-row statement that may partially apply).
**Status revision (2026-10-06, PR-2 design, post-#258):** Checking the PR-2 sections against the merged code showed that FTS5 alone would not fix #257. Two paths still read every row into JS: `setup()`'s global sync, and `upsertGraph` → `markStale` → full-entity rebuild. The in-memory `indexedEntities` set was lost on restart, nothing healed a crash between the data commit and the FTS write, `UNINDEXED` id lookups scanned the whole table, and `entries.rowid` is not stable across `VACUUM`. PR-2 now uses a trigger-fed per-entry ledger (`fts_pending`), an `fts_map` id→rowid table, and an all-SQL chunked drain. It adds optional `IndexStrategy.init`/`drain`/`rebuildFromSource`, resolves the strategy in `setup()`, drops migration v14 in favor of strategy-owned schema with `live`/`detached` state, adds a query sanitizer, and ships the title bm25 weight now. See §PR-2 revision. The sections it supersedes are kept below as the record.
**Status revision (2026-10-06, PR-2 planning probe):** Checked two facts the spec relied on. First, sql.js 1.14.2 (the version in the lockfile) ships **without** FTS5 (`no such module: fts5`), though it has json1. The cross-adapter smoke test therefore uses sql.js as the real no-FTS5 fallback case, not an FTS5 case. Second, on better-sqlite3 (SQLite 3.53.4), the porter tokenizer plus a prefix query (`"running"*`) matches a document containing `runs`, so the query builder needs no `OR "tok"` fallback. `calibration-7.7.7.json` holds only aggregate results and no query or text fixtures, so the parity corpus is generated from repository Markdown into `packages/benchmarks/fixtures/searchParity.json`, and the golden top-K is computed live from MiniSearch.

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
   * `max(1, top)`; `searchKeyword` passes scores through unscaled. Must be
   * finite; SearchService drops results whose score is not.
   */
  score: number;
}

export interface IndexStrategy {
  // Each write applies as one step: a concurrent search() sees the index
  // wholly before or wholly after it. Each write is also entity-scoped
  // (replace) or entity-clearing (replaceEntity/replaceAll): the strategy
  // owns its id-tracking structure so SearchService never sees the ids.
  /**
   * Remove `ids` (silently ignored when not currently tracked under
   * `entityId`, or never indexed at all), then upsert `documents` by id.
   * Other entities' documents are NEVER touched. Argument order is
   * `(entityId, ids, documents)` so the FTS5 SQL
   * `DELETE … WHERE entity_id = ? AND id IN (…)` matches the call shape.
   * A tracking-only call (`replace(entityId, [], [])`) registers the
   * entity as indexed, so the next syncEntries can take the incremental
   * fast path. Every document MUST carry `entityId` as its `entity_id`;
   * a mismatch is rejected before any discard. Incremental sync.
   */
  replace(
    entityId: string,
    ids: readonly string[],
    documents: readonly IndexDocument[],
  ): Promise<void>;
  /**
   * Drop every document currently under `entityId`, then add `documents`.
   * The entity stays registered as indexed, even when `documents` is empty,
   * so `hasIndexedEntity` continues to return `true` for it. Every
   * document MUST carry `entityId` as its `entity_id`; a mismatch is
   * rejected before any discard. Per-entity rebuild.
   */
  replaceEntity(entityId: string, documents: readonly IndexDocument[]): Promise<void>;
  /**
   * Empty the entire index, then add `documents`. After this, every entity
   * is unregistered (`hasIndexedEntity` returns `false`). Global rebuild and clear.
   */
  replaceAll(documents: readonly IndexDocument[]): Promise<void>;
  search(query: string, options: IndexSearchOptions): Promise<IndexSearchResult[]>;
  /** For MiniSearch only — FTS5 is a no-op. Called at the end of every discard-bearing turn. */
  vacuum?(): Promise<void>;
  /**
   * `true` when `entityId` has been indexed at least once under the current
   * strategy state; `false` otherwise. Drives `syncEntries`' incremental
   * fast path. `false` after `replaceAll([])`; `true` after any `replace`
   * or `replaceEntity` that wrote at least one document (including
   * `replace(entityId, [], [])` used as a tracking-only call).
   * `undefined` means "unknown — take the rebuild path".
   */
  hasIndexedEntity?(entityId: string): boolean | undefined;
}
```

The interface is **deliberately narrow**: three writes, each matching one existing SearchService path, and no `update` or `commit`. SearchService always reads a snapshot through `findMiniSearchRows[ByIds]` first and then writes it, which also avoids the trigger-vs-explicit-indexing debate. Each write is one step because searches are not serialized on `syncChain`. MiniSearch gets this by never awaiting inside a write; FTS5 by running each write in one transaction. `replace` carries `entityId` so the scoping invariant is typecheck-enforced and the strategy can answer "did I track this id under that entity?" from its own bookkeeping.

### MiniSearchIndexStrategy (new, `packages/core/src/services/search/MiniSearchIndexStrategy.ts`)

Extracted **verbatim** from `SearchService`'s existing implementation: `createMiniSearch()`, `miniSearchEntryIdsByEntity` tracking, the `addAll`/`discard`/`has()` dance from `syncEntries` (no await between discard and `addAll`), the empty-set registration from `rebuildIndex`, the fresh-instance reset, the `dirtCount > 0 → vacuum` rule, and the `clearAll` swap. `search()` returns raw MiniSearch scores, as `searchKeyword` did; the `max(1, top)` scaling from `getMiniSearchScores` stays in `SearchService.getKeywordScores`.

The new shape adds a private `entityIdById: Map<id, entityId>` reverse map. `replace(entityId, ids, docs)` filters `ids` against `entityIdById.get(id) === entityId` and silently ignores the rest, so ids belonging to other entities are not touched. `hasIndexedEntity(entityId)` returns `entryIdsByEntity.has(entityId)`.

Write atomicity, per document: `replace` and `replaceEntity` check every input against `entityId` before mutating, and `addDocuments` is a per-document loop (`add` plus map writes) rather than `addAll`. A throw on document *n* leaves the index and the tracking maps with documents 1..n-1 committed and *n* onward untouched, so the next rebuild can discard exactly that prefix. `addAll` would have left docs 1..n-1 in the index but the tracking map empty, so a subsequent rebuild would re-add them and throw on the same duplicate forever.

`SearchService` retains ownership of `staleEntities`, `staleEpochs`, `syncChain`, and the orchestration logic (rebuild, markStale, syncStale, evictCache, rankSemantic). Only the **direct MiniSearch API calls** move out. This is the smallest refactor that introduces the seam.

### Fts5IndexStrategy (new, `packages/core/src/services/search/Fts5IndexStrategy.ts`)

> **Superseded in part by §PR-2 revision (2026-10-06).** Kept as the record.


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
| `replace(entityId, ids, docs)` | One immediate transaction: `DELETE FROM {prefix}entries_fts WHERE entity_id = ? AND id IN (?,?,…)` chunked to the `?` limit × 1 column for `ids`, then `INSERT INTO {prefix}entries_fts (id, entity_id, title, body, tags) VALUES (?,?,?,?,?)` per doc (chunked to `?`-limit × 5 columns). The DELETE is scoped by both `entity_id` and `id`, so a stale `id` from `SearchService` (no longer indexed, or indexed under another entity) is a no-op rather than a stray delete. FTS5 virtual tables have no primary key or UNIQUE constraint, so the DELETE-then-INSERT is what makes this an upsert. The strategy also adds `entityId` to its in-memory `indexedEntities` set. |
| `replaceEntity(entityId, docs)` | One immediate transaction: `DELETE FROM {prefix}entries_fts WHERE entity_id = ?`, then the same chunked inserts. Keyed by `entity_id` rather than a remembered id set, so rows for entries soft-deleted since the last sync are removed too: `findMiniSearchRows(entityId)` no longer returns them, so they are not re-inserted. The strategy also adds `entityId` to `indexedEntities`. |
| `replaceAll(docs)` | One immediate transaction: `DELETE FROM {prefix}entries_fts`, then the same chunked inserts. The strategy replaces `indexedEntities` with the union of `docs.map(d => d.entity_id)` (or clears it when `docs` is empty). |
| `search(query, opts)` | `SELECT id, bm25({prefix}entries_fts) AS score FROM {prefix}entries_fts WHERE {prefix}entries_fts MATCH ? AND entity_id IN (?,?,…) ORDER BY score ASC LIMIT ?`. bm25 returns negative values; lower (more negative) is better, so we sort ASC and flip the sign for the IndexSearchResult contract. |
| `hasIndexedEntity(entityId)` | Returns `indexedEntities.has(entityId)`. No SQL. |

FTS5 keeps a per-strategy in-memory `Set<string>` of entity ids only (not row ids). That is the only data structure required to answer `hasIndexedEntity` correctly under the new interface.

**Explicit indexing, no triggers.** The existing `SearchService` control model (read-then-write through `entryRepo.findMiniSearchRows[ByIds]`, which already filters `deleted_at IS NULL`) applies cleanly. We do not add `entries_ai/ad/au` — soft-delete and `valid_from`/`valid_to` lifecycle (migration v13) make trigger-based sync incorrect: a soft-delete row must leave the index, and the existing `findMiniSearchRows` already excludes it. Triggers would also fire on every ALTER/UPDATE that has nothing to do with text, multiplying writes.

**`search()` filters by `entity_id` via the `IN (?,?,…)` clause**, mirroring the current `filter: (r) => entityIdSet.has(r.entity_id)` predicate in MiniSearch. Multi-entity reads (the `string[]` overload of `WikiMemory.read`) work without per-entity partitioning.

**Score sign** — `bm25()` returns negative numbers; we negate them so the result is non-negative and higher-is-better, per the `IndexSearchResult` contract. `getKeywordScores` then applies the same `max(1, top)` scaling it applies to MiniSearch scores before the `weight * Math.max(0, cosSim) + (1 - weight) * kwScore` blend in `rankSemantic`. Negated FTS5 `bm25()` and MiniSearch BM25+ are on similar but not identical scales, so PR-2 must check that the hybrid blend and the keyword-fallback `factScores` stay comparable across strategies.

### Capability detection (`packages/core/src/services/search/createIndexStrategy.ts`)

> **Superseded in part by §PR-2 revision (2026-10-06).** Kept as the record.


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

> **Superseded in part by §PR-2 revision (2026-10-06).** Kept as the record.


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

## PR-2 revision (2026-10-06): durable change queue

This section supersedes the PR-2 parts of §Design (Fts5IndexStrategy, Capability detection, Migration v14) wherever they conflict. It was written after PR #258 merged, by checking those sections against the merged code. Four gaps meant shipping FTS5 as specified would not have fixed #257:

1. **Every open still read all text.** `WikiMemory.setup()` ends with `searchService.sync()` (`WikiMemory.ts:310`), which calls `findMiniSearchRows()` for every live row and passes them to `replaceAll`. A persistent FTS5 index would still cost O(DB) JS memory and time on every open, so the serve leg stayed unfixed.
2. **Every `upsertGraph` rebuilt the whole entity.** `upsertGraph` runs in the host's transaction and calls `markStale(entityId)` (`WikiMemory.ts:830`). The host's `syncSearchIndex(entityId)` then runs `rebuildIndex`, which reads the full entity into JS. SynapseTree builds through `upsertGraph`, so build time is quadratic and each step holds a full-entity array in memory, whichever backend is used.
3. **`hasIndexedEntity` lost its state on restart.** The FTS5 `indexedEntities` set lived in memory and was empty after every restart. Each entity's first sync therefore did the full rebuild from gap 2.
4. **Nothing healed the index after a crash.** MiniSearch rebuilds on every open, which quietly repairs any drift. FTS5 writes happen after the data commit, so a crash between the two left stale rows in the file that nothing would ever fix.

The spec also had two schema faults:

- **`UNINDEXED` columns cannot be looked up.** `DELETE … WHERE entity_id = ? AND id IN (…)` scans the whole FTS table, so each incremental write cost O(DB) and a build was quadratic again.
- **`entries.rowid` cannot key FTS rows either.** `entries` is a rowid table (`id TEXT PRIMARY KEY`), and core runs `VACUUM` (`MetadataRepository.ts:162`), which can renumber its rowids.

### Schema, owned by the strategy (no migration v14)

`Fts5IndexStrategy.init()` creates everything idempotently, and only when FTS5 is the active strategy. Migration v14 is dropped: `schema_version` advances whether or not the adapter has FTS5, so a database first opened on Expo would reach v14 without the table and never get it on a later Node open.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS {prefix}entries_fts USING fts5(
  id UNINDEXED, entity_id UNINDEXED, title, body, tags,
  tokenize = 'porter unicode61'
);

-- Stable id → FTS rowid. INTEGER PRIMARY KEY survives VACUUM;
-- UNIQUE(id) makes per-id lookups indexed.
CREATE TABLE IF NOT EXISTS {prefix}fts_map (
  fts_rowid INTEGER PRIMARY KEY,
  id        TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS {prefix}fts_map_entity ON {prefix}fts_map(entity_id);

-- Durable change ledger, fed by triggers inside whatever transaction
-- changed `entries`, host-owned transactions included.
CREATE TABLE IF NOT EXISTS {prefix}fts_pending (
  seq       INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL,
  id        TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS {prefix}entries_fts_ai AFTER INSERT ON {prefix}entries BEGIN
  INSERT INTO {prefix}fts_pending (entity_id, id) VALUES (NEW.entity_id, NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS {prefix}entries_fts_au
AFTER UPDATE OF id, entity_id, title, body, tags, deleted_at ON {prefix}entries BEGIN
  INSERT INTO {prefix}fts_pending (entity_id, id) VALUES (OLD.entity_id, OLD.id);
  INSERT INTO {prefix}fts_pending (entity_id, id)
    SELECT NEW.entity_id, NEW.id WHERE NEW.id <> OLD.id OR NEW.entity_id <> OLD.entity_id;
END;
CREATE TRIGGER IF NOT EXISTS {prefix}entries_fts_ad AFTER DELETE ON {prefix}entries BEGIN
  INSERT INTO {prefix}fts_pending (entity_id, id) VALUES (OLD.entity_id, OLD.id);
END;
```

Design notes:

- **The ledger is keyed per entry, not per entity.** Queuing whole entities would bring back gap 2.
- **There is no operation column.** The drain re-reads each queued id's live state (`deleted_at IS NULL`, the same predicate as `MINI_SEARCH_LIVE_WHERE`). Insert, update, soft-delete and hard delete all reduce to "re-derive this id". A duplicate `seq` row for the same id is harmless.
- **Triggers watch only the indexed columns.** `access_count`, `embedding_blob`, `valid_from`/`valid_to` and the other bookkeeping columns change often and never affect the keyword index, so they must not enqueue. The existing "no triggers" rule in §Fts5IndexStrategy was about triggers that write the *FTS table* directly. That rule still stands: these triggers write only to an ordinary ledger table, and liveness is decided at drain time.
- **Schema state lives in the meta key `fts5_index_state`**, which is `live` or `detached`.

### Drain: all SQL, in bounded chunks

`Fts5IndexStrategy.drain()` loops over chunks until `fts_pending` is empty. Each chunk runs in one `withTransactionAsync`:

```sql
-- :hi = SELECT max(seq) FROM (SELECT seq FROM {prefix}fts_pending ORDER BY seq LIMIT 500)
DELETE FROM {prefix}entries_fts WHERE rowid IN (
  SELECT m.fts_rowid FROM {prefix}fts_map m
  WHERE m.id IN (SELECT id FROM {prefix}fts_pending WHERE seq <= :hi));
DELETE FROM {prefix}fts_map
  WHERE id IN (SELECT id FROM {prefix}fts_pending WHERE seq <= :hi);
INSERT INTO {prefix}fts_map (id, entity_id)
  SELECT e.id, e.entity_id FROM {prefix}entries e
  WHERE e.id IN (SELECT id FROM {prefix}fts_pending WHERE seq <= :hi)
    AND e.deleted_at IS NULL;
INSERT INTO {prefix}entries_fts (rowid, id, entity_id, title, body, tags)
  SELECT m.fts_rowid, e.id, e.entity_id, e.title, e.body, {TAGS_EXPR}
  FROM {prefix}fts_map m JOIN {prefix}entries e ON e.id = m.id
  WHERE m.id IN (SELECT id FROM {prefix}fts_pending WHERE seq <= :hi);
DELETE FROM {prefix}fts_pending WHERE seq <= :hi;
```

```sql
-- {TAGS_EXPR}: the SQL twin of toIndexDoc's tags handling
CASE WHEN json_valid(e.tags) AND json_type(e.tags) = 'array'
     THEN (SELECT group_concat(value, ' ') FROM json_each(e.tags))
     ELSE e.tags END
```

- **No JS-side text.** Indexed text never crosses into JS, so memory is bounded by SQLite's page cache and FTS5's pending-terms buffer. Neither grows with database size.
- **Rowids come from `fts_map`.** It is inserted first so its `INTEGER PRIMARY KEY` mints the rowid, and the FTS row takes that rowid through the JOIN. No `RETURNING` is needed, which would require SQLite 3.35+. A rowid freed by the first `DELETE` can be reused in the same chunk without colliding, because its FTS row is already gone.
- **Atomicity is per statement and per chunk.** Every statement is atomic, so this supersedes the round-4 "one `INSERT` per doc" rule: a single `INSERT … SELECT` either applies fully or rolls back. Each chunk is atomic as well. A concurrent `search()` sees each chunk entirely or not at all, but may see the ledger partly drained. Every individual entry is always either fully old or fully new, which is the same guarantee incremental sync gives today.
- **The tags expression must match `toIndexDoc` token for token.** It need not match string for string: JSON `null` elements become `''` in JS and are skipped by `group_concat`, which tokenizes the same. A dedicated test compares FTS5 tokens for both paths over a fixture of edge cases: an empty array, nested arrays, non-string elements, malformed JSON and escaped characters.

### SearchService routing

`IndexStrategy` gains three optional members:

```ts
/** Create or verify backing schema and run state changes. Called once from setup(). */
init?(): Promise<void>;
/**
 * Apply every change recorded in the strategy's durable ledger. A strategy
 * that implements this keeps itself consistent with SQLite on its own:
 * SearchService routes every sync to drain() and never feeds it rows.
 */
drain?(): Promise<void>;
/** Rebuild from the source tables entirely in SQL (no rows through JS). */
rebuildFromSource?(): Promise<void>;
```

When `indexStrategy.drain` exists:

- `sync()`, `sync(entityId)`, `syncEntries(entityId, ids)` and `syncStale()` each queue one `drain()` on `syncChain`. They keep the never-reject and `evictCache` behaviour.
- `markStale` only tracks the vector cache. The triggers have already recorded the rows.
- `clearAll()` calls `replaceAll([])`. For FTS5 that empties `entries_fts`, `fts_map` and `fts_pending` in one transaction.

MiniSearch has no `drain` and keeps today's paths byte for byte.

Fts5IndexStrategy still implements the three required writes so the interface contract and its tests hold. They use indexed `fts_map` lookups: `replace` goes by `id`, `replaceEntity` by `entity_id`, and `replaceAll` truncates all three tables. That makes `replace` and `replaceEntity` O(touched rows), not O(DB). `hasIndexedEntity` returns `state === 'live'`.

### Strategy resolution and state changes

`WikiMemory`'s constructor keeps a `MiniSearchIndexStrategy` placeholder; before `setup()` that index is empty, exactly as today. `setup()` then does three things after migrations:

1. Resolve the strategy with `createIndexStrategy(db, prefix, metadataRepo, config.indexStrategy ?? 'auto')`.
2. Install it with `searchService.setIndexStrategy(strategy)`.
3. Call `searchService.sync()`, which for FTS5 is a drain, not a global read.

**Probing** uses `CREATE VIRTUAL TABLE temp.{prefix}fts5_probe USING fts5(x)` plus `SELECT json_valid('[]')`, then drops the probe. `temp.` keeps the probe out of the database file. `sqlite_compileoption_used('ENABLE_FTS5')` is not used: FTS5 can be present without the flag, loaded as an extension or built into a custom WASM. The drain needs json1, so a build without it falls back to MiniSearch.

State changes, run inside `init()` or `createIndexStrategy`:

| Resolved strategy | Stored state | Action |
|---|---|---|
| FTS5 | `live` and all three triggers present in `sqlite_master` | None. The drain catches up on whatever is pending. |
| FTS5 | `detached`, missing, or `live` with any trigger missing | One transaction: drop and recreate `entries_fts`, empty `fts_map` and `fts_pending`, run `rebuildFromSource()` (the two `INSERT … SELECT` statements above with no `IN` filter, over every live row), create the triggers, and set `live`. This is the only full rebuild. It runs once per change to FTS5 and holds the write lock for its whole duration. |
| MiniSearch | ledger triggers exist | Drop the three triggers, `fts_pending` and `fts_map`, then set `detached`. Try `DROP TABLE IF EXISTS {prefix}entries_fts` and ignore failure: without the fts5 module the virtual table cannot be dropped, and the next change to FTS5 recreates it anyway. |
| MiniSearch | `detached` or missing | None. |

Two cases fall out of these rules without special handling:

- **Expo without FTS5 opens a database still marked `live`.** Writes keep working, because the triggers write only to an ordinary table. In that case `createIndexStrategy` resolves MiniSearch and detaches; the next Node open finds `detached` and rebuilds.
- **An engine older than PR-2 writes to a `live` database.** The triggers still fire and the ledger grows. That engine never drains, so the next PR-2+ open drains the backlog.

### Search

```sql
SELECT f.id, f.entity_id,
       max(0.0, -bm25({prefix}entries_fts, 0.0, 0.0, 2.0, 1.0, 1.0)) AS score
FROM {prefix}entries_fts f
WHERE {prefix}entries_fts MATCH :q
  AND f.entity_id IN (SELECT value FROM json_each(:entityIds))
ORDER BY bm25({prefix}entries_fts, 0.0, 0.0, 2.0, 1.0, 1.0)
LIMIT :limit
```

- **Title weight 2.0** matches MiniSearch's `boost: { title: 2 }`. It ships in PR-2 rather than as follow-up tuning.
- **Entity filter.** `entityIds` is bound as one JSON parameter, so multi-entity reads never hit the `?` limit.
- **No-limit encoding.** `limit: Number.MAX_SAFE_INTEGER` (the full-scan hybrid path) binds as `-1`, which SQLite treats as no limit.
- **Building `:q`.** The query is split into `[\p{L}\p{N}]+` tokens (Unicode, case-folded), and each token becomes `"tok"*`, joined with ` OR `. This matches MiniSearch's `prefix: true` and its default OR combining, and it neutralizes FTS5 query syntax: quotes, `-`, `:`, `NEAR`, `AND`/`OR`/`NOT`, and parentheses. If no tokens remain, `search` returns `[]` without running SQL.
- **Known divergence:** MiniSearch's `fuzzy: 0.2` has no FTS5 equivalent. The retrieval-parity check measures how much this costs.
- **Stemming and prefixes:** a test asserts that a prefix query and a porter-stemmed index token match, for example `running` against a document containing `runs`. If they don't, the query builder emits `"tok"* OR "tok"` per token.

### Testing additions (beyond the parity check and the cross-adapter smoke test)

- **Build linearity.** N sequential `upsertGraph` + `syncSearchIndex(entityId)` calls into one entity. Assert that each drain touches only that call's ids, by counting `fts_pending` rows consumed. Assert that `findMiniSearchRows` is never called.
- **Crash and resume.** Commit `entries` writes, skip the drain, and close. Reopen and assert that `setup()` drains the backlog and that search returns the new rows. Assert that soft-deleted rows disappear.
- **Host transaction rollback.** `upsertGraph` inside a host transaction that rolls back leaves no ledger rows.
- **State changes.** `live` → pinned `minisearch` (`detached`, triggers gone) → `auto` (rebuilt, `live`). Also a `live` database with one trigger dropped by hand, which must rebuild.
- **`VACUUM` stability.** Index, run `metadataRepo.vacuum()`, update one entry, drain, and assert that exactly that entry's FTS row changed.
- **`toIndexDoc` and `{TAGS_EXPR}`** produce the same token stream on the edge-case fixture.
- **Query sanitizer.** Hostile inputs (`"`, `a -b`, `col:x`, `NEAR(`, `AND`, emoji, empty) never throw and return `[]` or matches.
- **Memory benchmark** (`packages/benchmarks`, run manually or nightly, not on every PR). Build a synthetic database of roughly 500 MiB through `upsertGraph` + `syncSearchIndex` with `indexStrategy: 'fts5'`, then reopen and run 1,000 queries. Report peak RSS for build and serve, and per-batch drain time. Pass if peak RSS stays below 512 MiB and drain time per batch does not trend upward. Both pass bars apply on a 2048 MiB Fargate task like the S5 gate's.

### Risks added by this revision

| Risk | Mitigation |
|---|---|
| Trigger write amplification on hot paths. | Triggers fire only on indexed-column updates, at one ledger row per change. `access_count` bumps on read do not fire them. |
| Keyword search lags writes until a drain. | Same contract as today. Core-owned writes already run `syncEntries` after commit, which drains. `upsertGraph` callers already must call `syncSearchIndex` after commit. |
| The first change to FTS5 on a multi-GB database holds the write lock for the whole rebuild. | It runs once per database. It is documented in the `indexStrategy` JSDoc and the CHANGELOG. SynapseTree builds new databases with `'fts5'` from the start, so no rebuild ever runs there. |
| The full-scan hybrid path (`getKeywordScores` with no `preFilterLimit`) materializes every keyword hit in JS. | The hit count is bounded by the entity's rows, and the same path already loads every candidate row for the vector scan, so this is no regression. That O(entity) vector scan is the next serve ceiling and is tracked separately with `sqlite-vec`. |

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
  - *(2026-10-06)* PR-2 ships the durable-ledger design in §PR-2 revision. The default flips to `'auto'` only once the parity check and the memory benchmark pass; until then hosts opt in with `'fts5'`. Title weighting ships in PR-2, so the follow-up covers only fuzzy-match parity and further bm25 tuning.

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