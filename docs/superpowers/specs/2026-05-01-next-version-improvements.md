# Spec: Next-Version Improvements (CodeGraph-Inspired)

**Date:** 2026-05-01
**Status:** Draft
**Branch:** TBD

---

## Problem

`expo-llm-wiki` covers episodic memory + FTS retrieval well, but four gaps surface for real-world consumers:

1. **Every consumer hand-rolls prompt assembly.** `read()` returns a raw `MemoryBundle`. Callers reformat facts/tasks/events into a string for LLM injection, often inconsistently and without weighting by confidence/recency/access.
2. **No cheap "did this source change?" check.** `ingestDocument` is idempotent by `(sourceRef, sourceHash)` *after* it runs, but callers syncing a set of documents (notes, prefs, scraped pages) still pay the chunking + LLM cost when nothing changed. The hash is in the DB already; there is no public read for it.
3. **Schema migrations are ad-hoc.** `setup()` detects pre-porter FTS5 tables by string-matching `sqlite_master.sql`. Each future migration adds a similar bespoke probe. No single source of truth for schema version.
4. **Soft-deleted rows accumulate forever.** `forget()`, `runHeal()`, and the orphan/stale passes only ever set `deleted_at`. There is no hard-delete path. The `pruneEventsAfter` config key in `WikiConfig` is declared but never read — events grow unboundedly. SQLite never reclaims the page space.

A fifth opportunity, **vector-augmented retrieval**, is high-value but gated on `expo-sqlite` extension support — handled as a spike, not a v-next deliverable. See `2026-05-01-vector-retrieval-spike.md`.

---

## Goals

- Ship a `formatContext(bundle, options?)` util with sensible defaults for LLM prompt injection.
- Add `hasChanged(entityId, sourceRef, sourceHash)` so callers can skip re-ingest of unchanged sources without an LLM call.
- Introduce a `{prefix}meta` table tracking `schema_version`; refactor `setup()` to apply numbered migrations.
- Ship `runPrune(entityId, options?)` to hard-delete aged soft-deleted entries/tasks and aged events; activate the dead `pruneEventsAfter` config key; optional `VACUUM`.

## Non-Goals

- Graph/edges between facts. Episodic memory does not need traversal.
- Modular pipeline refactor. Internal cleanup; defer until a second reason appears.
- Vector embeddings as a shipped feature this version. See companion spike spec.
- New LLM prompts or extraction logic.
- Auto-pruning on a timer. `runPrune` is caller-triggered, mirroring `runLibrarian` / `runHeal`.

---

## Changes

### 1. `formatContext` util

New file: `src/utils/formatContext.ts`. Pure function; no DB access.

```ts
export interface FormatContextOptions {
  format?: 'markdown' | 'plain';      // default 'markdown'
  maxFacts?: number;                  // default 10
  maxTasks?: number;                  // default 10
  maxEvents?: number;                 // default 10
  includeConfidence?: boolean;        // default true
  includeTags?: boolean;              // default true
  factWeights?: {
    confidence?: number;              // default 1.0
    accessCount?: number;             // default 0.3
    recency?: number;                 // default 0.5 (decays over 30d)
  };
}

export function formatContext(
  bundle: MemoryBundle,
  options?: FormatContextOptions
): string;
```

**Default markdown layout:**

```
## Memory

### Known Facts
- **Title** (certain) [tag1, tag2]
  Body text…

### Open Tasks
- [P5] Description (in_progress)

### Recent Events
- [observation @ 2026-05-01T…] Summary
```

**Ranking:** facts sorted by

```
score = confidenceWeight * w.confidence
      + log(1 + access_count) * w.accessCount
      + recencyDecay * w.recency
```

where `recencyDecay = exp(-ageDays / 30)` and `confidenceWeight` is `certain=1.0`, `inferred=0.6`, `tentative=0.3`. Tasks by `priority DESC, created_at ASC`. Events newest-first, capped at `maxEvents`.

**Re-export:** add to `src/index.ts` alongside `formatMemoryDump`.

**Tests:** `src/__tests__/formatContext.test.ts` covering empty bundle, markdown vs plain, truncation, ranking ties, weight overrides.

> **Implementation note (task ordering test):** When asserting that "High priority" appears after "High priority early" in the output, use `indexOf('High priority (')` (anchored by the rendered `(status)` suffix) rather than `indexOf('High priority')`, which is a prefix of `'High priority early'` and would match the wrong position.

---

### 2. `hasChanged()` API

New public method on `WikiMemory`:

```ts
async hasChanged(
  entityId: string,
  sourceRef: string,
  sourceHash: string
): Promise<boolean>;
```

**Semantics:**

- Normalise `sourceRef` and `sourceHash` via existing helpers; if either is invalid, throw `Error` (matches `ingestDocument` contract).
- Query `{prefix}entries` for any non-deleted row with matching `entity_id` + `source_ref`. If none → return `true` (never ingested, or all prior facts forgotten).
- If the latest row's `source_hash` matches the supplied hash → return `false`. Otherwise → `true`.
- Uses existing `entries_source_ref_idx` and `entries_source_hash_idx`.

**Caller pattern:**

```ts
if (await wiki.hasChanged(entityId, ref, hash)) {
  await wiki.ingestDocument(entityId, { sourceRef: ref, sourceHash: hash, documentChunk });
}
```

**React hook:** add `useWikiHasChanged()` in `src/react/` mirroring existing mutation hook shape (`execute`, `lastResult`, `isPending`, `error`). Keep optional — `useWikiIngest` continues to work standalone.

**Tests:** `src/__tests__/hasChanged.test.ts` for first-ingest, matching hash, mismatched hash, soft-deleted prior ingest, invalid inputs.

---

### 3. Schema versioning via `meta` table

New table created in `setupDatabase`:

```sql
CREATE TABLE IF NOT EXISTS {prefix}meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Single canonical key: `schema_version` (string-encoded integer).

**Refactor `setup()`:**

- Read `schema_version` from meta. If missing, infer:
  - No `{prefix}entries` table → fresh install, set version to current.
  - Has `{prefix}entries` but FTS lacks porter → version `0`.
  - Has porter FTS → version `1`.
- Run a numbered migration list `[{from: 0, to: 1, run: …}, …]` in order, each in its own transaction.
- After each migration, write the new version into meta.
- Existing porter rebuild logic moves into `migration_0_to_1`.

**Migration registry:** `src/db/migrations.ts` (new). Exports an array of `{ version: number; description: string; run: (db, prefix) => Promise<void> }`. `setupDatabase` invokes the registry.

**Backwards compatibility:** existing installs without a meta row are detected by the porter probe and assigned the appropriate version after migrations complete. No data migration; one-time write of the meta row.

**Tests:** `src/__tests__/migrations.test.ts` for fresh install, legacy install (no meta, no porter), legacy install (no meta, porter present), idempotent re-run.

---

### 4. `runPrune()` — hard-delete + vacuum

New public method on `WikiMemory`:

```ts
async runPrune(entityId: string, options?: {
  retainSoftDeletedFor?: number;   // days after soft-delete, default 7; null = skip
  retainEventsFor?: number;        // days since created_at, default from config.pruneEventsAfter (30); null = skip
  vacuum?: boolean;                // default false
}): Promise<{ entries: number; tasks: number; events: number }>;
```

**What it does:**

- Hard-deletes `{prefix}entries` rows where `deleted_at IS NOT NULL AND deleted_at < now - retainSoftDeletedFor days`.
- Hard-deletes `{prefix}tasks` rows with same condition.
- Hard-deletes `{prefix}events` rows where `created_at < now - retainEventsFor days`. The events table has no `deleted_at`; the existing `pruneEventsAfter` config key maps here and is currently dead code — this activates it.
- Optionally calls `PRAGMA wal_checkpoint(TRUNCATE)` then `VACUUM`. Default `false` because `VACUUM` rewrites the entire DB and can be slow on mobile.
- Returns counts of hard-deleted rows per table.
- Must not run concurrently with librarian / heal / ingest / another prune for the same entity. Reuse `activeMaintenanceJobs` with key `${prefix}:${entityId}:prune`. Throw `WikiBusyError('prune', entityId)` (extend the union type).

**FTS5 consistency:** hard-deleting entries triggers the existing `entries_ad` trigger, which keeps FTS5 in sync automatically. No additional cleanup needed.

**Config additions in `WikiConfig`:**

- `pruneRetainSoftDeletedFor?: number` — default 7 (days).
- `pruneEventsAfter?: number` — already declared; now wired as the default for `retainEventsFor`. Default 30 (days).

**`useWikiMaintenance` extended:**

```ts
const { runLibrarian, runHeal, runPrune, isPending, error } = useWikiMaintenance();
```

Shared `isPending` remains true if any of the three are in-flight.

**Tests:** `src/__tests__/prune.test.ts` — soft-deleted entries removed after threshold, recent soft-deletes kept, event cutoff, vacuum flag round-trips, concurrent guard throws `WikiBusyError`, returns correct counts, FTS5 stays consistent (search after prune does not return removed rows).

---

## File Touch List

- `src/utils/formatContext.ts` — NEW
- `src/index.ts` — re-export `formatContext`
- `src/WikiMemory.ts` — add `hasChanged`, `runPrune`; route migrations through registry
- `src/db/schema.ts` — add `meta` table; remove inline porter probe
- `src/db/migrations.ts` — NEW
- `src/react/useWikiHasChanged.ts` — NEW
- `src/react/useWikiMaintenance.ts` — extend with `runPrune`
- `src/react/index.ts` — export new hook
- `src/types.ts` — `FormatContextOptions`, hook result types, `pruneRetainSoftDeletedFor` config key, extend `WikiBusyError` operation union with `'prune'`
- `src/__tests__/formatContext.test.ts` — NEW
- `src/__tests__/hasChanged.test.ts` — NEW
- `src/__tests__/migrations.test.ts` — NEW
- `src/__tests__/prune.test.ts` — NEW
- `README.md` — document the four new APIs
- `CHANGELOG.md` — entry for v-next

---

## Risk / Mitigation

- **`formatContext` opinions clash with consumer prompts.** Mitigated: fully optional; existing `read()` returns raw bundle unchanged.
- **Migration registry breaks legacy installs.** Mitigated: probe-based inference covers every shipped schema version; idempotent re-run asserted by tests.
- **`hasChanged` returns true for soft-deleted rows.** Intentional — caller wants the document re-ingested if its prior facts were forgotten.
- **`runPrune` deletes events still referenced by `related_entry_id`.** Mitigated: `related_entry_id` is informational, not a FK constraint; dangling references are acceptable.
- **`VACUUM` on mobile is slow.** Mitigated: default `false`; opt-in only.

## Out of Scope

- Removing or changing existing public API behaviour.
- Reformatting `formatMemoryDump` (separate utility, different purpose).
- Any change to librarian / heal / ingest LLM prompts.
- Auto-scheduling `runPrune` (caller-driven, like other maintenance).
- Vector retrieval (separate spike spec).
