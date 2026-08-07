# Spec: Source-Ref Lifecycle, Duplicate Detection, and Batched Change Check

**Date:** 2026-08-07
**Status:** Draft
**Issue:** [#74](https://github.com/equationalapplications/expo-llm-wiki/issues/74)
**Packages:** `@eq/wiki-core`

---

## Problem

The library models a document as an opaque caller-supplied identity (`source_ref` + `source_hash`) and offers no lifecycle API over the set of documents an entity currently holds. Three gaps surfaced together while fixing one defect — the same document present at two inbox paths, ingested twice, producing duplicate facts that a contradiction detector then surfaced as contradictions of themselves:

1. **No enumeration, no dry-run.** `forget` is the only retirement primitive. Hosts that want to reconcile stored state against a live source have to read the library's own schema. `forget` returns `{ deleted: { entries, tasks } }` *after* deleting, with no way to preview the blast radius.
2. **No content identity.** Two `source_ref`s carrying the same `source_hash` are ingested without comment — double facts, double embeddings, and contradictions of themselves.
3. **`hasChanged` is per-document.** Hosts that need a whole-corpus decision before ingesting anything have to build their own two-phase planner.

---

## Solution

Three additions to the public `WikiMemory` API, all additive. No schema migration. No new outbox event type.

| Section | Public API |
| --- | --- |
| §1 | `listSourceRefs(entityId)`; `forget(entityId, params, { dryRun: true })` |
| §2 | `findSourceRefsByHash(entityId, sourceHash)`; `ingestDocument(entityId, params, { onDuplicateHash: 'ingest' \| 'skip' \| 'throw' })` |
| §3 | `hasChanged` overloaded to accept `Array<{ sourceRef; sourceHash }>` |

### Canonical-Selection Rule

(Used by §2 and §3.) When multiple `source_ref`s in one entity share a `source_hash`, the canonical is the **code-unit-minimum** of the set, ordered by `source_ref COLLATE BINARY`. Locale-dependent comparison (`localeCompare`, ICU) is explicitly rejected — a canonical choice that varies by environment re-mints identity on every deploy, which is the original bug with extra steps.

---

## §1. Enumeration & dry-run

### `WikiMemory.listSourceRefs(entityId)`

```ts
interface StoredSourceRef {
  sourceRef: string;
  sourceHash: string | null; // legacy rows and any path that inserts null hashes
  factCount: number;         // COUNT(*) over live facts only
  lastIngestedAt: number;    // MAX(updated_at), epoch ms
}

listSourceRefs(entityId: string): Promise<StoredSourceRef[]>;
```

Single SQL aggregation against `${prefix}entries`, scoped to `entity_id`, live only, partitioned by `source_ref`. The `source_hash` returned for each ref is the hash from the row with `MAX(updated_at)`, matching single-doc `hasChanged` / `findLatestSourceHash` semantics — **not** the lexicographically maximum hash. `MAX(source_hash)` is wrong because aggregation is computed independently across grouped rows; the hash and the timestamp can come from different rows. This matters under the import-path anomaly where one ref can have multiple live rows with different hashes.

```sql
WITH ranked AS (
  SELECT source_ref, source_hash, updated_at,
         ROW_NUMBER() OVER (
           PARTITION BY source_ref
           ORDER BY updated_at DESC
         ) AS rn,
         COUNT(*) OVER (PARTITION BY source_ref) AS fact_count
  FROM ${prefix}entries
  WHERE entity_id = ? AND deleted_at IS NULL AND source_ref IS NOT NULL
)
SELECT source_ref,
       source_hash       AS source_hash,
       fact_count        AS fact_count,
       updated_at        AS last_ingested_at
FROM ranked
WHERE rn = 1
ORDER BY source_ref COLLATE BINARY
```

`ROW_NUMBER()` (not `RANK()` or `DENSE_RANK()`) — tie-break by `ROWID` is implicit, but deterministic for our purposes — the spec never queries under a `MAX(updated_at)` tie. `COLLATE BINARY` on the outer `ORDER BY` is the explicit signal that locale dependency is rejected.

**Cross-method consistency:** a regression test asserts that for any `(entityId, sourceRef)`, `listSourceRefs(entityId)[i].sourceHash === (await findLatestSourceHash(entityId, sourceRef))`. This catches the exact bug `MAX(source_hash)` would introduce.

**Repository placement:** new `EntryRepository.listSourceRefs(entityId, tx?)`.

### `forget(entityId, params, { dryRun: true })`

Same `params` shape as today; the third positional `opts` argument is new:

```ts
interface ForgetOptions {
  dryRun?: boolean;
}

interface ForgetResponse {
  deleted: { entries: number; tasks: number };
  /** True when the metadata checkpoint (memory: 0, heal: 0) was — or, under dryRun, would be — reset. Surfaced so hosts can observe the side-effect rather than be surprised by it; pretending it doesn't happen is the kind of lie that bites six months later. The real call's return type is widened to match, so both real `forget` and dry-run return the same shape. */
  metadataReset?: boolean;
}
```

**Dry-run mechanics:** when `dryRun === true`:

1. **Skip `jobManager.acquireLock('forget', entityId)`.** Dry-run is read-only.
2. **Read outside any `withTransactionAsync`.** Dry-run counts being off-by-N during a concurrent real forget is acceptable.
3. **Run queries** against the live state:
   - *Standard case:* `findIdsBySource(entityId, sourceRef, sourceHash, includeDeleted=false).length` for `entries`, and the equivalent `TaskRepository` count for `tasks`.
   - *`clearAll` case:* If `clearAll: true` is passed, calculate counts using `findIdsBySource(entityId, null, null)` (or its non-tx equivalent). Returns `{ deleted: { entries, tasks }, metadataReset: true }`. The real call's return type is widened to match, returning `metadataReset: true` when a checkpoint reset actually occurs.
   - *Unknown-ref case:* Returns `{ deleted: { entries: 0, tasks: 0 } }`.
4. **Return `ForgetResponse`** — the same shape for real `forget` and dry-run. No fact IDs in the payload (see "Future extension" below).
5. **Stage no outbox events. Fire no embedding hooks.**

**Documented contract:** dry-run is non-transactional, lock-free, approximate during concurrent mutation. Real `forget` continues to acquire the lock, run in a transaction, stage outbox events, and fire embedding hooks. Hosts that need commit-time guarantees must re-query after the real `forget` returns — the dry-run count is point-in-time and may differ from the actual deleted count under concurrent mutation.

**Future extension (reserved):** if a host's preflight needs the would-be-deleted fact IDs (e.g. to surface a list of human-readable titles in an operator UI), that is a backwards-compatible addition to the dry-run payload. Not implemented in this spec; documented here so it's not silently closed off.

---

## §2. Duplicate-hash detection

Two surfaces — a query so hosts can audit, a guard so hosts can declare a policy.

### Query: `WikiMemory.findSourceRefsByHash(entityId, sourceHash)`

```ts
findSourceRefsByHash(entityId: string, sourceHash: string): Promise<string[]>;
```

Returns live `source_ref`s for that hash, sorted `COLLATE BINARY` ascending. First element is the canonical per the rule above. Empty array when no live row holds the hash.

### Ingest guard: `WikiMemory.ingestDocument(entityId, params, { onDuplicateHash })`

Second argument position 2 is the existing `params` bag; position 3 is the new options bag:

```ts
interface IngestDocumentOptions {
  /** Default 'ingest' — preserves current behavior for existing callers. */
  onDuplicateHash?: 'ingest' | 'skip' | 'throw';
}
```

**Guard firing rule.** Runs in `IngestionService.ingestDocument` *before* `jobManager.acquireLock('ingest', …)` — before the LLM call, before chunking, before any DB write. The check is a single `findSourceRefsByHash` call against live rows. The guard fires when **all** of:

- same `entity_id`
- a *different* `source_ref` from the incoming one (same `source_ref` is `hasChanged`'s upstream concern)
- same `source_hash`
- against a live (non-soft-deleted) row

When the guard fires, `duplicateOf` reports the canonical `source_ref` under the [see Canonical-Selection Rule](#canonical-selection-rule).

*Note on concurrency:* `duplicateOf` reflects state at *guard-time*, not *commit-time*. Between guard and lock, a concurrent ingest could alter the state. For moment-of-commit guarantees, re-query via `findSourceRefsByHash` after ingest.

**Behavior per mode:**

| `onDuplicateHash` | Guard fires? | Action |
| --- | --- | --- |
| `'ingest'` (default) | yes | log/ignore; proceed with normal ingest. **Note:** To detect silent duplicates from ingest (not prevent them), use the batched `hasChanged` (§3); the guard here only blocks or throws when explicitly opted in. |
| `'skip'` | yes | return `{ truncated: false, chunks: 0, duplicateOf: <canonical> }` immediately, no LLM, no DB write |
| `'throw'` | yes | throw `WikiDuplicateHashError` carrying `{ canonical, sourceHash, entityId }` |

`'skip'` is genuinely free: zero LLM calls, zero ingest-lock acquisitions, zero DB writes, zero outbox events.

*Additive return type:* adding `duplicateOf` to the `ingestDocument` return object widens the return type. Existing strict destructure-only callers are unaffected.

### `WikiDuplicateHashError`

New class exported from `packages/core/src/types.ts`, extending `Error`. `WikiBusyError` is the existing pattern for "another op holds the resource" — `WikiDuplicateHashError` is its analog for "another ref holds the content." Mirrors `WikiBusyError`'s public shape — typed error with the canonical `sourceRef` accessible as a property, not stuffed into the message string.

```ts
export class WikiDuplicateHashError extends Error {
  readonly canonical: string;
  readonly sourceHash: string;
  readonly entityId: string;
  constructor(params: { canonical: string; sourceHash: string; entityId: string }) {
    super(`Duplicate source hash for entity ${params.entityId}: canonical ${params.canonical}`);
    this.name = 'WikiDuplicateHashError';
    this.canonical = params.canonical;
    this.sourceHash = params.sourceHash;
    this.entityId = params.entityId;
  }
}
```

---

## §3. Batched `hasChanged`

Overload, not replacement:

```ts
// Existing
hasChanged(entityId: string, sourceRef: string, sourceHash: string): Promise<boolean>;
// New
hasChanged(
  entityId: string,
  entries: Array<{ sourceRef: string; sourceHash: string }>,
): Promise<Array<{ sourceRef: string; changed: boolean; duplicateOf?: string }>>;
```

Dispatch is by second argument type — `string` is the old path, `Array<…>` is the new. A separate method would force every host to migrate; the two paths share the bulk of their implementation.

**Result ordering:** in the same order as `entries`.

**Per-entry semantics:**

- `changed: true` if no live row exists for `(entity_id, source_ref)`, **or** if the latest live `source_hash` differs from the supplied one. Same rule as today's per-document `hasChanged`.
- `duplicateOf?: string` populated only when **a different `source_ref`** in this entity already holds the supplied hash against a live row. This is the §2 guard's "would have fired" condition; uses the same [see Canonical-Selection Rule](#canonical-selection-rule).
- When `duplicateOf` is set, `changed` reflects only the same-ref diff — the cross-ref collision is reported separately. Both signals can fire on the same input (`changed: true && duplicateOf: 'd-other…'`), or either alone.

### Multi-live-hash invariant

The batched implementation **must match single-doc semantics in both states**: when multiple live hashes exist for a ref (via import), return the most-recently-updated one. Adding a new SQL path that returns a different hash than the existing single-doc call would silently regress cross-entity hosts that mix the two.

Verified against the code:

1. **Normal ingest path** (`IngestionService.ts:108-110`): `softDeleteBySource(entityId, tx, sourceRef, null)` runs before the new `sourceHash`'s facts are inserted, all in one transaction. After commit, all live rows for `(entity_id, source_ref)` share one `source_hash`. Steady state.
2. **Import path** (`ImportExportService.ts:283`): `upsertForImport` is keyed on fact ID, not on `(entity_id, source_ref, source_hash)`. An import bundle can contain multiple historical ingests for the same `source_ref` with different hashes; live state can have multiple hashes per ref under this path.
3. **Single-doc `hasChanged`** uses `findLatestSourceHash` (`EntryRepository.ts:822-832`): `MAX(updated_at) DESC LIMIT 1` against live rows. Returns one hash per ref even if multiple exist.

### Implementation

Repository method:

```ts
EntryRepository.findLatestSourceHashes(
  entityId: string,
  sourceRefs: readonly string[],
  tx?: SQLiteAdapter,
): Promise<Map<string, string | null>>;
```

Returns a `Map<sourceRef, latestHash | null>` covering every requested ref (missing refs map to `null` — same as `findLatestSourceHash` returning `null` for unknown refs). One SQL query, not N round-trips.

```sql
-- ANTI-PATTERN WARNING: do not use MAX(source_hash).
-- The reported hash MUST come from the same row that wins ORDER BY updated_at DESC LIMIT 1.
-- Aggregating source_hash separately from updated_at is incorrect under multi-live-hash
-- (see d6bc3c9: the SQL fix that tightened listSourceRefs for this same reason).
WITH ranked AS (
  SELECT source_ref, source_hash,
         ROW_NUMBER() OVER (
           PARTITION BY source_ref
           ORDER BY updated_at DESC
         ) AS rn
  FROM ${prefix}entries
  WHERE entity_id = ? AND source_ref IN (${placeholders}) AND deleted_at IS NULL
)
SELECT source_ref, source_hash
FROM ranked
WHERE rn = 1;
```

**Empty-input edge cases (early returns):**

- `hasChanged(entityId, [])` returns `[]` with zero SQL calls.
- `findLatestSourceHashes(entityId, [])` returns `new Map()` with zero SQL calls.

**Efficiency bound:** one `findLatestSourceHashes` call to resolve per-ref latest hashes, plus one `findSourceRefsByHash` call per *distinct* input hash. Bound: at most `1 + H` SQL queries, where `H = number of distinct input hashes`. This improves performance only when duplicates exist; for all-unique corpora, overhead degenerates to `N + 1` queries.

For the batched `hasChanged` flow:

1. One `findLatestSourceHashes` call to resolve per-ref latest hashes.
2. Dedup input hashes; for each **distinct** input hash, one `findSourceRefsByHash` call to determine cross-ref collisions.
3. For each input entry, compute:
   - `changed = latestHash === null || latestHash !== input.sourceHash`
   - `duplicateOf = (existing hash collisions includes a ref other than this one) ? canonical : undefined`

A regression test asserts the batched and original signatures return equivalent results for the same input — protects against the overload diverging.

---

## Cross-cutting

**Backwards compatibility:** §1's `forget` opts bag and §2's `ingestDocument` opts bag are both additive — existing positional callers continue to work unchanged. §3 is an overload, not a rename. §1's `listSourceRefs` and §2's `findSourceRefsByHash` are net-new methods.

**Public-surface ownership:** hosts migrating off direct-schema access must use the `WikiMemory` facade; `EntryRepository` methods remain internal to the library. The repository methods named in `Files Affected` exist to satisfy the implementation; they are not part of the public API surface.

**Outbox events:** unchanged. §1 dry-run emits no events (no writes). §2 guard in `'skip'` and `'throw'` paths emits no events (no writes). §3 emits nothing (read-only).

**Locking:** §1 dry-run deliberately skips the `'forget'` lock (documented). All other operations continue to use existing locks (`'ingest'`, `'forget'`, etc.).

**Schema:** no migrations. `listSourceRefs` reads from the existing `entries` table; the canonical-selection rule does not require persisted ordering.

---

## Tests

- `listSourceRefs`: live-only filter (soft-deleted rows excluded); code-unit sort; empty entity returns `[]`; mixed deleted/live rows; multi-fact document returns one row; handles `sourceHash IS NULL` branches; environment-independent sort (same input → same output on any platform); cross-method consistency — for any ref in the result, `sourceHash === findLatestSourceHash(entityId, sourceRef)`, including under the import-path multi-live-hash anomaly.
- `forget({ dryRun: true })`: returns same `ForgetResponse` shape as real call; no rows mutated; no outbox rows staged; no embedding hooks fired; no lock contention with concurrent real forget; non-transactional read documented; standard / `clearAll` / unknown-ref cases each return the documented counts; `clearAll` case sets `metadataReset: true`; real `forget` returns `metadataReset: true` when a checkpoint reset actually occurs.
- `findSourceRefsByHash`: live-only; code-unit sort; empty result for unknown hash; multiple results for collision case; first element is the canonical.
- `ingestDocument({ onDuplicateHash })`:
  - `'ingest'` matches current behavior with no opt specified.
  - `'skip'` returns `{ truncated: false, chunks: 0, duplicateOf }`; **asserts zero LLM calls, zero ingest-lock acquisitions, zero DB writes, zero outbox events**.
  - `'throw'` raises `WikiDuplicateHashError` with `canonical`, `sourceHash`, `entityId`.
  - Same-sourceRef collision does **not** fire the guard (it's `hasChanged`'s job).
  - Soft-deleted row does **not** fire the guard.
  - Cross-entity same hash does **not** fire the guard (different entity IDs).
- `hasChanged` (batched):
  - Mixed entries: unchanged / changed / duplicate / duplicate-and-changed.
  - `duplicateOf` set only for different refs; same-ref collisions produce `duplicateOf: undefined`.
  - **Equivalence:** batched call with `[{ sourceRef, sourceHash }]` returns same per-entry `changed` as N single-doc calls.
  - Multi-live-hash per ref (via `importDump`): batched and single-doc return same `changed` for the ref.
  - Ordering preserved.
  - Bound: at most `1 + H` SQL queries where `H = distinct input hashes`.
  - Empty input array returns `[]` immediately.

---

## Files Affected

| File | Action |
| --- | --- |
| `packages/core/src/WikiMemory.ts` | Add `listSourceRefs`, `findSourceRefsByHash`; widen `forget` and `ingestDocument` signatures; overload `hasChanged`. |
| `packages/core/src/repositories/EntryRepository.ts` | Add `listSourceRefs`, `findSourceRefsByHash`, `findLatestSourceHashes`. |
| `packages/core/src/services/IngestionService.ts` | Wire pre-lock guard check; branch on `onDuplicateHash`. |
| `packages/core/src/services/MaintenanceService.ts` | `dryRun` branch in `forget`. |
| `packages/core/src/types.ts` | Add `WikiDuplicateHashError`; add `IngestDocumentOptions`, `ForgetOptions`, `ForgetResponse`, `StoredSourceRef`, batched `hasChanged` return shape. |
| `packages/core/src/index.ts` | Re-export `WikiDuplicateHashError`, `StoredSourceRef`. |

---

## Out of Scope

- **No `retire` primitive, no `RETIRE_DOCUMENT` outbox event, no `documents` table.** Considered in the brainstorming phase and explicitly dropped. The duplicate-hash ingest guard in §2 covers the "stop ingesting a document" use case at plan time; `forget` covers "remove the document's facts"; combining them under a fourth verb conflated two distinct intents.
- **No automatic in-place dedup migration.** Existing DBs that have ingested the same content under two `source_ref`s continue to have duplicate facts. The new APIs let hosts *prevent* future duplicates (§2's guard) and *audit* existing ones (§1's `listSourceRefs`, §2's `findSourceRefsByHash`); the migration of existing duplicates is the host's job (typically `forget({ sourceRef: loser })`).
- **No new outbox event type.** Per-fact `DELETE` events emitted by `forget` are the signal hosts use today; grouping them by `source_ref` is the host's job. Adding a document-level event would conflate "retire a document" with "remove its facts" (see Out of Scope, first bullet).
- **No fact IDs in dry-run payload.** Reserved for future extension (see §1 "Future extension").
