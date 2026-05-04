# Spec: Embedding-Based Retrieval

**Date:** 2026-05-03
**Status:** Draft
**Supersedes:** `2026-05-02-sqlite-wasm-fts5-web-adapter.md` (infeasible), `2026-05-03-minisearch-web-fallback.md` (superseded)

---

## Problem

Current retrieval is FTS5-based (lexical). FTS5 with BM25 and porter stemming fails on paraphrase, cross-language synonyms, and conceptual proximity — the dominant failure modes for RAG. A user prompt like "what should I do this weekend?" does not lexically match a fact titled "Saturday hiking trip" under any tokenizer or stemmer.

The web FTS5 problem (`expo-sqlite` ships without FTS5 on web) is a symptom. The root cause is that lexical search is the wrong retrieval mechanism for RAG in the first place.

The fix: vector embeddings via the caller's `LLMProvider.embed` stored as JSON blobs in SQLite, ranked by cosine similarity in JS. A MiniSearch in-memory index runs in parallel as a fallback for offline use or when `embed` is unavailable. No SQLite extensions, no WASM, no Workers. Identical behavior on native and web.

---

## Requirement

**Replace FTS5-based retrieval with embedding cosine-similarity search. When `embed` is unavailable or fails, silently fall back to MiniSearch keyword search and notify the consumer via `onRetrievalFallback`. All logic lives in `packages/core`. No platform-specific code.**

---

## Goals

- `read(entityId, query)` returns semantically relevant facts ranked by cosine similarity when `LLMProvider.embed` is provided and succeeds.
- When `embed` is absent or throws, `read()` falls back to MiniSearch keyword search and calls `onRetrievalFallback(error)` if provided.
- MiniSearch in-memory index maintained alongside embeddings; rebuilt after every mutation.
- `onRetrievalFallback` hook in `WikiOptions` lets consumers surface "offline / degraded" state without changing the `MemoryBundle` return type.
- Empty query always returns most-recent N facts regardless of embed or MiniSearch.
- `access_count` and `last_accessed_at` updated for all non-empty-query `read()` results.
- `runReembed(entityId?)` backfills embeddings after adding `embed` or changing models.
- Embedding dimension stored in `meta`; mismatch logs a warning, prompts consumer to call `runReembed()`.
- Works identically on iOS, Android, and web — no platform branches.

## Non-Goals

- FTS5 (removed entirely).
- LIKE-based search.
- Bundled ONNX or on-device embedding model.
- Multiple embeddings per fact.
- Cross-entity semantic search.
- Automatic re-embedding on model change (consumer calls `runReembed()`).
- MiniSearch as the primary retrieval path.

---

## Design

### 1. `LLMProvider.embed` — `packages/core/src/types.ts`

```typescript
export interface LLMProvider {
  generateText: (params: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /**
   * Optional. Enables semantic similarity search in `read()`.
   * Must return a stable-dimension float array for any input text.
   * Called once per fact on creation/update, and once per `read()` query.
   * When absent or throws, `read()` falls back to MiniSearch.
   */
  embed?: (text: string) => Promise<number[]>;
}
```

Text passed to `embed` for a fact: `"${fact.title} ${fact.body} ${fact.tags.join(' ')}"` — same fields previously indexed by FTS5.

### 2. `WikiOptions` — `packages/core/src/types.ts`

Add `onRetrievalFallback`:

```typescript
export interface WikiOptions {
  config?: WikiConfig;
  llmProvider: LLMProvider;
  /**
   * Called when `embed` throws during `read()` and MiniSearch is used instead.
   * Use to surface "offline / degraded search" state to the user.
   * `read()` still returns MiniSearch results — this is a notification, not an error path.
   */
  onRetrievalFallback?: (error: Error) => void;
}
```

### 3. `WikiConfig` changes — `packages/core/src/types.ts`

Rename `maxFtsResults` → `maxResults`. Keep `maxFtsResults` as a deprecated alias (implementation reads both; `maxResults` wins). Remove `synonymMap` — used only for FTS5 query expansion, no longer relevant.

```typescript
export interface WikiConfig {
  tablePrefix?: string;
  maxResults?: number;
  /** @deprecated Use maxResults */
  maxFtsResults?: number;
  pruneEventsAfter?: number;
  pruneRetainSoftDeletedFor?: number;
  autoLibrarianThreshold?: number;
  autoHealThreshold?: number;
  orphanAfterDays?: number | null;
  staleInferredAfterDays?: number | null;
  maxChunkLength?: number;
  chunkOverlap?: number;
  chunkConcurrency?: number;
}
```

### 4. Schema — `packages/core/src/db/schema.ts`

Remove FTS5 virtual table and all three sync triggers. Add `embedding TEXT` column:

```sql
CREATE TABLE IF NOT EXISTS ${prefix}entries (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL DEFAULT 'inferred',
  source_type TEXT NOT NULL DEFAULT 'agent_inferred',
  source_hash TEXT,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  embedding TEXT
);
```

All existing indexes remain. No FTS5 virtual table. No triggers.

### 5. Migration — `packages/core/src/db/migrations.ts`

Add migration version 2:

```typescript
{
  version: 2,
  description: 'Remove FTS5; add embedding column for semantic retrieval',
  run: async (db, prefix) => {
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        DROP TRIGGER IF EXISTS ${prefix}entries_ai;
        DROP TRIGGER IF EXISTS ${prefix}entries_ad;
        DROP TRIGGER IF EXISTS ${prefix}entries_au;
        DROP TABLE IF EXISTS ${prefix}entries_fts;
      `);
    });
    // ALTER TABLE outside transaction — not allowed alongside DROP in same
    // transaction on all SQLite platforms.
    const cols = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(${prefix}entries)`
    );
    if (!cols.some(c => c.name === 'embedding')) {
      await db.execAsync(`ALTER TABLE ${prefix}entries ADD COLUMN embedding TEXT`);
    }
  },
},
```

### 6. Cosine Similarity — `packages/core/src/utils/cosine.ts`

```typescript
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

At 1 536 dimensions, ~6 µs per comparison in V8. 1 000 facts → ~6 ms. Acceptable.

### 7. MiniSearch — dependency and configuration

Add `minisearch` as a direct dependency of `packages/core`:

```json
"dependencies": {
  "minisearch": "^7.0.0"
}
```

`WikiMemory` creates one `MiniSearch` instance at construction time:

```typescript
import MiniSearch from 'minisearch';

const miniSearch = new MiniSearch<{ id: string; entity_id: string; title: string; body: string; tags: string }>({
  fields: ['title', 'body', 'tags'],
  storeFields: ['entity_id'],
  searchOptions: {
    boost: { title: 2 },
    fuzzy: 0.2,
    prefix: true,
  },
});
```

Tags stored as space-joined string: `fact.tags.join(' ')`.

### 8. `rebuildMiniSearchIndex()` — private method on `WikiMemory`

Called after every mutation that changes facts. Loads all non-deleted entries from SQLite, replaces the index:

```typescript
private async rebuildMiniSearchIndex(): Promise<void> {
  const rows = await this.db.getAllAsync<{
    id: string; entity_id: string; title: string; body: string; tags: string;
  }>(`SELECT id, entity_id, title, body, tags FROM ${this.prefix}entries WHERE deleted_at IS NULL`);

  this.miniSearch.removeAll();
  this.miniSearch.addAll(rows.map(r => ({
    id: r.id,
    entity_id: r.entity_id,
    title: r.title,
    body: r.body,
    tags: typeof r.tags === 'string' ? JSON.parse(r.tags).join(' ') : r.tags,
  })));
}
```

Called after: `setup()`, `runLibrarian()`, `runHeal()`, `ingestDocument()`, `importDump()`, `forget()`, `runPrune()`.

Not called after `write()` — `write()` inserts events, not facts. If `write()` crosses the auto-librarian threshold, `runLibrarian()` fires and rebuilds the index after that.

### 9. `embedFact()` — private method on `WikiMemory`

Called after each fact upsert in `runLibrarian`, `runHeal`, `ingestDocument`, `importDump`:

```typescript
private async embedFact(fact: { id: string; title: string; body: string; tags: string | string[] }): Promise<void> {
  const embedFn = this.options.llmProvider.embed;
  if (!embedFn) return;
  const tags = Array.isArray(fact.tags) ? fact.tags.join(' ') : fact.tags;
  const text = `${fact.title} ${fact.body} ${tags}`.trim();
  try {
    const vector = await embedFn(text);
    await this.storeEmbeddingDimension(vector.length);
    await this.db.runAsync(
      `UPDATE ${this.prefix}entries SET embedding = ? WHERE id = ?`,
      [JSON.stringify(vector), fact.id]
    );
  } catch (err) {
    // Non-fatal. Fact is stored without embedding; read() falls back to MiniSearch.
    console.warn(`[WikiMemory] embedFact failed for ${fact.id}:`, err);
  }
}
```

`storeEmbeddingDimension(dim)` writes `embedding_dimension` to `meta` if not already set. If already set and `dim` differs: `console.warn('[WikiMemory] Embedding dimension mismatch: stored N, got M. Call runReembed() to rebuild.')`.

### 10. `read()` — `WikiMemory`

Primary path: cosine similarity. Fallback: MiniSearch. Both paths update `access_count`.

```typescript
async read(entityId: string, query: string): Promise<MemoryBundle> {
  const maxResults = this.options.config?.maxResults
    ?? this.options.config?.maxFtsResults
    ?? 10;
  const trimmedQuery = query.trim();

  let facts: WikiFact[];

  if (trimmedQuery) {
    const embedFn = this.options.llmProvider.embed;
    let usedEmbed = false;

    if (embedFn) {
      try {
        const queryVec = await embedFn(trimmedQuery);
        const rows = await this.db.getAllAsync<WikiFact & { embedding: string | null }>(
          `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
          [entityId]
        );
        const scored = rows.map(row => ({
          row,
          score: row.embedding ? cosineSimilarity(queryVec, JSON.parse(row.embedding)) : 0,
        }));
        scored.sort((a, b) => b.score - a.score);
        facts = scored.slice(0, maxResults).map(s => s.row);
        usedEmbed = true;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onRetrievalFallback?.(error);
      }
    }

    if (!usedEmbed) {
      // embed absent or threw — fall back to MiniSearch
      const results = this.miniSearch.search(trimmedQuery, {
        filter: r => r.entity_id === entityId,
        combineWith: 'OR',
      });
      const topIds = new Set(results.slice(0, maxResults).map(r => r.id));
      const allRows = await this.db.getAllAsync<WikiFact>(
        `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
        [entityId]
      );
      // Preserve MiniSearch rank order.
      const byId = new Map(allRows.map(r => [r.id, r]));
      facts = [...topIds].map(id => byId.get(id)).filter((f): f is WikiFact => f !== undefined);
    }

    // Update access tracking.
    if (facts.length > 0) {
      const ids = facts.map(f => f.id);
      const placeholders = ids.map(() => '?').join(',');
      const now = Date.now();
      await this.db.runAsync(
        `UPDATE ${this.prefix}entries
         SET access_count = access_count + 1, last_accessed_at = ?
         WHERE id IN (${placeholders})`,
        [now, ...ids]
      );
    }
  } else {
    // Empty query — recency order.
    facts = await this.db.getAllAsync<WikiFact>(
      `SELECT * FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT ?`,
      [entityId, maxResults]
    );
  }

  const [tasks, events] = await Promise.all([
    this.db.getAllAsync<WikiTask>(
      `SELECT * FROM ${this.prefix}tasks
       WHERE entity_id = ? AND status IN ('pending', 'in_progress') AND deleted_at IS NULL
       ORDER BY priority DESC, created_at ASC`,
      [entityId]
    ),
    this.db.getAllAsync<WikiEvent>(
      `SELECT * FROM ${this.prefix}events WHERE entity_id = ?
       ORDER BY created_at DESC LIMIT 10`,
      [entityId]
    ),
  ]);

  const parsedFacts = facts.map(f => ({
    ...f,
    tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags,
  }));

  return { facts: parsedFacts, tasks, events: events.reverse() };
}
```

Remove `formatSearchQuery()` entirely.

### 11. `setup()` — `WikiMemory`

After schema setup and migrations complete, call `rebuildMiniSearchIndex()` to populate the index from any existing entries.

### 12. `runReembed(entityId?)` — new public method

```typescript
async runReembed(entityId?: string): Promise<{ embedded: number; skipped: number }> {
  const embedFn = this.options.llmProvider.embed;
  if (!embedFn) return { embedded: 0, skipped: 0 };

  const where = entityId ? `entity_id = ? AND deleted_at IS NULL` : `deleted_at IS NULL`;
  const params = entityId ? [entityId] : [];
  const rows = await this.db.getAllAsync<WikiFact>(
    `SELECT * FROM ${this.prefix}entries WHERE ${where}`, params
  );

  let embedded = 0, skipped = 0;
  for (const row of rows) {
    try {
      await this.embedFact(row);
      embedded++;
    } catch {
      skipped++;
    }
  }
  return { embedded, skipped };
}
```

Add a `reembed` key to `activeMaintenanceJobs` to prevent concurrent runs.

### 13. Dimension Metadata

`meta` key: `embedding_dimension`. Set on first successful `embedFact()` call. Read in `storeEmbeddingDimension()` to detect model changes. No automatic invalidation — consumer calls `runReembed()`.

### 14. `importDump()` — embed on import

After each fact is inserted during `importDump()`, call `embedFact()` so imported facts are immediately searchable by cosine similarity. `embedFact()` is non-fatal on failure (see section 9). Call `rebuildMiniSearchIndex()` once after all facts are inserted (not per-fact).

---

## Retrieval Priority Summary

| Condition | Retrieval path |
|---|---|
| `query` empty | Recency order (SQL `ORDER BY updated_at DESC`) |
| `query` non-empty, `embed` provided, succeeds | Cosine similarity |
| `query` non-empty, `embed` provided, throws | MiniSearch + `onRetrievalFallback(error)` |
| `query` non-empty, `embed` absent | MiniSearch (no callback — not an error) |

---

## Package Ownership

| Package | Change |
|---|---|
| `packages/core` | All changes — `types.ts`, `db/schema.ts`, `db/migrations.ts`, `WikiMemory.ts`, new `utils/cosine.ts`; add `minisearch` dependency |
| `packages/expo` | None |
| `packages/react` | None |

---

## Breaking Changes

| Change | Impact |
|---|---|
| FTS5 schema dropped | Existing DBs migrated by migration 2; no data lost |
| `synonymMap` removed from `WikiConfig` | Compile-time error for callers using it; remove from call sites |
| `maxFtsResults` deprecated (not removed) | Continues to work; rename to `maxResults` at leisure |
| `read()` semantics when `embed` absent | Returns MiniSearch results instead of FTS5 results for non-empty query |

---

## Tests — `packages/core/__tests__`

### `embeddingRetrieval.test.ts`

- Non-empty query with `embed` provided: facts ranked by cosine similarity, not recency.
- Fact with highest semantic similarity appears first even if older.
- Empty query: most-recent-first regardless of `embed`.
- `embed` absent: falls back to MiniSearch; no `onRetrievalFallback` call (not an error).
- `embed` throws: falls back to MiniSearch; `onRetrievalFallback` called with the thrown error.
- `access_count` incremented for facts returned from non-empty query (both embed and MiniSearch paths).
- `access_count` not incremented for empty-query read.
- Facts without embeddings score 0 in cosine path; appear after embedded facts.

### `miniSearchFallback.test.ts`

- MiniSearch index populated after `setup()` with existing entries.
- After `ingestDocument()`, new facts appear in MiniSearch results.
- After `forget()`, forgotten fact absent from MiniSearch results.
- After `runLibrarian()`, new/changed facts searchable via MiniSearch.
- After `importDump()`, imported facts searchable via MiniSearch.
- `onRetrievalFallback` not called when `embed` is absent (expected degradation, not error).
- `onRetrievalFallback` called with correct error when `embed` throws.

### `runReembed.test.ts`

- Returns `{ embedded: 0, skipped: 0 }` when `embed` absent.
- Backfills `embedding` for all facts when called without `entityId`.
- Backfills only specified `entityId` facts when called with one.
- Deleted facts not reembedded.
- Returns correct `{ embedded, skipped }` counts.
- Concurrent `runReembed()` call throws `WikiBusyError`.

### `migration2.test.ts`

- DB at schema version 1 (FTS5 table + triggers present, no embedding column): after migration 2, FTS5 artifacts absent and `embedding` column exists.
- Fresh install: FTS5 absent, `embedding` present; migration 2 is idempotent.

### Existing Tests

- Remove all FTS5/`synonymMap`/`MATCH` assertions.
- Update `read()` expectations to cosine/MiniSearch paths.
- Tests that stub `llmProvider` must add `embed: undefined` or a mock embed function as appropriate.

---

## File Checklist

| File | Action |
|---|---|
| `packages/core/src/types.ts` | Add `embed?` to `LLMProvider`; add `onRetrievalFallback?` to `WikiOptions`; deprecate `maxFtsResults`; add `maxResults`; remove `synonymMap` |
| `packages/core/src/db/schema.ts` | Remove FTS5 DDL + triggers; add `embedding TEXT` column |
| `packages/core/src/db/migrations.ts` | Add migration 2 |
| `packages/core/src/utils/cosine.ts` | Create `cosineSimilarity` |
| `packages/core/src/WikiMemory.ts` | Remove `formatSearchQuery`; update `read()`; add `rebuildMiniSearchIndex()`, `embedFact()`, `storeEmbeddingDimension()`, `runReembed()`; call `rebuildMiniSearchIndex()` in `setup()` and after all fact-mutating methods; call `embedFact()` in `runLibrarian`, `runHeal`, `ingestDocument`, `importDump`; add `reembed` to `activeMaintenanceJobs` |
| `packages/core/package.json` | Add `minisearch` dependency |
| `packages/core/__tests__/embeddingRetrieval.test.ts` | Create |
| `packages/core/__tests__/miniSearchFallback.test.ts` | Create |
| `packages/core/__tests__/runReembed.test.ts` | Create |
| `packages/core/__tests__/migration2.test.ts` | Create |
| Existing `packages/core/__tests__/*.test.ts` | Update: remove FTS5/synonymMap assertions |
| `docs/superpowers/specs/2026-05-03-minisearch-web-fallback.md` | Already marked superseded |
| `README.md` | Update retrieval section: describe semantic search + MiniSearch fallback; remove FTS5 references |

---

## Open Questions

1. **`importDump()` embed cost** — embedding every imported fact inline may be slow for large dumps. If performance is a concern, add an `embedOnImport?: boolean` option to `WikiOptions` (default `true`). Deferred until profiling warrants it.

2. **MiniSearch index size** — grows with fact count. Document in README for large wikis. No mitigation in this spec.

3. **`runReembed()` concurrency key** — use `'reembed'` in `activeMaintenanceJobs`. Confirm this matches the `WikiBusyError` operation union type: add `'reembed'` to `'ingest' | 'librarian' | 'heal' | 'prune'`.
