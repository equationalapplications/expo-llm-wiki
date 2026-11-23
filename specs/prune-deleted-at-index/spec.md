# Partial index on `entries(entity_id, deleted_at)` for prune

**Status:** Draft
**Date:** 2026-11-23
**Intent check:** Checked against `INTENT.md` 2026-11-23. Rule 2 (your database stays yours): "Schema migrations add columns, tables and indexes; they never drop a column or a table that holds your facts." This change adds one engine-owned index under the host's prefix, drops nothing, rewrites no row, and a host can still defer it with `setup({ migrations: 'refuse' })`. Rule 11 (benchmarks back claims): the claim here is a query plan, not retrieval accuracy or cost; the spec states plan evidence and makes no accuracy claim. Rule 13 (erasure): the index narrows which rows the erase walk finds; it changes no deletion semantics. Rule 10: this spec precedes implementation. No contradiction with INTENT found.

Issue: #443.

## Problem

`llm_wiki_entries.deleted_at` has no index. Every query that asks "which rows are soft-deleted?" has to examine every row of the entity, or of the whole table, and then discard the live ones. The common case (almost nothing is soft-deleted) is the worst: the scan returns nothing and still pays full price.

The issue reports ~69 ms per probe on a 100k-entry namespace (hot cache, no soft-deleted rows). The probe is synchronous in better-sqlite3-style hosts, so it blocks the event loop for every tenant co-hosted in the process. The engine's own prune path hits the same scan.

## Root cause (with evidence)

The prune-path queries that filter on `deleted_at IS NOT NULL` (grep of `packages/core/src`, excluding the `IS NULL` live-row guards, which are served by other indexes and out of scope):

| # | Where | Predicate |
|---|---|---|
| 1 | `EntryRepository.getPrunableMetadata` (`EntryRepository.ts:718`) | `entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?` (cutoff form) |
| 2 | same, `opts.noCutoff` (erase) | `entity_id = ? AND deleted_at IS NOT NULL` |
| 3 | `EntryRepository` hard-delete chunk (`EntryRepository.ts:954`) | `entity_id = ? AND deleted_at IS NOT NULL [AND deleted_at <= ?] AND id IN (...)` |
| 4 | `MetadataRepository.getDistinctEntityIds` (`MetadataRepository.ts:223`, `:234`), entries half of a `UNION` with tasks | `deleted_at IS NOT NULL [AND deleted_at <= ?]`, no `entity_id` |
| 5 | `MaintenanceService` erase verification (`MaintenanceService.ts:758`) | `COUNT(*) ... WHERE deleted_at IS NOT NULL`, no `entity_id` |

`tasks` has the same unindexed `deleted_at` (`TaskRepository.ts:309-319`, and the halves of 4 and 5). It is out of scope here: the issue names `llm_wiki_entries`, and tasks tables are small by comparison. Noted as a follow-up if the same probe shows up there.

Evidence: `EXPLAIN QUERY PLAN` against a fresh in-memory better-sqlite3 database built by `new WikiMemory(db, ...).setup()` (so by the engine's own schema and migrations, v17), 20,000 entries across two entities, 20 soft-deleted (0.1%), `ANALYZE` run. Throwaway script: `/tmp/claude-1000/scratch/zz_explain.test.ts` (not committed).

Existing indexes on `llm_wiki_entries` at v17: `entries_entity_idx(entity_id)`, `entries_source_ref_idx(entity_id, source_ref)`, `entries_source_hash_idx` (partial), `entries_updated_idx`, `lifecycle_status`, `stale_after`, `last_verified_at`, `superseded_idx` (partial), `temporal_idx` (partial), `legacy_source_type_idx` (partial). None leads with, or contains, `deleted_at`.

Before (no index):

```
getPrunableMetadata:          SEARCH llm_wiki_entries USING INDEX llm_wiki_entries_source_ref_idx (entity_id=?)
getPrunableMetadata_noCutoff: SEARCH llm_wiki_entries USING INDEX llm_wiki_entries_source_ref_idx (entity_id=?)
hardDelete (id IN):           SEARCH llm_wiki_entries USING INDEX sqlite_autoindex_llm_wiki_entries_1 (id=?)
getDistinctEntityIds (both):  SCAN llm_wiki_entries USING INDEX llm_wiki_entries_entity_idx   (+ tasks scan, TEMP B-TREE)
erase tombstone count:        SCAN llm_wiki_entries
```

Reading: queries 1 and 2 only narrow by `entity_id`. The planner walks every row of the entity through `source_ref_idx` (a leading-`entity_id` index chosen only because it exists), fetches each row from the table to test `deleted_at`, and discards nearly all of them. That is the full-namespace scan in the issue. Query 3 is already bounded by the primary key (`id IN`) and is not a problem. Queries 4 and 5 are whole-table scans.

With the proposed index:

```
getPrunableMetadata:          SEARCH llm_wiki_entries USING INDEX llm_wiki_entries_deleted_idx (entity_id=? AND deleted_at>? AND deleted_at<?)
getPrunableMetadata_noCutoff: SEARCH llm_wiki_entries USING INDEX llm_wiki_entries_deleted_idx (entity_id=? AND deleted_at>?)
hardDelete (id IN):           SEARCH llm_wiki_entries USING INDEX llm_wiki_entries_deleted_idx (entity_id=? AND deleted_at>? AND deleted_at<?)
getDistinctEntityIds (both):  SCAN llm_wiki_entries USING COVERING INDEX llm_wiki_entries_deleted_idx   (tasks half unchanged)
erase tombstone count:        SCAN llm_wiki_entries USING COVERING INDEX llm_wiki_entries_deleted_idx
```

Column order and WHERE clause: `(entity_id, deleted_at) WHERE deleted_at IS NOT NULL`. The planner accepts the partial index for every query above because each one states `deleted_at IS NOT NULL` verbatim, which SQLite needs to prove the partial predicate. A future query that filtered only on `deleted_at <= ?` would not match the index, so the `IS NOT NULL` term must stay. `entity_id` leads because 1-3 are always entity-scoped equality probes; `deleted_at` second makes the cutoff a range seek instead of a post-filter. Queries 4 and 5 have no `entity_id` predicate, so the planner scans the whole partial index (covering, since `entity_id` and `deleted_at` are both in it), and it holds only tombstones, so the scan is bounded by the soft-deleted row count, not the table.

Caveat observed: for query 3 the planner switches from the primary key to the new index. With a 500-id `IN` list either is cheap, and the partial index is no larger than the tombstone set, but the implementation PR must re-verify that plan and that the hard-delete chunk is not slower on a namespace with a very large tombstone backlog.

## Proposed change

1. **New migration v18**, `description: 'Partial index on entries(entity_id, deleted_at) for prune and tombstone probes'`, appended to `MIGRATIONS` in `packages/core/src/db/migrations.ts`. Index only; no data change:

   ```sql
   CREATE INDEX IF NOT EXISTS ${prefix}entries_deleted_idx
     ON ${prefix}entries(entity_id, deleted_at) WHERE deleted_at IS NOT NULL
   ```

   Conventions followed: migrations are objects `{ version, description, run(db, prefix) }` in strictly ascending order (enforced at module load); `CURRENT_SCHEMA_VERSION` derives from the last entry, so it becomes 18 with no other edit; every index in the file uses `CREATE INDEX IF NOT EXISTS`, so re-running is a no-op. The name follows the `${prefix}entries_<what>_idx` convention.

2. **Fresh-install parity, mirroring v14 (`createLegacySourceTypeIndex`), not the every-open `schema.ts` DDL.** Export a small `createEntriesDeletedIndex(db, prefix)` from `migrations.ts`, call it from v18, and call it in the fresh-store transaction in `WikiMemory.setup()` next to `createLegacySourceTypeIndex` (`WikiMemory.ts:458`), inside the same transaction that stamps `schema_version`, so a crash cannot leave the stamp without the index. It is deliberately not added to `schema.ts` `setupDatabase` (the every-open block near `schema.ts:43-46` and `:225`): that block runs before the migration gate decides, so on an existing large store an every-open `CREATE INDEX` would build the index inside a caller's `setup({ migrations: 'refuse' })` open, defeating the gate (rule 2's deferral promise). The v14 docstring records the same reasoning. The `entries_temporal_idx` pattern (every-open, column-gated) does not fit: the column here always exists (it is in the base `CREATE TABLE`), so there is nothing to gate on, and the build cost is the reason to keep it out.

3. **Gate behavior.** v18 becomes a pending migration on every existing store. `refuse` throws as for any pending migration; `auto` and `allow` run it. The build is one pass over the table (the partial index writes only tombstones), so it is cheap, but the spec does not claim it is instant on very large stores; the implementation PR measures the build on a 100k-row table and records the number.

4. **Export/import impact: none expected.** `ImportExportService` serializes facts, not indexes or `schema_version`; a bundle exported at v17 imports into a v18 store and the reverse, because the index is invisible to the bundle format. The implementation PR confirms with a round-trip test rather than assuming.

5. **Semver.** Perf improvement with no API or behavior change: `perf:` commit type, patch release. No `BREAKING CHANGE` footer. Schema version moves 17 to 18, which is additive under rule 2; an older engine opening a v18 store sees an unknown extra index and ignores it.

Out of scope: an index on `tasks(deleted_at)`; changing the prune queries themselves; host-side probes (SynapseTree) which benefit automatically once the index exists, and no longer need their workaround.

## Files touched

- `packages/core/src/db/migrations.ts`: v18 entry and `createEntriesDeletedIndex`.
- `packages/core/src/WikiMemory.ts`: call it in the fresh-store transaction (import already present for the sibling helper).
- `packages/core/__tests__/sourceRefNormalize.test.ts` (lines ~85-123) and `packages/core/__tests__/setupBudget.test.ts` (lines ~67-98): hard-coded `17` for `CURRENT_SCHEMA_VERSION`, last migration version and the `schema_version` meta value become 18. `migration17.test.ts` uses `>=` and needs no edit. `fts5RenameRetire.test.ts:133` writes `'17'` as an arbitrary stamp for a probe and should be re-read, but does not obviously need a change.
- New `packages/core/__tests__/migration18.test.ts` (see test plan).
- No change to `schema.ts`, to any repository query, to public types, or to docs beyond this spec's Status line when it flips.

## Test plan

New `packages/core/__tests__/migration18.test.ts`, modeled on `migration17.test.ts` and `edgeQueryPlans.test.ts` (same `openTestDatabase` helper, `EXPLAIN QUERY PLAN` through the adapter):

1. Registered and stamped: `MIGRATIONS` contains v18; a fresh `setup()` stamps `CURRENT_SCHEMA_VERSION`; `sqlite_master` has `llm_wiki_entries_deleted_idx` with `sql` containing `WHERE deleted_at IS NOT NULL` and columns `(entity_id, deleted_at)`.
2. Upgrade path: `setup()`, delete the index, roll `schema_version` back to `'17'`, `setup()` again, assert the index is recreated and the stamp is 18. A second `setup()` is a no-op (idempotent).
3. Gate: with the store at v17, `setup({ migrations: 'refuse' })` throws as for any pending migration and does not create the index; `'allow'` creates it.
4. Plan, per prune query (cutoff, `noCutoff`, hard-delete chunk, `getDistinctEntityIds` both forms): populate with soft-deleted and live rows, `ANALYZE`, run `EXPLAIN QUERY PLAN`, assert the detail names `llm_wiki_entries_deleted_idx` and contains no bare `SCAN llm_wiki_entries` without `USING ... INDEX`. Drive the queries through the real repository methods with a recording adapter (the `edgeQueryPlans` pattern), not copied SQL, so the test fails if a query is reworded so the partial predicate stops matching.
5. Behavior unchanged: existing `prune.test.ts` and erase suites pass untouched; add one export-at-17 / import-at-18 round trip asserting identical facts (the export/import "none" claim).
6. Update the two hard-coded `17` assertions listed above.

Verification commands (implementation PR): `pnpm --filter @equationalapplications/core-llm-wiki test` for the package, then root `pnpm test`; the EXPLAIN output quoted here is regenerated from the committed test and pasted in the PR.
