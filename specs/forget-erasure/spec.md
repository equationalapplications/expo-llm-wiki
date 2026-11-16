# Forget must erase — FTS5 erasure, chain forget, compact()

**Status: Draft rev 2 — under review (T3/T4 ladder pending; owner tier selection)**  
**Issue:** equationalapplications/expo-llm-wiki#401 · **Investigation:** [`investigation.md`](./investigation.md) (rev 6, converged)

## Problem

A `forget()` call does not erase. Facts are soft-deleted and hard-delete only through
`runPrune` (default 7-day retention); FTS5 postings and row content survive deletes in the
database file; WAL/journal residue is host-dependent. The hosted consumer (SynapseTree) gates
its privacy promises on real erasure: charter rule 8 promises deletion, and a delete whose text
is still recoverable from the store file is not done (INTENT.md:468; §2 "Your database stays
yours", INTENT.md:135).

Reproduced in the investigation with a canary-string forensic harness
(`canary-repro.cjs`): after a plain delete + checkpoint, the canary is byte-recoverable from
the database file even on a multi-segment index (scenario B).

## Root cause (with evidence)

Four primary retention surfaces in the store file (investigation §3, all [V]):

1. FTS5 postings survive deletes — measured directly: the deleted row's term bytes remain in
   `%_data` segment pages even after VACUUM (B, B′); `'rebuild'` alone clears the postings
   surface but leaves bytes in freed pages (H).
2. Deleted row content is not zeroed — the engine never sets `PRAGMA secure_delete`
   (scenario H proves the pragma is load-bearing).
3. Soft-delete retention window (`retainSoftDeletedFor`, engine default 7 days,
   `MaintenanceService.ts:253`).
4. WAL/journal residue — the engine sets no `journal_mode` and its only checkpoint runs
   **before** VACUUM, never after (`MetadataRepository.ts:172-175`).

Plus the derived/upstream copies of fact text (investigation §3.5 census): events
(`schema.ts:124-128`), unacked outbox rows (`:156-162`), `source_documents.text`
(`:74` — `forget({entryId})` never touches it), entity summaries (`meta`), the entity manifest
(fact-derived, not text), and export files outside the store.

The issue's proposed mechanism — the FTS5 `'secure-delete'` option — is **unusable as the
required mechanism**: the upstream merge bug (investigation §5) is unfixed in every released
SQLite (wrong in 3.46.0→3.53.2, fix on trunk only), so the version gate over supported
runtimes passes nothing. It also opens a one-way file-format door (format 5).

The measured alternative (F/G/F2/G2, option asserted off via `ft_config`, multi-segment
300-row index, integrity + MATCH green, erasure proven on **both** surfaces — row content AND
`%_data` term bytes — on unicode61 **and** the engine's `porter unicode61`; a second
independent run is recorded in the LEDGER): core pragma + plain delete + FTS `'optimize'`
**or** `'rebuild'` + `wal_checkpoint(TRUNCATE)` erases the canary completely.

## The decisions

### 1. The erasure guarantee lives at compact-time, not at forget-time

`PRAGMA secure_delete=ON` is set in `setup()` on the **host-provided handle** (the engine never
opens connections; guide line 61). The pragma is read back after setting and surfaced: if the
runtime refuses it, `setup()` warns. **No opt-out in v1 is the recommendation** — without the
pragma, even `'rebuild'` leaves text in freed pages (scenario H) — but it is **an owner
decision (question B)**, because the pragma is connection-wide and ATTACH-wide: it changes
delete behavior and write cost for the host's own tables (INTENT.md:137-138 tension), and
`secure_delete=FAST` is a cheaper middle option. Host connections that write wiki tables
themselves must set the pragma too (documented; guide §"If your app writes to the wiki tables
itself").

The erasure promise is scoped: **erasure of the store file is guaranteed at `compact()` time,
not at `forget()` time.** Between them the soft-delete window and journal residue remain
(deterministically, not accidentally). The deleting-data guide states this explicitly.

### 2. `compact()` — the erasure API

Store-wide `wiki.compact()` (owner question A on scope). Composition, in order:

1. Per-entity prune with `retainSoftDeletedFor: 0`, **inheriting `runPrune`'s safety holds**:
   no hard-delete of facts whose external-index removal is unconfirmed (guide 55-56); keep
   librarian-unread events unless an `includeEvents`-shaped opt-in is passed (guide 213-216).
   The result reports what it held back, per entity.
2. FTS `'optimize'` on both FTS tables when they exist (a `rebuild` escape hatch is exposed as
   `compact({ rebuild: true })` for stores recovering from corruption).
3. `VACUUM`.
4. `wal_checkpoint(TRUNCATE)` — **after** the VACUUM (`MetadataRepository.vacuum()` today
   checkpoints only before; the post-VACUUM checkpoint is what clears the rebuilt file's
   passage through the WAL).

A store with no FTS tables (no-FTS runtime, expo hosts without `enableFTS`) skips step 2 and
remains correct: there is nothing to optimize, and steps 1/3/4 still erase.

### 3. Chain forget — `forget({ entryId, includeChain: true })`

New optional flag on the entryId selector. Reuses `EntryRepository.findSupersessionChainIds`
(`:1085-1116`): both directions, capped at `HISTORY_MAX_DEPTH = 100`
(`TemporalService.ts:9`). The walk has **no `deleted_at` filter** — soft-deleted chain members
are included, which is the desired erasure semantics; the dry-run preview lists every id the
walk touches, the depth cap, and **says so when the cap truncates the walk**. Chain members are
**soft-deleted** into the existing prune flow; their erasure completes at `compact()` like
every other fact. `dryRun` output gains `chainEntryIds` alongside the existing fields.

Mutually exclusive with `clearAll` (existing selector rules unchanged; the flag composes only
with `entryId`).

### 4. Optional immediate-erasure enhancement, gated (the issue's FTS5 option)

Migration **v18**: when the runtime passes the version gate — FTS5 capability (the option is
accepted) **and** `sqlite_version()` outside the known-buggy merge range (upper bound
re-checked against the sqlite release history at implementation time) — the migration sets the
option on both FTS tables, `Fts5IndexStrategy.init` sets it for fresh stores, and the
retired-table lifecycle (`delistRetired`) carries it to rebuilt tables. Outside the gate the
migration **skips with a surfaced warning**; the compact-time guarantee (§1-2) is unaffected.
Format-5 read errors on older builds (the one-way door) fall back to the no-FTS path
(precedent: migration v1, `migrations.ts:12-19`) or `rebuild`.

The pragma (§1) is unconditional on every runtime — it has no version constraint and no format
door.

### 5. Source-store erasure: document GC when the last live fact goes

`forget({ entryId })` today leaves the fact's stored source text (`source_documents.text`,
`schema.ts:74`) on disk when the selector is entry-based. Decision: `compact()` gains a
source-store GC pass — a `source_documents` row (and its `source_passages`, and their FTS
rows via the index strategy) is hard-deleted when **no live entry references it** anymore
(all referencing entries soft-deleted/pruned in the same compact run). A single-fact
`forget({ entryId })` must NOT erase the document outright — one document backs N facts, and
erasing it would destroy the passages and `source_pointer` targets of the document's other
live facts. Documents backing any live fact are untouched. Hosts that need certainty erase via
`sourceRef` selectors today (already hard-deleting); the GC pass closes the entryId path.

### 6. Docs: the deleting-data guide gets the erasure section

`apps/docs/src/content/docs/guides/deleting-data.md` gains: the erasure recipe (forget → prune
`retainSoftDeletedFor: 0` → `compact()`), the "guaranteed at compact-time, not forget-time"
scoping, the host-connection pragma requirement, the copy census (events kept unless
`includeEvents`; drain the outbox; source documents GC; manifest stays; exports bring data
back), and the no-opt-out pragma statement.

## Files touched

- `packages/core/src/db/migrations.ts` — v18 (gated option set).
- `packages/core/src/services/search/Fts5IndexStrategy.ts` — init-time option set (gated);
  retired-table carry.
- `packages/core/src/db/schema.ts` / setup path — `PRAGMA secure_delete=ON` + read-back in
  `setup()`.
- `packages/core/src/services/MaintenanceService.ts` — `forget()` chain flag; `compact()`
  (prune-with-holds + optimize/rebuild + VACUUM + post-VACUUM checkpoint); source-store GC.
- `packages/core/src/WikiMemory.ts` — `compact()` public API + `forget` param typing.
- `packages/core/src/repositories/EntryRepository.ts` — dry-run chain listing helper (reuses
  `findSupersessionChainIds`).
- `apps/docs/src/content/docs/guides/deleting-data.md` — erasure section.
- `INTENT.md` — status lines touched by this behavior (updated in the implementation PR per
  house rule).

## Test plan

1. **Canary forensic test (the acceptance criterion):** the canary is a **single lowercase
   alphanumeric token** (byte-identical under the engine's `porter unicode61` tokenizer,
   verified via fts5vocab + pre-delete MATCH) — a mixed-case/hyphenated canary can only ever be
   found in the `%_content` copy, so a plain byte-scan proves nothing about the postings
   surface. Ingest through the public write path (`remember`/`ingestDocument`) into a tempdir
   store with 300+ filler facts (multi-segment index), `forget({ entryId })`,
   `runPrune({ retainSoftDeletedFor: 0 })`, `compact()` — assert the canary is absent from the
   db file, `-wal`, `-journal`, `-shm`, **and from every `%_data` block** (the postings
   surface). Mirror scenario F and G (optimize and rebuild variants).
2. **H-mirror test:** with the pragma unset via a test hook, `'rebuild'` alone leaves the
   canary — pins why the pragma is unconditional.
3. **compact() holds:** with an unconfirmed external removal and an unread event, `compact()`
   hard-deletes nothing held and reports the holds.
4. **Chain forget:** fixture lineage with fan-in; dry-run lists exactly the walked ids and the
   cap-truncation notice; real run soft-deletes the chain; erasure completes after compact.
5. **Source GC:** document backing two facts, one forgotten — document stays; both forgotten +
   compact — document and passages gone (including `source_passages_fts`).
6. **Gate tests:** mock runtimes (refuses option / in-buggy-range / format-5 read error) —
   migration warns and skips; no-FTS path stays green; pragma read-back surfaces refusal.
7. Baseline gates: `pnpm -r typecheck`, unit suite (wall-clock-flake-prone timeouts under load
   are re-run in isolation per the known flake signature).

## Rejected alternatives

- **FTS5 `'secure-delete'` option as the required mechanism** (the issue's proposal): version
  gate passes zero supported runtimes (upstream merge bug unfixed in every release) + one-way
  format-5 door. Kept as the gated optional enhancement (§4).
- **VACUUM alone as the mechanism:** drops freed content pages but copies live `%_data` pages
  as-is, so term bytes under delete markers survive it — **measured NOT clean (B′, postings
  present)**. Part of the recipe, not the guarantee.
- **Erasing events/outbox unconditionally on `forget({entryId})`:** breaks the librarian's
  rebuild-from-events contract and the outbox delivery guarantee; documented as host steps
  instead (guide already covers both).
- **Per-connection pragma opt-out:** no-opt-out in v1 (scenario H); revisit on a measured
  perf complaint.

## Release

Semver: new public API (`compact()`, `forget` flag) → minor. New migration v18 — consumers run
their migration sweep on upgrade. The gated option is a no-op outside the gate, so the
migration is safe on every current runtime. No format change occurs unless the gate passes
(and then the one-way door applies, documented).

## Non-goals

- Erasing events or outbox rows on single-fact `forget()` (documented host steps).
- Erasing export files (outside the store; documented).
- Removing the entity manifest (fact-derived types, documented).
- Vector/external-index erasure (shipped: durable-vector-removal, PR #372; this lane is the
  store-file side only).
- Performance tuning of secure deletes (measure first, per the issue's acceptance).

## Owner questions (parked for the end-of-build consultant batch)

- **A.** `compact()` store-wide (recommended) vs entity-scoped; and whether the store-wide
  0-day undo-window wipe needs its own confirmation knob.
- **B.** The `PRAGMA secure_delete` no-opt-out call — now with its scope dimension: the pragma
  is connection-wide and ATTACH-wide, so "always on, no opt-out" changes delete behavior/write
  cost on the host's own tables (INTENT.md:137-138 tension). Options: (a) always on, no
  opt-out, read-back surfaced (recommended); (b) always on + opt-out for hosts accepting
  residue; (c) `secure_delete=FAST` default with `FULL` available.
- **C.** Ship the gated immediate-erasure enhancement in v1 (recommended) or defer v18 entirely
  and keep compact-time only.
