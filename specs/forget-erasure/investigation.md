# Investigation — #401: forget must erase (FTS5 secure-delete, chain forget, compact())

**Date:** 2026-11-16 · **Status:** Draft rev 1 (Step 0, pre-Opus)
**Issue:** equationalapplications/expo-llm-wiki#401 · **Repo baseline:** `27f8e5e9` (main after #400, v9.2.0)
**Evidence tags:** [V] = controller-verified against this tree / live driver; [C] = child- or web-reported, not independently reproduced.

## 1. Summary

The issue's central claim is **correct and reproduced**: after `forget()` plus the documented
hard-delete steps, the deleted fact's text remains recoverable from the database file. The
retention is not one bug but **four independent surfaces**, and erasure requires addressing all
four. The issue's proposed recipe works, with two corrections (SQLite floor version; VACUUM is
needed to shrink the file, not to erase) and one recipe addition (the core `PRAGMA
secure_delete=ON` must be set in addition to the FTS5 option — verified by experiment).

## 2. Repro table (live driver: better-sqlite3 13.0.3, bundled SQLite 3.53.4, WAL mode) [V]

All experiments use a canary string `XCANARYx7f3a` inserted into an FTS5 table, then byte-scan of
the database file and the `-wal` file after each step. Scripts run inline against the workspace
driver; raw output in session record.

| # | Scenario | Canary in db file | Canary in wal |
|---|---|---|---|
| A | insert + checkpoint (baseline) | **yes** | no |
| B | plain `DELETE` + checkpoint (≈ current engine behavior after prune hard-delete) | **yes** | no |
| C | FTS5 `'secure-delete'` option only, then delete + checkpoint + `VACUUM` | **yes** (row-content b-tree leaf survives until VACUUM drops it; survives the plain delete+checkpoint) | no |
| D | core `PRAGMA secure_delete=ON` **+** FTS5 option, then delete + checkpoint | **no** | no |
| E | scenario D + `VACUUM` | **no** | no |

Notes [V]: under D, erasure is complete at the checkpoint step — `VACUUM` is not required for
erasure, only to release pages/shrink the file. FTS5 `MATCH` and the `'integrity-check'` command
stay green after secure deletes. In scenario C the surviving bytes are the FTS5 row content in
the table b-tree (the `id UNINDEXED, body` cell), confirming the SQLite docs' warning that the
core pragma, not the FTS5 option, owns that surface.

## 3. Root cause — four retention surfaces (all [V] against this tree)

1. **FTS5 postings survive deletes by design.** `entries_fts` and `source_passages_fts` are
   ordinary-content FTS5 tables (`packages/core/src/services/search/fts5Sql.ts:51-60`,
   `:215-222`). Without the FTS5 `'secure-delete'` option, a deleted row's postings remain in
   segments until merges reclaim them; the only explicit `'merge'` targets retired tables
   (`services/search/Fts5IndexStrategy.ts:446`).
2. **Deleted row content is not zeroed.** The engine never sets `PRAGMA secure_delete` — grep
   over `packages/core/src` and the deleting-data guide returns zero hits [V]. Deleted rows
   (hard deletes via `runPrune`, `clearAll`, source-pointer wipes) leave content bytes in
   freed b-tree pages.
3. **Soft-delete retention window.** `forget()` soft-deletes (`EntryRepository.softDelete`,
   `repositories/EntryRepository.ts:560-573`); rows hard-delete only via `runPrune` after
   `retainSoftDeletedFor` (engine default 7 days, `services/MaintenanceService.ts:253`).
   Hosts can pass `0`, but the documented default keeps text on disk a week [V].
4. **WAL residue is host-dependent.** The engine sets no `journal_mode` [V]; hosts that enable
   WAL keep old content in `-wal` frames until a `wal_checkpoint(TRUNCATE)`. The only
   checkpoint is `MetadataRepository.vacuum()` (`repositories/MetadataRepository.ts:172-175`),
   reached only via `runPrune({ vacuum: true })`. (In our WAL experiments the canary never
   appeared in the WAL after a checkpoint because `TRUNCATE` had already run; hosts without
   truncating checkpoints keep it.)

Additionally, the supersession chain surfaces: `entries.superseded_by` / `superseded_at`
(`db/schema.ts:38-39`, partial index `:309-311`). A superseded fact that is forgotten still has
its chain neighbors on disk until separately pruned; the issue asks for a forget option to take
the whole chain at once.

## 4. Corrections to the issue's premises

- **SQLite floor is 3.42.0, not 3.44.** The FTS5 `'secure-delete'` option shipped in 3.42.0;
  once a table has had rows deleted under the option, older FTS5 builds cannot read the table
  ("invalid fts5 file format (found 5, expected 4)"). Source: sqlite.org fts5.html §6.13 [C-web,
  quoted verbatim]. Experiment E read the table fine on 3.53.4 [V].
- **The FTS5 option alone does not erase row content** (scenario C). Both the option and the
  core pragma are required — this matches the docs' warning that `PRAGMA secure_delete` "only
  causes deleted content to be scrubbed from ordinary tables" and FTS5 shadow tables need the
  FTS5 option [C-web].
- **VACUUM is a file-shrink step, not an erasure step**, once the pragma + option are on
  (scenario D vs E) [V].

## 5. Known upstream risks (secure-delete path)

- An FTS5 secure-delete + merge bug (resurrected stale postings after merges) was reported and
  **fixed upstream** (sqlite.org bug forum, fix link in thread) [C-web]; affected a doclist-index
  walk with small page sizes. A second report (doclist-index after in-place secure-delete edits,
  datadog-labs case study) has no visible fix link [C-web]. Mitigation for the spec: the engine
  can run `'integrity-check'` after large secure-delete sweeps in tests, and a `rebuild` command
  remains the documented escape hatch. Treat as a test-plan item, not a blocker.
- **Portability:** verified only on the Node floor (better-sqlite3 → SQLite 3.53.4) [V]. The
  Expo side uses expo-sqlite's bundled SQLite build; its exact bundled version for SDK 58 was
  not pinned by this investigation. The migration must therefore **capability-probe at runtime**
  (attempt the option insert inside a savepoint/tx and degrade with a surfaced warning on
  refusal) rather than assume support. Older expo-sqlite builds without FTS5 already have a
  no-FTS upgrade path precedent (migration v1 is a no-op for exactly that reason, `db/migrations.ts:6-12`) [V].

## 6. Where the fixes land (file:line anchors, this tree)

- Migration: new **v18** in `db/migrations.ts` (latest is v17 at `:388`); set the option on both
  FTS tables when they exist. Because the FTS tables are created lazily by `Fts5IndexStrategy.init`
  (never by `setupDatabase`), **fresh stores get the option at init time** in
  `services/search/Fts5IndexStrategy.ts`, and any later-created/rebuilt table (retired-table
  lifecycle, `delistRetired`, passage tables) must set it too.
- Core pragma: set `PRAGMA secure_delete=ON` at adapter/open time. Host override question →
  §8.
- Chain forget: `WikiMemory.forget()` → `MaintenanceService.forget()`; chain walk on
  `superseded_by` (both directions is the natural reading of "whole chain" — see open question).
- `compact()`: compose existing primitives — `runPrune(retainSoftDeletedFor: 0)` logic, FTS
  `'optimize'` (never used today [V]), `wal_checkpoint(TRUNCATE)`, `VACUUM`
  (`MetadataRepository.vacuum()`).
- Docs: `apps/docs/src/content/docs/guides/deleting-data.md` (224 lines) gains the erasure note;
  INTENT.md erasure promises (§2 "your database stays yours", charter rule 8) are the alignment
  anchor.

## 7. Acceptance criterion (from the issue)

Canary-string forensic test: after `forget()` plus the documented steps, the string is absent
from the database file **and** the WAL. Scenario D shows the mechanism is sound [V]; the test
plan reproduces it through the engine's public API in a tempdir.

## 8. Open questions for the spec (owner input only where product-shaped)

1. **Chain direction for the forget option:** `superseded_by` chains are per-fact version
   histories. "Whole supersession chain" read as: the named fact + everything it superseded +
   everything that superseded it (the full version lineage). Recommend: full lineage both
   directions; `dryRun` preview already exists and should list chain members.
2. **Can hosts disable `secure_delete`** (perf-sensitive mobile hosts)? Recommend: always on in
   the engine, no opt-out in v1; revisit only on a real perf complaint. (PRAGMA is
   connection-scoped — every engine connection must set it; serialized adapter note.)
3. **Degrade path when the runtime SQLite lacks the option (<3.42 / refuses):** recommend
   skipping the FTS5 option with a console warning (erasure of postings degrades to
   merge-reclaim), while still setting the core pragma (supported far longer) — and documenting
   the degradation in the deleting-data guide.
4. **Does `compact()` take an entity scope or run store-wide?** `runPrune` is per-entity;
   VACUUM/checkpoint are store-wide by nature. Recommend: store-wide API
   (`wiki.compact()`), documented that it prunes every entity's soft-deleted rows.

## 9. Not checked by this investigation

- expo-sqlite's actual bundled SQLite version on SDK 58 (§5 portability) — resolved at
  implementation time by the capability probe + CI on the Node floor.
- Interplay of the option with `ImportExportService` dump/restore round-trips (a restored store
  is a fresh file; option must be re-applied — flagged for the plan).
- Performance cost of secure deletes on large indexes (accepted per issue; consumer gated on
  host fix only).
