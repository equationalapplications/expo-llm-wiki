# Spec: Source-Ref Lifecycle, Duplicate Detection, and Batched Change Check

**Date:** 2026-08-07
**Status:** Approved
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

**Canonical-selection rule** (used by §2 and §3): when multiple `source_ref`s in one entity share a `source_hash`, the canonical is the **code-unit-minimum** of the set, ordered by `source_ref COLLATE BINARY`. Locale-dependent comparison (`localeCompare`, ICU) is explicitly rejected — a canonical choice that varies by environment re-mints identity on every deploy, which is the original bug with extra steps.

*Example:* Given refs `['mail/sent/a.md', 'mail/inbox/a.md', 'mail/inbox/b.md']` all sharing hash `h1`, the canonical ref is `mail/inbox/a.md`.

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

Single SQL aggregation against `${prefix}entries`, scoped to `entity_id`, live only, partitioned by `source_ref`. The `source_hash` returned for each ref is the hash from the row with `MAX(updated_at)`, matching single-doc `hasChanged` / `findLatestSourceHash` semantics — **not** the lexicographically maximum hash. `MAX(source_hash)` is wrong because aggregation is computed independently across grouped rows. This matters under the import-path anomaly where one ref can have multiple live rows with different hashes.

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

`ROW_NUMBER()` (not `RANK()` or `DENSE_RANK()`) — tie-break by `ROWID` is implicit, but deterministic for our purposes: no spec-defined query depends on the order within a `MAX(updated_at)` tie, only on which row wins. `COLLATE BINARY` on the outer `ORDER BY` is the explicit signal that locale dependency is rejected.

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
  metadataReset?: boolean; // Covers "did reset" (real call) and "would reset" (dry-run)
}
```

**Dry-run mechanics:** when `dryRun === true`:

1. **Skip `jobManager.acquireLock('forget', entityId)`.** Dry-run is read-only.
2. **Read outside any `withTransactionAsync`.** Dry-run counts being off-by-N during a concurrent real forget is acceptable.
3. **Run queries** against the live state:
   - *Standard case:* Run a `COUNT(*)` query for entries (the existing `softDeleteBySource` pattern materialises affected IDs to stage per-fact outbox events — see `EntryRepository.ts:357` — but dry-run stages no events, so it skips the ID materialisation and just counts) and the equivalent `TaskRepository` count for tasks. Returns `{ deleted: { entries, tasks } }` (no `metadataReset` field). The real standard-case `forget({ sourceRef })` does NOT reset the metadata checkpoint — only `clearAll: true` does (`MaintenanceService.ts:286`). `metadataReset` is therefore false for standard dry-run and real calls alike, and true only when `params.clearAll === true`. The dry-run contract is identical.
   - *`clearAll` case:* If `clearAll: true` is passed, calculate counts using `COUNT(*)` without source filters. Returns `{ deleted: { entries, tasks }, metadataReset: true }`. The real call's return type is widened to match, returning `metadataReset: true` when a checkpoint reset actually occurs, as pretending a side-effect doesn't happen is the kind of lie that bites six months later.
   - *Unknown-ref case:* Returns `{ deleted: { entries: 0, tasks: 0 } }` (no `metadataReset` field).
4. **Return `ForgetResponse` — the same shape for real forget and dry-run.** No fact IDs in the dry-run payload.
5. **Stage no outbox events. Fire no embedding hooks.**

**Future extension (reserved):** if a host's preflight needs the would-be-deleted fact IDs, that is a backwards-compatible addition to the dry-run payload. Not implemented in this spec; documented here so it's not silently closed off.

---

## §2. Duplicate-hash detection

Two surfaces — a query so hosts can audit, a guard so hosts can declare a policy.

### Query: `WikiMemory.findSourceRefsByHash(entityId, sourceHash)`

```ts
findSourceRefsByHash(entityId: string, sourceHash: string): Promise<string[]>;
```

Returns live `source_ref`s for that hash, sorted `COLLATE BINARY` ascending. First element is the canonical per the rule above. Empty array when no live row holds the hash.

```sql
SELECT source_ref 
FROM ${prefix}entries 
WHERE entity_id = ? AND source_hash = ? AND deleted_at IS NULL 
GROUP BY source_ref 
ORDER BY source_ref COLLATE BINARY
```

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
- a *different* `source_ref` from the incoming one
- same `source_hash`
- against a live (non-soft-deleted) row

When the guard fires, `duplicateOf` reports the canonical `source_ref` under the code-unit-minimum rule ([see Canonical-Selection Rule](#canonical-selection-rule)).

*Note on concurrency:* The `'skip'` decision itself, and the `duplicateOf` value, reflect state at *guard-time*, not *commit-time*. The race is narrow: same-sourceRef concurrent re-ingest — the canonical ref is the same as the incoming one, so the guard never fires in the first place; the "concurrent delete" means a concurrent same-ref re-ingest has overwritten the duplicate between guard and return, not that the ref has vanished from the entity. In that case the ingest will still skip based on the moment-of-check state. This is an intentional design choice to avoid re-checking inside the lock. For moment-of-commit guarantees, re-query via `findSourceRefsByHash` after ingest.

**Behavior per mode:**

| `onDuplicateHash` | Guard fires? | Action |
| --- | --- | --- |
| `'ingest'` (default) | yes | log/ignore; proceed with normal ingest. **Note:** To detect silent duplicates from ingest (not prevent them), use the batched `hasChanged` (§3); the guard here only blocks or throws when explicitly opted in. |
| `'skip'` | yes | return `{ truncated: false, chunks: 0, duplicateOf: <canonical> }` immediately, no LLM, no DB write |
| `'throw'` | yes | throw `WikiDuplicateHashError` carrying `{ canonical, sourceHash, entityId }` |

*Additive Return Type:* Adding `duplicateOf` to the return object widens the return type. Existing strict destructure-only callers are unaffected.

### `WikiDuplicateHashError`

New class exported from `packages/core/src/types.ts`, extending `Error` directly. `WikiBusyError` is the existing pattern for "another op holds the resource" — `WikiDuplicateHashError` is its analog for "another ref holds the content." Mirrors `WikiBusyError`'s public shape.

```ts
export class WikiDuplicateHashError extends Error {
  readonly canonical: string;
  readonly sourceHash: string;
  readonly entityId: string;
  constructor(params: { canonical: string; sourceHash: string; entityId: string }) {
    super(`Duplicate source hash for entity ${params.entityId}; another ref already holds this content`);
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

**Result ordering:** in the same order as `entries`.

**Transaction boundary:** Like the single-document `hasChanged`, this batched overload does not accept a `tx` parameter. It is strictly read-only, lock-free, and never participates in a transaction.

**Per-entry semantics:**

- `changed: true` if no live row exists for `(entity_id, source_ref)`, **or** if the latest live `source_hash` differs from the supplied one.
- `duplicateOf?: string` populated only when **a different `source_ref`** in this entity already holds the supplied hash against a live row. Uses the same canonical-selection rule.
- When `duplicateOf` is set, `changed` reflects only the same-ref diff. Both signals can fire on the same input (`changed: true && duplicateOf: 'd-other…'`), or either alone.

### Multi-live-hash invariant

The batched implementation **must match single-doc semantics in both states**: when multiple live hashes exist for a ref (via import), return the most-recently-updated one.

### Implementation

Repository method:

```ts
EntryRepository.findLatestSourceHashes(
  entityId: string,
  sourceRefs: readonly string[],
  tx?: SQLiteAdapter,
): Promise<Map<string, string | null>>;
```

Returns a `Map<sourceRef, latestHash | null>` covering every requested ref.

```sql
-- ANTI-PATTERN WARNING: Do not use MAX(source_hash). 
-- The hash must come from the exact row matching MAX(updated_at).
WITH ranked AS (
  SELECT source_ref, source_hash,
         ROW_NUMBER() OVER (
           PARTITION BY source_ref 
           ORDER BY updated_at DESC
         ) as rn
  FROM ${prefix}entries
  WHERE entity_id = ? AND source_ref IN (${placeholders}) AND deleted_at IS NULL
)
SELECT source_ref, source_hash 
FROM ranked 
WHERE rn = 1;
```

**Empty Input Edge Cases (Early Returns):**

- `hasChanged(entityId, [])` must return `[]` with zero SQL calls.
- `findLatestSourceHashes(entityId, [])` must return `new Map()` with zero SQL calls.

**Efficiency Bound:** One `findLatestSourceHashes` call to resolve per-ref latest hashes, plus one `findSourceRefsByHash` call per *distinct* input hash. Bound: at most `1 + H` SQL queries, where `H = number of distinct input hashes`. This improves performance only when duplicates exist; for all-unique corpora, overhead degenerates to `N + 1` queries.

---

## Cross-cutting

**Backwards compatibility:** §1's `forget` opts bag and §2's `ingestDocument` opts bag are both additive. §3 is an overload. §1's `listSourceRefs` and §2's `findSourceRefsByHash` are net-new methods.

**Public-surface ownership:** Hosts migrating off direct-schema access must use the `WikiMemory` facade; `EntryRepository` methods remain internal to the library.

**Outbox events:** unchanged.
**Locking:** §1 dry-run deliberately skips the `'forget'` lock.
**Schema:** no migrations.

---

## Tests

- `listSourceRefs`: live-only filter; code-unit sort; empty entity returns `[]`; mixed deleted/live rows; **multi-fact document returns one row**; **handles `sourceHash` IS NULL branches**; **environment-independent sort**; **cross-method consistency** (`sourceHash === findLatestSourceHash(...)`).
- `forget({ dryRun: true })`: returns same shape as real call; no rows mutated; no outbox/hooks fired; no lock contention; **standard case returns NO `metadataReset` field** (real standard `forget` never resets the checkpoint); **`clearAll: true` returns correct entity/task counts and explicitly reports `metadataReset: true`**; **unknown refs return `{ deleted: { entries: 0, tasks: 0 } }`**.
- `findSourceRefsByHash`: live-only; code-unit sort; empty result for unknown hash; multiple results for collision case; **soft-deleted rows with the same hash are excluded** (regression guard against SQL accidentally including `deleted_at IS NOT NULL` rows, which would re-introduce the original bug).
- `ingestDocument({ onDuplicateHash })`:
  - `'ingest'` matches current behavior.
  - `'skip'` returns `{ truncated: false, chunks: 0, duplicateOf }`; **asserts zero LLM calls, zero ingest-lock acquisitions, zero DB writes, zero outbox events, and synchronous return with no `setImmediate` / `Promise.resolve().then()` deferral** (regression guard against a future refactor that wraps the early-return in a microtask).
  - `'throw'` raises `WikiDuplicateHashError` (and verifies `WikiDuplicateHashError instanceof Error`).
  - Same-sourceRef collision does **not** fire the guard.
  - Soft-deleted row does **not** fire the guard.

- `hasChanged` (batched):
  - Mixed entries: unchanged / changed / duplicate / duplicate-and-changed.
  - `duplicateOf` set only for different refs.
  - **Equivalence:** batched call returns same per-entry `changed` as N single-doc calls.
  - Multi-live-hash per ref (via `importDump`): batched and single-doc return same `changed` for the ref.
  - Empty input array returns `[]` immediately.
  - **Concurrency asserts:** Asserts no locks acquired and no DB writes occur during `hasChanged`.

---

## Out of Scope

- **No `retire` primitive, no `RETIRE_DOCUMENT` outbox event, no `documents` table.** Considered in the brainstorming phase and explicitly dropped. The duplicate-hash ingest guard in §2 covers the "stop ingesting a document" use case at plan time; `forget` covers "remove the document's facts"; combining them under a fourth verb conflated two distinct intents.
- **No automatic in-place dedup migration.** Existing DBs that have ingested the same content under two `source_ref`s continue to have duplicate facts. The new APIs let hosts *prevent* future duplicates (§2's guard) and *audit* existing ones (§1's `listSourceRefs`, §2's `findSourceRefsByHash`); the migration of existing duplicates is the host's job (typically `forget({ sourceRef: loser })`).
- **No new outbox event type.** Per-fact `DELETE` events emitted by `forget` are the signal hosts use today; grouping them by `source_ref` is the host's job. Adding a document-level event would conflate "retire a document" with "remove its facts".
- **No fact IDs in dry-run payload.** Reserved for future extension (see §1 "Future extension").
