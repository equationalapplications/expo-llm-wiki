# Spec: Retrieval Tuning — BLOB Storage, Two-Phase SELECT, Vector Cache, Pre-Filter, Hybrid Scoring, Per-Call Overrides

**Date:** 2026-05-04
**Status:** Draft
**Follows:** `2026-05-03-embedding-retrieval.md` (PR #11)

---

## Problem

PR #11 ships correct semantic retrieval but leaves five performance and accuracy gaps open:

1. **`SELECT *` loads all columns for all N facts on every `read()`** — body, tags, and `embedding` JSON (~15 KB at 1 536 dims) are fetched for every row even though only the top `maxResults` rows are returned. PR #11 reviewer flag: *"this query loads the embedding column for all facts on every read() call… can become very heavy (I/O + parsing) as fact counts grow."*
2. **JSON parse overhead on every read** — `JSON.parse()` called per row per query. 1 000 facts = 15 MB parsed per query even with BLOB storage on new rows (old TEXT rows still present until `runReembed()`).
3. **No vector cache** — parsed `Float32Array` vectors are discarded after each `read()` and re-parsed from storage on the next call.
4. **No scaling knob** — large wikis (500+ facts) have no way to limit the cosine candidate pool without reducing `maxResults`.
5. **Binary retrieval mode** — embed succeeds → pure semantic; embed fails → pure keyword. No middle ground for use cases that need a blend of exact terminology and conceptual meaning.

---

## Requirement

**Add five orthogonal retrieval improvements to `packages/core`: (1) BLOB embedding storage to eliminate JSON parse overhead, (2) two-phase SELECT in `read()` to avoid loading full row data for all N facts, (3) in-memory parsed vector cache to skip re-parsing on repeated reads, (4) `preFilterLimit` to cap the O(N) cosine scan via MiniSearch pre-filtering, (5) `hybridWeight` to blend semantic and keyword scores. Tunable at two levels: developers set defaults in `WikiConfig` at construction time; end users can override retrieval parameters per-call via a new `ReadOptions` argument on `read()`, enabling runtime controls such as a search settings dashboard. No platform-specific code.**

---

## Goals

- `embedFact()` stores embeddings as raw `Float32Array` bytes (`BLOB`) in a new `embedding_blob` column. Existing `embedding` TEXT rows remain readable until reembedded.
- `read()` cosine path uses a two-phase SELECT: phase 1 fetches only `id, embedding_blob, embedding, updated_at, access_count` for all N rows (scoring columns only); phase 2 fetches `SELECT * WHERE id IN (...)` for the top `maxResults` winners only.
- `WikiMemory` maintains an in-memory `Map<string, Float32Array>` vector cache per entity. Cache populated only on full-entity-scan cosine reads (no `preFilterLimit` active); invalidated on any fact mutation (librarian, heal, ingest, importDump, forget, prune, runReembed).
- `read()` prefers cache-hit vectors; falls back to parsing `embedding_blob` BLOB then `embedding` TEXT for misses.
- `runReembed()` converts all TEXT rows to BLOB and nullifies the TEXT column.
- `WikiConfig` gains two new optional fields: `preFilterLimit` and `hybridWeight`.
- `read()` gains an optional third parameter `options?: ReadOptions` that overrides `WikiConfig` values for that call. `WikiConfig` remains the default.
- When `preFilterLimit` is set, MiniSearch runs first and the cosine scan is limited to the top-K keyword candidates.
- When `hybridWeight` is set, cosine and MiniSearch scores are both computed, normalized to `[0, 1]`, and blended.
- When both are set, a single MiniSearch call serves both roles (no duplicate search).
- `hybridWeight` ignored when `embed` is absent or throws — MiniSearch fallback path unchanged. Setting `hybridWeight: 0` explicitly also skips `embed()` entirely; no `onRetrievalFallback` is called because no embed was attempted.
- `preFilterLimit` returning zero candidates yields an empty facts array with no access tracking update. When both `preFilterLimit` and `hybridWeight` are set and pre-filter returns zero candidates, hybrid scoring is also skipped.
- Values of `hybridWeight` outside `[0, 1]` are clamped silently.
- All existing retrieval behavior (empty-query recency order, access tracking, `onRetrievalFallback`) unchanged.

## Non-Goals

- Automatic BLOB backfill in migration (lazy via `runReembed()`).
- Dropping the `embedding` TEXT column (additive migration only; old Android SQLite may not support `DROP COLUMN`).
- Cross-entity retrieval.
- Automatic model-change re-embedding.
- Approximate nearest-neighbor indexing (HNSW, IVF, etc.).
- Bundled embedding model.

---

## Design

### 1. `ReadOptions` — `packages/core/src/types.ts`

New interface for per-call retrieval overrides:

```typescript
export interface ReadOptions {
  /**
   * Overrides WikiConfig.maxResults for this call.
   */
  maxResults?: number;
  /**
   * Overrides WikiConfig.preFilterLimit for this call.
   * undefined means use WikiConfig.preFilterLimit (or no pre-filter if also unset).
   * Pass null to explicitly disable a config-level preFilterLimit for a single call
   * (runs full cosine scan regardless of config).
   */
  preFilterLimit?: number | null;
  /**
   * Overrides WikiConfig.hybridWeight for this call.
   * Pass undefined to use the WikiConfig default.
   */
  hybridWeight?: number;
}
```

### 2. `WikiConfig` additions — `packages/core/src/types.ts`

```typescript
export interface WikiConfig {
  // ...existing fields unchanged...

  /**
   * Max MiniSearch candidates passed to cosine scoring.
   * When set, MiniSearch pre-filters before the cosine scan,
   * reducing O(N) to O(preFilterLimit). Facts with zero keyword
   * overlap with the query are excluded from cosine scoring.
   * Recommended for entities with >500 facts.
   * Only applies when embed is provided and succeeds.
   * Default: undefined (full scan, today's behavior).
   */
  preFilterLimit?: number;

  /**
   * Hybrid blend weight (0.0–1.0).
   * 0.0 = pure keyword (skips embed() entirely — no LLM API call; onRetrievalFallback not called).
   * 1.0 = pure semantic.
   * When set, cosine and MiniSearch BM25 scores are both computed,
   * normalized to [0,1], and blended:
   *   score = weight × semantic + (1 − weight) × keyword
   * Values outside [0,1] are clamped. Ignored when embed is absent or throws.
   * Default: undefined (pure semantic when embed provided).
   */
  hybridWeight?: number;
}
```

### 3. Schema — `packages/core/src/db/schema.ts`

Add `embedding_blob BLOB` to the entries table DDL alongside the existing `embedding TEXT` column:

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
  embedding TEXT,
  embedding_blob BLOB
);
```

### 4. Migration v3 — `packages/core/src/db/migrations.ts`

Additive only. No backfill — conversion is lazy via `embedFact()` / `runReembed()`.

```typescript
{
  version: 3,
  description: 'Add embedding_blob BLOB column for Float32Array vector storage',
  run: async (db, prefix) => {
    const cols = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(${prefix}entries)`
    );
    if (!cols.some(c => c.name === 'embedding_blob')) {
      await db.execAsync(
        `ALTER TABLE ${prefix}entries ADD COLUMN embedding_blob BLOB`
      );
    }
  },
},
```

### 5. `parseEmbedding()` — `packages/core/src/utils/embedding.ts`

New utility file:

```typescript
export function parseEmbedding(
  blob: Uint8Array | null | undefined,
  text: string | null | undefined
): Float32Array | null {
  if (blob && blob.byteLength > 0) {
    if (blob.byteLength % 4 !== 0) return null; // corrupt — not a valid Float32Array
    // Copy into a fresh ArrayBuffer — SQLite drivers (better-sqlite3, expo-sqlite) may
    // pool/reuse the underlying Buffer, which would silently corrupt cached vectors if
    // stored as a view. This also guarantees zero byteOffset regardless of driver.
    const copy = new ArrayBuffer(blob.byteLength);
    new Uint8Array(copy).set(blob);
    return new Float32Array(copy);
  }
  if (text) {
    try {
      const arr: number[] = JSON.parse(text);
      return new Float32Array(arr);
    } catch { return null; }
  }
  return null;
}
```

Returns `Float32Array | null` so cached vectors are stored and consumed without intermediate conversion. Corrupt BLOB (byteLength not divisible by 4) returns null → scores 0, consistent with PR #11 behavior for corrupt JSON. The `ArrayBuffer` copy in the BLOB path is mandatory: SQLite drivers (including `better-sqlite3`) return `Buffer` objects backed by pooled native memory that may be reused across queries. Storing a view into that buffer without copying would let a subsequent query overwrite the bytes, silently corrupting the vector cache. Spike confirmed `better-sqlite3` always returns `byteOffset === 0`, but the copy also removes that reliance on driver-specific behavior.

`parseEmbedding()` always prefers BLOB — BLOB rows are written by the current `embedFact()` and are assumed to match the active embedding model. TEXT rows are the pre-BLOB fallback; they are served until `runReembed()` converts them. Dimension mismatch detection in `read()` (PR #11 logic) fires before `parseEmbedding()` is called, so mixed-dimension data cannot silently produce incorrect cosine rankings.

`cosineSimilarity()` in `utils/cosine.ts` must accept `ArrayLike<number>` (covers both `Float32Array` and `number[]`) to avoid converting the cached `Float32Array` back to an array at the call site. Update signature: `function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number`. This widening is backward-compatible — all existing `number[]` call sites continue to compile and behave identically. Add a test asserting both `Float32Array` and `number[]` inputs produce identical results for the same vector data.

### 6. `embedFact()` — `WikiMemory`

Write `Float32Array` bytes to `embedding_blob`, clear `embedding` TEXT:

```typescript
const blob = new Uint8Array(new Float32Array(vector).buffer);
await this.db.runAsync(
  `UPDATE ${this.prefix}entries SET embedding_blob = ?, embedding = NULL WHERE id = ?`,
  [blob, fact.id]
);
```

`Float32Array → Uint8Array` conversion is bit-exact and platform-independent (IEEE 754). `storeEmbeddingDimension()` unchanged — still validates dimension against stored metadata.

### 7. In-Memory Vector Cache — `WikiMemory`

```typescript
private vectorCache: Map<string, Map<string, Float32Array>> = new Map();
// outer key: entityId; inner key: fact id; value: parsed Float32Array
```

**Population:** On each cosine-path `read()` without `preFilterLimit`, after phase 1 SELECT, populate the entity's inner map with parsed vectors for all rows returned. When `preFilterLimit` is active, the MiniSearch pre-filter produces a partial candidate set; cache is NOT populated from partial results to avoid incomplete cache state affecting subsequent full-scan reads. Existing cache entries are still used for cache hits. Rows with null/corrupt embeddings are not cached (they score 0 and can be retried cheaply).

**Cache hit:** If the entity's inner map exists, use cached vectors directly — skip BLOB/TEXT parse entirely.

**Invalidation:** Call `this.vectorCache.delete(entityId)` after any operation that mutates facts for that entity: `runLibrarian()`, `runHeal()`, `ingestDocument()`, `importDump()`, `forget()`, `runPrune()`, `runReembed()`. For operations that affect all entities (e.g., `importDump()` with multiple entities, global `runReembed()`), call `this.vectorCache.clear()`.

**Memory bound:** Cache is scoped to the `WikiMemory` instance lifetime. No eviction policy. Memory per entity ≈ `factCount × dims × 4 bytes` (e.g. 1 536-dim embeddings: 6 KB/fact; 10 000 facts = ~60 MB per entity). Applications managing very large multi-entity wikis should call `wiki.clearVectorCache()` to release memory when retrieval-heavy workloads finish (e.g. after a batch read job). `WikiMemory` exposes a public `clearVectorCache(): void` method for this purpose. LRU eviction is a future-spec concern.

```typescript
/** Releases all cached parsed vectors. Call after bulk read workloads on large wikis. */
public clearVectorCache(): void {
  this.vectorCache.clear();
}
```

### 8. `read()` Signature and Config Resolution — `WikiMemory`

Signature change (backwards-compatible):

```typescript
async read(entityId: string, query: string, options?: ReadOptions): Promise<MemoryBundle>
```

**Effective config resolution** (per-call wins):

```typescript
const maxResults = options?.maxResults ?? config?.maxResults ?? config?.maxFtsResults ?? 10;
// null = caller explicitly disabling a config-level preFilterLimit for this call
const effectivePreFilterLimit =
  options?.preFilterLimit === null
    ? undefined
    : (options?.preFilterLimit ?? config?.preFilterLimit);
const hybridWeight = options?.hybridWeight ?? config?.hybridWeight;
const weight = hybridWeight !== undefined
  ? Math.max(0, Math.min(1, hybridWeight))
  : undefined;

// Fast-path: if hybridWeight is explicitly 0, skip embed() and use MiniSearch-only path
const skipEmbed = weight === 0;
```

### 9. `read()` Implementation — Two-Phase SELECT and Cache Integration — `WikiMemory`

**Phase 1 SELECT (scoring columns only):**

```sql
SELECT id, embedding_blob, embedding, updated_at, access_count
FROM ${prefix}entries
WHERE entity_id = ? AND deleted_at IS NULL
```

Includes `updated_at` and `access_count` for deterministic tie-breaking when cosine scores are equal. Tie-break order: `score DESC, access_count DESC, updated_at DESC, id ASC`. The `id ASC` final tiebreaker ensures fully deterministic ordering even if two facts share identical score, access count, and timestamp.

Check vector cache first. For each row not in cache, parse via `parseEmbedding(blob, text)` and populate cache. Score all candidates. Sort by tie-break order above.

**Phase 2 SELECT (full row for winners only):**

```sql
SELECT * FROM ${prefix}entries
WHERE id IN (?, ?, ...) AND deleted_at IS NULL
```

Fetch only the top `maxResults` (or `preFilterLimit`-bounded) winner IDs. Strip `embedding_blob` and `embedding` before returning.

**Execution paths inside the embed branch:**

| `preFilterLimit` | `hybridWeight` | Phase 1 candidate source | Cache population |
|---|---|---|---|
| unset | unset | `SELECT id, embedding_blob, embedding, updated_at, access_count WHERE entity_id = ?` | Full entity scan → populate cache |
| set | unset | MiniSearch top-K IDs → `SELECT id, embedding_blob, embedding, updated_at, access_count WHERE id IN (...)` | Partial scan → reuse cache, do not populate |
| unset | set | `SELECT id, embedding_blob, embedding, updated_at, access_count WHERE entity_id = ?` + MiniSearch scores | Full entity scan → populate cache |
| set | set | MiniSearch top-K → `SELECT id, embedding_blob, embedding, updated_at, access_count WHERE id IN (...)` + scores | Partial scan → reuse cache, do not populate |
| any | `hybridWeight: 0` (after clamping) | MiniSearch only — embed skipped entirely; `preFilterLimit` ignored (`weight === 0` exits embed branch before pre-filter logic) | Not populated |

All four embed-branch paths share the same phase 2 (`SELECT * WHERE id IN (...)`).

**MiniSearch score normalization:** divide each score by `Math.max(1, results[0]?.score ?? 1)` to keep scores in `[0, 1]` and avoid divide-by-zero. Cosine scores clamped to `[0, 1]` via `Math.max(0, score)`.

**When `preFilterLimit` set and `hybridWeight` set:** one MiniSearch call produces both the candidate ID list and the keyword scores for blending. No duplicate search.

**When `preFilterLimit` returns 0 candidates:** `facts = []`, skip phase 2, skip access tracking update. When both `preFilterLimit` and `hybridWeight` are set, hybrid scoring is also skipped because there are no candidates.

**MiniSearch returning 0 results** is always a valid outcome, not an error. `facts = []`, no phase 2 SELECT, no access tracking update. `onRetrievalFallback` is not called.

**Access tracking** applies to all returned facts for non-empty queries, regardless of which path was used (cosine, hybrid, pre-filtered, or MiniSearch fallback). No special handling for pre-filtered results.

**Fast-path: `hybridWeight: 0.0`** — Skip `embed()` call entirely and use MiniSearch-only path (same as embed absent/threw). This avoids unnecessary LLM API cost when the caller explicitly requests pure keyword retrieval.

**MiniSearch fallback path** (embed absent or throws): unchanged from PR #11. `hybridWeight` and `preFilterLimit` have no effect on this path.

### 10. `runReembed()` — `WikiMemory`

After `embedFact()` succeeds (writes BLOB, clears TEXT), `runReembed()` implicitly converts all TEXT rows to BLOB as a side effect. No additional logic needed. Return type unchanged: `{ embedded: number; skipped: number }`.

### 11. Retrieval Priority Summary (updated)

| Condition | Retrieval path |
|---|---|
| `query` empty | Recency order (SQL `ORDER BY updated_at DESC`) |
| `query` non-empty, `embed` provided, succeeds, no knobs | Cosine similarity, full scan |
| `query` non-empty, `embed` provided, succeeds, `preFilterLimit` set | MiniSearch pre-filter → cosine on candidates |
| `query` non-empty, `embed` provided, succeeds, `hybridWeight` set | Full scan → cosine + MiniSearch blend |
| `query` non-empty, `embed` provided, succeeds, both set | MiniSearch pre-filter → cosine + blend |
| `query` non-empty, `embed` provided, throws | MiniSearch + `onRetrievalFallback(error)` |
| `query` non-empty, `embed` absent | MiniSearch (no callback) |
| `query` non-empty, `hybridWeight: 0` | MiniSearch (embed skipped, no callback) |

---

## Package Ownership

| Package | Change |
|---|---|
| `packages/core` | All changes — `types.ts`, `db/schema.ts`, `db/migrations.ts`, `WikiMemory.ts`, new `utils/embedding.ts`; no new dependencies |
| `packages/expo` | None |
| `packages/react` | None |

---

## Breaking Changes

None. All changes are additive:
- `read()` gains an optional third param — existing call sites unaffected.
- `WikiConfig` gains optional fields — existing configs unaffected.
- Migration v3 is additive (new column only).
- `embedding` TEXT column preserved — no data loss.
- `cosineSimilarity` signature widened from `number[]` to `ArrayLike<number>` — backward-compatible at all call sites; `number[]` is a valid `ArrayLike<number>`.

---

## Tests — `packages/core/__tests__`

### `blobEmbeddings.test.ts`

- `embedFact()` stores `Uint8Array` in `embedding_blob`, sets `embedding = NULL`
- `read()` parses BLOB correctly (round-trip: store vector → retrieve → compare)
- `read()` falls back to JSON TEXT for rows where `embedding_blob` is null
- Corrupt BLOB (wrong byte length) scores 0, does not abort retrieval
- Migration v3: `embedding_blob` column present; `embedding` column still present
- Migration v3 idempotency: running migrations twice does not error and does not add duplicate columns
- `runReembed()` converts TEXT rows to BLOB and nullifies `embedding`
- Buffer aliasing: mutate the underlying bytes of the `Buffer` returned by the SQLite adapter after `parseEmbedding()`, assert that the cached `Float32Array` values are unchanged (gates the copy-on-parse fix)

### `preFilterLimit.test.ts`

- Facts with keyword overlap returned; semantically-similar-only facts excluded when pre-filter active
- `preFilterLimit: 5` with 100 facts: at most 5 rows fetched from DB for cosine scoring
- Pre-filter returning 0 candidates → empty facts, no access tracking update
- `preFilterLimit < maxResults`: fewer than `maxResults` facts returned — by design, no error thrown
- Per-call `ReadOptions.preFilterLimit` overrides `WikiConfig.preFilterLimit`
- Per-call `ReadOptions.preFilterLimit: null` disables a config-level `preFilterLimit` for that call (full scan)
- Per-call `ReadOptions.preFilterLimit: undefined` falls back to WikiConfig default

### `hybridScoring.test.ts`

- `hybridWeight: 1.0` → ranking identical to pure semantic
- `hybridWeight: 0.0` → ranking identical to pure MiniSearch
- `hybridWeight: 0.5` → fact with balanced keyword + semantic score ranks above a pure-semantic fact
- `hybridWeight: 2.0` clamped to 1.0; `hybridWeight: -1.0` clamped to 0.0
- `hybridWeight` set but `embed` absent → MiniSearch fallback, no error, no `onRetrievalFallback` call
- `hybridWeight` + `preFilterLimit` together: single MiniSearch call (assert search called once)
- `hybridWeight: 0` + `preFilterLimit` set: `preFilterLimit` ignored, MiniSearch-only path used
- Per-call `ReadOptions.hybridWeight` overrides `WikiConfig.hybridWeight`
- `cosineSimilarity` accepts both `number[]` and `Float32Array` inputs and returns identical scores for the same vector data (non-breaking widening)

### `readOptions.test.ts`

- Per-call `maxResults` overrides WikiConfig
- Per-call `hybridWeight` overrides WikiConfig
- Per-call `preFilterLimit` overrides WikiConfig
- Per-call `preFilterLimit: null` disables config-level `preFilterLimit`
- Per-call `maxResults: 0` returns an empty facts array with no phase 2 SELECT
- All three overridden simultaneously
- Omitting `ReadOptions` entirely falls back to WikiConfig defaults
- `ReadOptions: {}` (empty object) falls back to WikiConfig defaults

### `vectorCache.test.ts`

- First full-scan `read()` populates cache for the entity
- Second `read()` reuses cached `Float32Array` vectors (mock `parseEmbedding` to assert parse count is 0 on second call)
- `read()` with `preFilterLimit` does not populate cache; subsequent full-scan read still parses from DB
- `forget()` invalidates entity cache; next `read()` re-parses from DB
- `runLibrarian()` invalidates entity cache
- `runHeal()` invalidates entity cache
- `ingestDocument()` invalidates entity cache
- `runPrune()` invalidates entity cache
- `runReembed()` invalidates entity cache
- Global `runReembed()` clears entire cache
- `clearVectorCache()` clears entire cache; subsequent `read()` re-parses from DB
- Corrupt/null embeddings (score 0) are not stored in cache

---

## File Checklist

| File | Action |
|---|---|
| `packages/core/src/types.ts` | Add `ReadOptions` interface (with `preFilterLimit?: number \| null`); add `preFilterLimit?` and `hybridWeight?` to `WikiConfig` |
| `packages/core/src/db/schema.ts` | Add `embedding_blob BLOB` column to entries DDL |
| `packages/core/src/db/migrations.ts` | Add migration v3 |
| `packages/core/src/utils/embedding.ts` | Create `parseEmbedding()` returning `Float32Array \| null` |
| `packages/core/src/utils/cosine.ts` | Update `cosineSimilarity` signature: `(a: ArrayLike<number>, b: ArrayLike<number>): number` |
| `packages/core/src/WikiMemory.ts` | Update `embedFact()` for BLOB write; update `read()` signature and logic with fast-path for `hybridWeight === 0`, `null` pre-filter escape hatch, full-entity-scan-only cache population, and explicit access tracking for all non-empty-query paths; add `clearVectorCache()` public method; add vector cache initialization and per-entity invalidation in `runLibrarian()`, `runHeal()`, `ingestDocument()`, `importDump()`, `forget()`, `runPrune()`, per-entity `runReembed()`; clear entire cache in global `runReembed()` and multi-entity `importDump()`; strip `embedding_blob` and `embedding` from returned facts in both `read()` and `_getFullBundle()`; update `runReembed()` SELECT to include `embedding_blob` |
| `packages/core/__tests__/blobEmbeddings.test.ts` | Create |
| `packages/core/__tests__/vectorCache.test.ts` | Create |
| `packages/core/__tests__/preFilterLimit.test.ts` | Create |
| `packages/core/__tests__/hybridScoring.test.ts` | Create |
| `packages/core/__tests__/readOptions.test.ts` | Create |

---

## Spiked Questions

All three open questions resolved by spike tests (2026-05-04).

1. **SQLite BLOB type compatibility — CLOSED.** `better-sqlite3` (test adapter) returns BLOB as `Buffer`, which is a subclass of `Uint8Array`. `byteOffset` is always 0. `new Float32Array(blob.buffer)` round-trips correctly without needing byteOffset. `parseEmbedding()` design confirmed correct. expo-sqlite returns `Uint8Array` directly — same API, same code path. No conditional handling needed.

2. **`preFilterLimit` interaction with `maxResults` — CLOSED.** If `preFilterLimit < maxResults`, fewer than `maxResults` facts may be returned. This is by design — the pre-filter bounds the candidate pool, not the result count. Document in JSDoc. No error thrown.

3. **MiniSearch BM25 score normalization — CLOSED.** BM25 scores confirmed to exceed 1.0 in practice (observed 3.36 for a repeated-term match). `Math.max(1, results[0]?.score ?? 1)` as denominator confirmed safe: normalizes to `[0, 1]`, handles empty results without divide-by-zero.
