# Spec: Retrieval Tuning — BLOB Storage, Pre-Filter, Hybrid Scoring, Per-Call Overrides

**Date:** 2026-05-04
**Status:** Draft
**Follows:** `2026-05-03-embedding-retrieval.md` (PR #11)

---

## Problem

PR #11 ships correct semantic retrieval but leaves three performance and accuracy gaps open:

1. **O(N) cosine scan with JSON parse overhead** — every `read()` call fetches all entity facts, parses each `embedding` JSON string into a JS array, then scores all N rows. At 1 536 dimensions a JSON array is ~15 KB; 1 000 facts = 15 MB parsed per query.
2. **No scaling knob** — large wikis (500+ facts) have no way to limit the cosine candidate pool without reducing `maxResults`.
3. **Binary retrieval mode** — embed succeeds → pure semantic; embed fails → pure keyword. No middle ground for use cases that need a blend of exact terminology and conceptual meaning.

---

## Requirement

**Add three orthogonal retrieval improvements to `packages/core`: (1) BLOB embedding storage to eliminate JSON parse overhead, (2) `preFilterLimit` to cap the O(N) cosine scan via MiniSearch pre-filtering, (3) `hybridWeight` to blend semantic and keyword scores. Tunable at two levels: developers set defaults in `WikiConfig` at construction time; end users can override any parameter per-call via a new `ReadOptions` argument on `read()`, enabling runtime controls such as a search settings dashboard. No platform-specific code.**

---

## Goals

- `embedFact()` stores embeddings as raw `Float32Array` bytes (`BLOB`) in a new `embedding_blob` column. Existing `embedding` TEXT rows remain readable until reembedded.
- `read()` prefers `embedding_blob`; falls back to parsing `embedding` TEXT for unconverted rows.
- `runReembed()` converts all TEXT rows to BLOB and nullifies the TEXT column.
- `WikiConfig` gains two new optional fields: `preFilterLimit` and `hybridWeight`.
- `read()` gains an optional third parameter `options?: ReadOptions` that overrides `WikiConfig` values for that call. `WikiConfig` remains the default.
- When `preFilterLimit` is set, MiniSearch runs first and the cosine scan is limited to the top-K keyword candidates.
- When `hybridWeight` is set, cosine and MiniSearch scores are both computed, normalized to `[0, 1]`, and blended.
- When both are set, a single MiniSearch call serves both roles (no duplicate search).
- `hybridWeight` ignored when `embed` is absent or throws — MiniSearch fallback path unchanged.
- `preFilterLimit` returning zero candidates yields an empty facts array with no access tracking update.
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
   * To disable a config-level preFilterLimit for a single call, pass a very large
   * number (e.g. Infinity) — the MiniSearch result set is naturally bounded.
   */
  preFilterLimit?: number;
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
   * 0.0 = pure keyword, 1.0 = pure semantic.
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
): number[] | null {
  if (blob && blob.byteLength > 0) {
    if (blob.byteLength % 4 !== 0) return null; // corrupt — not a valid Float32Array
    return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
  }
  if (text) {
    try { return JSON.parse(text); } catch { return null; }
  }
  return null;
}
```

Corrupt BLOB (byteLength not divisible by 4) returns null → scores 0, consistent with PR #11 behavior for corrupt JSON.

### 6. `embedFact()` — `WikiMemory`

Write `Float32Array` bytes to `embedding_blob`, clear `embedding` TEXT:

```typescript
const blob = new Uint8Array(new Float32Array(vector).buffer);
await this.db.runAsync(
  `UPDATE ${this.prefix}entries SET embedding_blob = ?, embedding = NULL WHERE id = ?`,
  [blob, fact.id]
);
```

`storeEmbeddingDimension()` unchanged — still validates dimension against stored metadata.

### 7. `read()` — `WikiMemory`

Signature change (backwards-compatible):

```typescript
async read(entityId: string, query: string, options?: ReadOptions): Promise<MemoryBundle>
```

**Effective config resolution** (per-call wins):

```typescript
const maxResults = options?.maxResults ?? config?.maxResults ?? config?.maxFtsResults ?? 10;
const preFilterLimit = options?.preFilterLimit ?? config?.preFilterLimit;
const hybridWeight = options?.hybridWeight ?? config?.hybridWeight;
const weight = hybridWeight !== undefined
  ? Math.max(0, Math.min(1, hybridWeight))
  : undefined;
```

**Execution paths inside the embed branch:**

| `preFilterLimit` | `hybridWeight` | Behavior |
|---|---|---|
| unset | unset | Full scan → cosine sort (today's behavior) |
| set | unset | MiniSearch top-K IDs → fetch by ID → cosine sort |
| unset | set | Full scan + MiniSearch scores → normalize → blend |
| set | set | MiniSearch top-K → fetch by ID → cosine + blend (single MiniSearch call) |

**MiniSearch score normalization:** divide each score by `results[0].score` (MiniSearch returns sorted descending). If `results` is empty, all keyword scores are 0. To avoid divide-by-zero, use `Math.max(1, results[0].score)` as denominator. Cosine scores clamped to `[0, 1]` via `Math.max(0, score)`.

**When `preFilterLimit` set and `hybridWeight` set:** one MiniSearch call produces both the candidate ID list and the keyword scores for blending. No duplicate search.

**When `preFilterLimit` returns 0 candidates:** `facts = []`, skip cosine scoring, skip access tracking update.

**Stripping internal columns:** `embedding_blob` and `embedding` stripped from returned `WikiFact` objects before returning (same pattern as PR #11 strips `embedding`).

**MiniSearch fallback path** (embed absent or throws): unchanged from PR #11. `hybridWeight` and `preFilterLimit` have no effect on this path.

### 8. `runReembed()` — `WikiMemory`

After `embedFact()` succeeds (writes BLOB, clears TEXT), `runReembed()` implicitly converts all TEXT rows to BLOB as a side effect. No additional logic needed. Return type unchanged: `{ embedded: number; skipped: number }`.

### 9. Retrieval Priority Summary (updated)

| Condition | Retrieval path |
|---|---|
| `query` empty | Recency order (SQL `ORDER BY updated_at DESC`) |
| `query` non-empty, `embed` provided, succeeds, no knobs | Cosine similarity, full scan |
| `query` non-empty, `embed` provided, succeeds, `preFilterLimit` set | MiniSearch pre-filter → cosine on candidates |
| `query` non-empty, `embed` provided, succeeds, `hybridWeight` set | Full scan → cosine + MiniSearch blend |
| `query` non-empty, `embed` provided, succeeds, both set | MiniSearch pre-filter → cosine + blend |
| `query` non-empty, `embed` provided, throws | MiniSearch + `onRetrievalFallback(error)` |
| `query` non-empty, `embed` absent | MiniSearch (no callback) |

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

---

## Tests — `packages/core/__tests__`

### `blobEmbeddings.test.ts`

- `embedFact()` stores `Uint8Array` in `embedding_blob`, sets `embedding = NULL`
- `read()` parses BLOB correctly (round-trip: store vector → retrieve → compare)
- `read()` falls back to JSON TEXT for rows where `embedding_blob` is null
- Corrupt BLOB (wrong byte length) scores 0, does not abort retrieval
- Migration v3: `embedding_blob` column present; `embedding` column still present
- `runReembed()` converts TEXT rows to BLOB and nullifies `embedding`

### `preFilterLimit.test.ts`

- Facts with keyword overlap returned; semantically-similar-only facts excluded when pre-filter active
- `preFilterLimit: 5` with 100 facts: at most 5 rows fetched from DB for cosine scoring
- Pre-filter returning 0 candidates → empty facts, no access tracking update
- Per-call `ReadOptions.preFilterLimit` overrides `WikiConfig.preFilterLimit`
- Per-call `ReadOptions.preFilterLimit: undefined` falls back to WikiConfig default

### `hybridScoring.test.ts`

- `hybridWeight: 1.0` → ranking identical to pure semantic
- `hybridWeight: 0.0` → ranking identical to pure MiniSearch
- `hybridWeight: 0.5` → fact with balanced keyword + semantic score ranks above a pure-semantic fact
- `hybridWeight: 2.0` clamped to 1.0; `hybridWeight: -1.0` clamped to 0.0
- `hybridWeight` set but `embed` absent → MiniSearch fallback, no error, no `onRetrievalFallback` call
- `hybridWeight` + `preFilterLimit` together: single MiniSearch call (assert search called once)
- Per-call `ReadOptions.hybridWeight` overrides `WikiConfig.hybridWeight`

### `readOptions.test.ts`

- Per-call `maxResults` overrides WikiConfig
- Per-call `hybridWeight` overrides WikiConfig
- Per-call `preFilterLimit` overrides WikiConfig
- All three overridden simultaneously
- Omitting `ReadOptions` entirely falls back to WikiConfig defaults
- `ReadOptions: {}` (empty object) falls back to WikiConfig defaults

---

## File Checklist

| File | Action |
|---|---|
| `packages/core/src/types.ts` | Add `ReadOptions` interface; add `preFilterLimit?` and `hybridWeight?` to `WikiConfig` |
| `packages/core/src/db/schema.ts` | Add `embedding_blob BLOB` column to entries DDL |
| `packages/core/src/db/migrations.ts` | Add migration v3 |
| `packages/core/src/utils/embedding.ts` | Create `parseEmbedding()` |
| `packages/core/src/WikiMemory.ts` | Update `embedFact()` for BLOB write; update `read()` signature and logic; update `runReembed()` SELECT to include `embedding_blob`; strip `embedding_blob` from returned facts |
| `packages/core/__tests__/blobEmbeddings.test.ts` | Create |
| `packages/core/__tests__/preFilterLimit.test.ts` | Create |
| `packages/core/__tests__/hybridScoring.test.ts` | Create |
| `packages/core/__tests__/readOptions.test.ts` | Create |

---

## Spiked Questions

All three open questions resolved by spike tests (2026-05-04).

1. **SQLite BLOB type compatibility — CLOSED.** `better-sqlite3` (test adapter) returns BLOB as `Buffer`, which is a subclass of `Uint8Array`. `byteOffset` is always 0. `new Float32Array(blob.buffer)` round-trips correctly without needing byteOffset. `parseEmbedding()` design confirmed correct. expo-sqlite returns `Uint8Array` directly — same API, same code path. No conditional handling needed.

2. **`preFilterLimit` interaction with `maxResults` — CLOSED.** If `preFilterLimit < maxResults`, fewer than `maxResults` facts may be returned. This is by design — the pre-filter bounds the candidate pool, not the result count. Document in JSDoc. No error thrown.

3. **MiniSearch BM25 score normalization — CLOSED.** BM25 scores confirmed to exceed 1.0 in practice (observed 3.36 for a repeated-term match). `Math.max(1, results[0]?.score ?? 1)` as denominator confirmed safe: normalizes to `[0, 1]`, handles empty results without divide-by-zero.
