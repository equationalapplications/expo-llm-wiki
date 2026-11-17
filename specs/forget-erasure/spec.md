# Forget must erase — FTS5 erasure, chain forget, compact()

**Status: Draft rev 25 — T4 delta-7 findings folded (3 MAJOR + 4 minors; majors trajectory
2→2→2→1→3 — wider review context keeps surfacing design gaps). Pending owner questions +
convergence decision. INTENT
alignment: v1 default (document-as-host-property) is rule-5-consistent; the GC alternative
requires a rule-5 amendment before implementation (see §5 / owner question E).**  
**Issue:** equationalapplications/expo-llm-wiki#401 · **Investigation:** [`investigation.md`](./investigation.md) (rev 12, converged)

## Problem

A `forget()` call does not erase. Facts are soft-deleted and hard-delete only through
`runPrune` (default 7-day retention); FTS5 postings and row content survive deletes in the
database file; WAL/journal residue is host-dependent. The hosted consumer (SynapseTree) gates
its privacy promises on real erasure: charter rule 8 promises deletion — INTENT.md:468 says
"a delete the host's index never heard about is not done"; this spec **extends that precedent**
to storage: a delete whose text is still recoverable from the store file is not done (§2 "Your
database stays yours", INTENT.md:135).

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

Plus the derived/upstream copies of fact text and identifiers (investigation §3.5 census): events
(`schema.ts:124-128`), unacked outbox rows (`:156-162`), `source_documents.text`
(`:74` — `forget({entryId})` never touches it), entity summaries (`meta`), the entity manifest
(fact-derived, not text), `source_ref_index` tombstones (`schema.ts:59-64` — soft-deleted
registry rows that keep the `source_ref`/`source_hash` strings in the file; erased by
compact step 1b under question G's recommended answer; census row added T4 delta-6 MAJOR-1),
graph `edges` rows (fact-derived; decision: left in place — investigation §3.5 census;
census row added T4 delta-6 m3), and export files outside the store.

The issue's proposed mechanism — the FTS5 `'secure-delete'` option — is **unusable as the
required mechanism**: the upstream merge bug (investigation §5) is unfixed in every released
SQLite the investigation could confirm (wrong in 3.46.0→3.53.2, fix on trunk only), so the
version gate over supported
runtimes passes nothing the investigation could verify, and the gate (§4) is **closed until a
fixed release exists**. It also opens a one-way file-format
door (format 5).

The measured alternative (F/G/F2/G2, option asserted off via `ft_config`, multi-segment
300-row index, integrity + MATCH green, erasure proven on **both** surfaces — row content AND
`%_data` term bytes — on unicode61 **and** the engine's `porter unicode61`; K/K2 measure the
full compact() composition as one unit, also clean; a second independent run (A-H2) **and a
third full run including K/K2** are recorded in
the LEDGER; these are synthetic-schema proofs of the *mechanism* — the engine-schema proof is
the acceptance test below): core pragma + plain delete + FTS `'optimize'`
**or** `'rebuild'` + `wal_checkpoint(TRUNCATE)` erases the canary completely.

## The decisions

### 1. The erasure guarantee lives at compact-time, not at forget-time

`PRAGMA secure_delete=ON` is set in `setup()` on the **host-provided handle** (the engine never
opens connections; INTENT.md:137, guide §157). The pragma is read back after setting and surfaced: if the
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

Store-wide `wiki.compact()` (owner question A on scope; a **new public API** — no method or
public API named `compact` exists in the tree; `types.ts:1186` has only a `compact?: boolean`
format-context option, no collision — T4 m1). Composition, in order (T3 M7 — each step
surfaces errors; a failed step fails the compact and reports where it stopped):

1. **Per-entity prune** with `retainSoftDeletedFor: 0` **and `retainEventsFor: null`** — events
   are genuinely **kept** by compact (T3 delta-6 MAJOR-2: the engine default is
   `pruneEventsAfter ?? 30` (`MaintenanceService.ts:254`), which silently deletes events older
   than 30 days — the opposite of this spec's "events kept unless an `includeEvents`-shaped
   opt-in" framing; compact passes `retainEventsFor: null` explicitly, and the opt-in for
   event deletion is the `clearAll({ includeEvents: true })` full-wipe path, owner question D).
   **Consequence (T3 delta-8 MAJOR-1):** with `null`, the entire event-retention block is
   skipped (`if (retainEventsFor !== null)`, `MaintenanceService.ts:406` — including
   `countHeldBack` and the `event_retention_held` diagnostic at `:435-439`), so compact has
   **no event holds to report** — events are simply never deleted. Holds reporting in compact
   covers **external-removal holds only**. (The `'legacy'`-mode watermark caveat below applies
   to **standalone `runPrune`** calls, not to compact under the null pin.)
   Inheriting `runPrune`'s safety
   holds: no hard-delete of facts whose external-index removal is unconfirmed (guide 55-56).
   Holds are **caught per entity** (`PrunePartialFailureError`, `MaintenanceService.ts:452-455`): compact
   continues to the file steps for the other entities and returns the holds per entity rather
   than throwing (T3 m2).   **Entity enumeration (T3 delta-10 m3, extended T4 MAJOR-2, helper
   T4 m3):** step 1 prunes
   every distinct `entity_id` with soft-deleted rows past the hard-delete cutoff — including
   **soft-deleted tasks** (`runPrune` hard-deletes soft-deleted tasks too,
   `MaintenanceService.ts:387` → `TaskRepository.ts:294-303`, and `tasks.description` holds
   user text, `schema.ts:92`; a task-only `forget({ taskId })` can leave an entity with
   soft-deleted tasks and zero soft-deleted entries). Add the hard-delete cutoff as an
   **optional parameter or a sibling method** on the existing distinct-entity walk
   (`MetadataRepository.ts:186`; its doc comment `:177-185` deliberately widens the walk for
   the host's maintenance sweep, so the shared method's host-facing semantics must not change
   — T4 delta-3 m4) — rather than a new UNION query. Test: task-only forget + compact → task rows gone from the file.
   A `WikiBusyError` on a per-entity `'prune'` lock (`acquireLock('prune', entityId)`,
   `MaintenanceService.ts:250` — T3 delta-11 m1; `:459` is the release call) — a concurrent
   operation on that entity — **skips that entity** with a surfaced diagnostic and does not
   fail the compact; the report lists skipped entities. **Compact's own lock (T4 m7,
   concretized T4 delta MAJOR-1):** `'compact'` does **not** exist in `OperationType`
   (`JobManager.ts:3-14`) or `WikiBusyOperation` (`types.ts:1209-1218`), and `acquireLock` is
   a hand-written per-operation switch (`JobManager.ts:190-299`) — the `'*'` at
   `MaintenanceService.ts:530-531` is two distinct operations (`'reembed'`/`'global_reembed'`),
   each with its own branch. So: **add `'compact'` to both enums**; `acquireLock`/`releaseLock`
   gain a `'compact'` case — and, **instead of per-arm compact checks (T4 delta-4 MAJOR-1: the
   rev-21 per-arm enumeration missed `global_reembed`, `JobManager.ts:236-247`, and any future
   arm), ONE universal pre-check beside the `global_import` pre-check
   (`JobManager.ts:193-195`):**
   `operation !== 'compact' && !(operation === 'prune' && owner === 'compact') &&
   this.activeMaintenanceJobs.has(this._compactKey())` →
   `throw new WikiBusyError('compact', '*')`.
   Every present and future operation except compact itself and compact-owned prune is refused
   while compact holds the key, in one place. Pin `_compactKey()` to `` `${prefix}:compact` ``
   so no suffix scan matches it, and exclude `'compact'` from the `lockKeyFns` map type
   (`JobManager.ts:104-107`, typed over `Exclude<OperationType, ...>`) — or `releaseLock`'s
   per-operation fallthrough (`:322`) indexes a missing entry (T4 delta-7 m1). **The same
   check is mirrored in `isBlocked` (`JobManager.ts:332-389`, T4 delta-7 MAJOR-3)** — a
   parallel hand-written decision copy that already duplicates the `global_import` pre-check
   (`:333`) and which `write()` consults before its auto-librarian/auto-heal triggers
   (`WriteService.ts:145`, `:154`, `:194`). Without the mirror, every `write()` during
   compact advances the memory checkpoint inside its transaction
   (`WriteService.ts:149-150`), has `acquireLock('librarian')` throw at `:172`, and rolls
   the checkpoint back in a **second, unlocked** transaction (`:189-192`) — extra unfenced
   transactions in exactly the window step 5's VACUUM is most exposed; the heal branch at
   `:194` behaves the same. Test: `write()` during compact neither advances nor rolls back
   the memory checkpoint. The `'compact'` arm self-checks first (a second
   concurrent `compact()` throws `WikiBusyError('compact', '*')` — mirroring the self-key
   check that opens `global_reembed`'s arm, `JobManager.ts:237`; T4 delta-4 m2) and mirrors
   the `global_import` pre-check so compact refuses to start during a global import (the
   pairing is bidirectional: a global import refuses during compact via the universal
   pre-check). The `WikiBusyError` construction (`JobManager.ts:295-298`) passes `'*'` only
   for the two global ops — add `'compact'` there so `WikiBusyError('compact', '*')` actually
   carries `'*'`. **Compact's acquisition rule (T4 delta-3 MAJOR-2):** compact starts with
   `acquireLock('compact', '*')`, and the `'compact'` arm mirrors `global_reembed`'s
   any-active refusal (`JobManager.ts:236-247`): it refuses while **any** per-entity
   maintenance op is active store-wide (`WikiBusyError` naming the blocking op with `'*'`).
   The arm's ingest detection reads the **separate set** `this.activeIngestJobs.size > 0`
   (`JobManager.ts:243`, T4 delta-6 m4) — not a suffix scan of `activeMaintenanceJobs` —
   so a from-scratch implementation scanning maintenance keys alone would miss an in-flight
   ingest; state both checks explicitly.
   The suffix scans **subsume the global keys** — `_globalReembedKey()` is
   `${prefix}:reembed` (`JobManager.ts:89`) and matches the `:reembed` suffix scan
   (`JobManager.ts:154`) — so a running global re-embed is caught; state this explicitly in
   the arm so a from-scratch implementation does not scan only per-entity keys (T4 delta-5
   MAJOR-2: the reviewer's interleaving scenario is disproved by the key shape, but the
   explicit check + reverse-direction test are folded as hardening: compact refused while a
   global re-embed is active throws `WikiBusyError('reembed', '*')`).
   This is what keeps steps 5-6's store-wide VACUUM out from under an in-flight transaction —
   a librarian/ingest running when compact starts would otherwise hold the connection at step
   5 and VACUUM throws "cannot VACUUM from within a transaction". **Fence boundary (T4
   delta-5 MAJOR-1):** the start refusal fences only operations that **call `acquireLock`**
   (librarian, heal, ingest, store, prune, ontologyBackfill, forget, reembed/global_reembed —
   plus compact itself). `write()`/`remember()` event appends run `withTransactionAsync`
   **without any lock** (`WriteService.ts:102`, `:124`; the only lock in that file is the
   inline librarian at `:172`), and the setup-time external-deletion drain runs unlocked
   short transactions on the shared connection for up to 10 s (guide 108-113). These paths
   are **not fenced**: a write transaction open between compact's steps 4 and 5 makes step
   5's VACUUM throw "cannot VACUUM from within a transaction". That failure is a **reported,
   retryable step failure** under the T3 M7 semantics: compact has pruned but **not erased**,
   the report says exactly that (bytes may remain in freed pages/`%_data`), and the host
   re-runs compact — it is never a false success. (§5's concurrent-`remember` caveat is the
   same unfenced boundary.) Test: a `write()` racing compact's step 5 surfaces the
   deterministic step-5 failure rather than success. **The compact-owner
   mechanism for step 1 (T4 delta-3 MAJOR-2, param placement T4 delta-4 m4):**
   `MaintenanceService` gains a private `_runPrune(entityId, opts, owner)`; public `runPrune`
   passes `owner: 'host'`, compact's step 1 passes `owner: 'compact'`; `acquireLock` gains a
   **fourth parameter** `owner` (default `'host'` — the existing third positional parameter
   `sourceRef?`, `JobManager.ts:190`, is not reused). The universal pre-check exempts only
   compact-owned prune; step 1 still traverses the `prune` case normally — the arm compact's
   step 1 goes through (`JobManager.ts:198-207`; every per-entity arm detects in-flight work
   on its own entity — T4 delta-4 m1 reword). Under the start-refusal the per-entity skip is
   not expected to fire; it stays as defense-in-depth — a lock that slipped the acquisition
   window surfaces as a skip diagnostic, not a hard failure (if compact-owned prune consulted
   the compact key, step 1 would throw `WikiBusyError` on every entity and compact would
   "succeed" having deleted nothing). Symmetrically, an **external standalone `runPrune`
   during compact's steps 3-8 is refused**: `owner: 'host'` fails the universal pre-check's
   exemption, so a host `runPrune(e, { vacuum: true })` cannot interleave a second VACUUM /
   `restartRebuildAfterVacuum` with compact's steps 5-6. Tests: compact with N
   entities hard-deletes in all N; a concurrent `storeSource` during compact throws
   `WikiBusyError('compact', '*')`; a standalone `runPrune` during compact throws
   `WikiBusyError('compact', '*')` (universal pre-check — the blocker is store-wide);
   a second concurrent `compact()` throws `WikiBusyError('compact', '*')` (self-check); a
   `global_reembed` during compact throws `WikiBusyError('compact', '*')` (T4 delta-4
   MAJOR-1); compact refused at start while a librarian is active throws
   `WikiBusyError('librarian', '*')`. **Scope (T3 delta-2 M2, corrected T3 delta-9 MAJOR-1):** the caught error
   covers **external-removal holds only** (`MaintenanceService.ts:397-401`). Event-retention
   holds **cannot arise in compact** — with `retainEventsFor: null` the retention block never
   runs (see above) — they apply only to standalone `runPrune`.
   Step 1 runs prune with **`vacuum: false`** — the per-entity VACUUM must not
   run N times; the wrapped store-wide VACUUM happens once at step 5 (T3 delta-2 m2). Known
   edge (T3 delta-7 m2, documented): with `pruneSupersededAfter` set, step 1 soft-deletes
   expired history stamped at/after this run's cutoff, so those rows hard-delete at the
   **next** compact — accepted. **Scope (T4 m5):** the expired-history soft-delete runs only
   for entities step 1 enumerates; an entity with expired history but no soft-deleted rows is
   never visited — the "next compact" claim holds only for enumerated entities.
   **Step 1b — registry tombstone hard-delete (T4 delta-6 MAJOR-1; store-wide per T4
   delta-7 MAJOR-1; owner question G):**
   compact hard-deletes **all** `source_ref_index` tombstones in one store-wide statement —
   `DELETE FROM source_ref_index WHERE deleted_at IS NOT NULL` — **not** per enumerated
   entity: step 1 enumerates only entities holding soft-deleted entries/tasks/events past
   the cutoff, so an entity whose facts a prior 7-day `runPrune` already hard-deleted (the
   forget → sweep path; every re-ingest also tombstones its prior row,
   `IngestionService.ts:749`) is never enumerated, and per-entity scoping would leave that
   entity's tombstone in the file forever (`SourceRefIndexRepository.ts:46-49` records both
   facts: "nothing reads a soft-deleted row and runPrune never sweeps this table"). Nothing
   reads a tombstone — `findActiveByEntityAndHash` filters live and the duplicate-hash
   check reads live rows only (`sourceStoreUpsert.ts:77`) — and ingest is fenced by
   compact's start refusal, so there is no per-entity reason to scope it. Still safe:
   the unique index is partial on `deleted_at IS NULL` (`schema.ts:62-64`), so removing
   tombstones blocks nothing; re-ingest ownership still works because the ingest pre-check
   looks for a **live** ref. (Today nothing but `clearAll` erases them —
   `MaintenanceService.ts:636-643` hard-deletes the table live-or-not; `forget({
   sourceRef })` soft-deletes the row, `MaintenanceService.ts:715-717`.) Fails the compact
   per the T3 M7 contract like every step. Under question G's alternative (documented
   carve-out) this step is dropped and §6 plus the guide state the tombstone retention
   explicitly instead. Tests: `forget({ sourceRef: R })` + `compact()` → the file contains
   no `source_ref_index` row carrying `R`, live or tombstoned; **variant (T4 delta-7
   MAJOR-1): `forget({ sourceRef: R })` → standalone `runPrune` → `compact()` → same
   assertion** (the sweep hard-deletes the facts first, so the entity is unenumerated).
2. **Source-store GC** (§5) — **conditional on owner question E** (E=default: absent in v1;
   E=GC: drains the durable `source_gc_pending` ledger after the INTENT rule-5 amendment,
   exact-pair matching, never collect-by-absence).
3. **Full FTS ledger drain** — entries and passages — via a **surfaced, `syncChain`-chained
   variant on `SearchService`** (never a bare `indexStrategy.drainPassages` call: today
   `syncPassages` serializes the drain behind queued entry rebuilds on `this.syncChain` and
   swallows failures, `SearchService.ts:349-357` — a bare drain would race a queued rebuild,
   T4 delta-4 m3), **no deadline, errors surfaced** (today `syncPassages` swallows failures,
   `SearchService.ts:353-355`, and
   `drainPassages` no-ops when passages are disabled, `Fts5IndexStrategy.ts:134`. T4 delta-2
   m2: `passagesDisabled` is set on **any** `ensurePassageObjects` throw at open
   (`Fts5IndexStrategy.ts:80-86`) — including stores with an empty passage ledger and nothing
   to erase — so compact **fails and reports** rather than claiming erasure (T3 M7) only when
   `passagesDisabled` **and** the `source_passages_fts_pending` ledger has rows (the ledger
   probe, `Fts5IndexStrategy.ts:136`, already exists); otherwise it warns and continues).
4. **Retired-table reclaim to completion** — `DROP` + delist for every
   `entries_fts_retired_N` and its shadow tables, **no deadline**, failures surfaced (today
   reclamation is deadline-bounded best-effort, `Fts5IndexStrategy.ts:410-452`; a retired
   table's `%_content` holds verbatim fact text and VACUUM would copy it intact — T3 M4).
   Required **whenever retired tables exist, even if `entries_fts` itself is missing** (a
   forced reset on a runtime where FTS later became unavailable still leaves verbatim text in
   the retired shadows — T3 delta m1). **Module-less runtime (T4 delta-7 MAJOR-2):** on a
   host whose FTS5 availability probe failed, `Fts5IndexStrategy` is never instantiated and
   `DROP TABLE` on a virtual table without its module throws `no such module: fts5` — both
   recorded in the code (`Fts5IndexStrategy.ts:109-113`, `createIndexStrategy.ts:54-58`;
   `delistRetired(name, true)` at `:453-455` issues the bare `DROP`). So on that runtime
   step 4 **cannot use `DROP`** and **cannot live in `Fts5IndexStrategy`** (see Files
   touched): compact runs a **module-independent fallback** — `DELETE FROM` each retired
   table's plain shadow tables (`<name>_content`, `<name>_data`, `<name>_idx`,
   `<name>_docsize`) under the `secure_delete` pragma (the row content is the erasure
   target; the virtual-table shell is inert), **keep the retired name listed**, and surface
   a `compact_retired_vtab_undroppable` diagnostic; a later FTS5-capable open's step 4
   completes the `DROP`. Skipping the fallback is the exact false-success the T3 M7
   contract forbids — compact would "succeed" while the retired shadows keep verbatim fact
   text that VACUUM copies intact. Test: no-FTS runtime with an `entries_fts_retired_N`
   present → shadow tables empty, name still listed, diagnostic surfaced. **Re-run after
   step 6 (T4 delta-5 m2):** a corruption
   reset during step 6's `syncEntries` can mint a fresh `entries_fts_retired_N` after step 4
   already ran (retirement happens only in `resetAndRearm`, `Fts5IndexStrategy.ts:307-324`) —
   compact **re-runs step 4 after step 6** (cheap when the list is empty), and the test
   asserts **no `entries_fts_retired_*` table exists when compact returns**.
5. **Wrapped VACUUM** — the watermark-safe sequence `resetNormalizeWatermarks` →
   `metadataRepo.vacuum()` → `restartRebuildAfterVacuum` (`MaintenanceService.ts:443-449`:
   VACUUM may renumber rowids; a watermark must never survive it; the restarted rebuild must
   snapshot the renumbered rowids). **Layering (T3 delta M2):** the wrapper lives in a
   `MaintenanceService` private method (`_wrappedVacuum()`) that both `runPrune` and `compact`
   call — moving it into `MetadataRepository.vacuum()` would create a repository→service
   dependency cycle (`restartRebuildAfterVacuum` comes from `services/search/fts5Progress`,
   `resetNormalizeWatermarks` from `db/sourceRefNormalize`, and both take `metadataRepo` as an
   argument). `vacuum()` itself gains **only** the post-VACUUM `wal_checkpoint(TRUNCATE)`.
   Compact must not call `metadataRepo.vacuum()` bare.
6. **`syncEntries` for the entities compact pruned** — **immediately after the VACUUM**
   (mirroring `runPrune`, `MaintenanceService.ts:451`) so the FTS index is rebuilt against
   the renumbered rowids; a no-op for ids already absent from the index (T3 delta-3 m1).
   Note: step 1's `runPrune` already ran `syncEntries` (pre-VACUUM) — that pass is
   **redundant but harmless**; do not "deduplicate" by removing this post-VACUUM one (T3
   delta-6 m2). **Id source (T3 delta-7 m1, named T3 delta-11 m5, contract T3 delta-12
   MINOR-1):** `runPrune` returns counts
   only (`:457`), so it
   gains an output option **`opts.syncedIds?: string[]`** (the output-array pattern shared with
   `deletedKeys`) that receives the ids
   it synced; compact passes those to step 6. **Contract: `syncedIds` holds the ids
   `runPrune` synced — a superset of the hard-deleted ids** (it may include
   `pruneSupersededAfter`-soft-deleted ids seeded at `:288`, and on hookless/legacy gates
   `deletable` is the requested list, so a row restored mid-run can appear). Step 6 treats it
   as best-effort input (`syncEntries` discards and re-reads each id — T4 delta-5 m3 wording:
   "throws out" read as "throws"; extra ids are
   harmless); the test asserts **containment**, not exact equality. **The output array is filled before
   `PrunePartialFailureError` throws** (at the `syncedIds` assembly, `:393`/`:451-455`), so a
   held-back entity still contributes its deleted ids to step 6 — test: a hold and a
   successful delete in the same compact, and step 6 receives a superset of the deleted ids
   (T3 delta-8 m1).
7. FTS `'optimize'` on both FTS tables when they exist — **after** `syncEntries`, so the
   delete markers `syncEntries` introduces are merged away under the pragma (a `rebuild`
   escape hatch is exposed as `compact({ rebuild: true })` for stores recovering from
   corruption).
8. `wal_checkpoint(TRUNCATE)` — **last** (`MetadataRepository.vacuum()` today checkpoints
   only before; the post-VACUUM, post-sync checkpoint is what clears everything — including
   any frames `syncEntries` wrote — through the WAL, so no delete-marker term bytes reappear
   in `%_data` or `-wal` after compact returns; T3 delta-3 m1). **Result-row observability
   (T4 delta-3 MAJOR-1):** `PRAGMA wal_checkpoint(TRUNCATE)` does not raise when it cannot
   complete — it returns a `(busy, log, checkpointed)` row and leaves the WAL untruncated,
   and today `MetadataRepository.ts:173` discards that row via `execAsync`. **Both**
   checkpoints (the existing pre-VACUUM one and the new post-VACUUM one) run via
   `getFirstAsync` and treat `busy !== 0` or `log !== checkpointed` as a surfaced step
   failure (`compact_checkpoint_incomplete` diagnostic; the compact report marks erasure
   **unverified**). Non-WAL stores: `PRAGMA wal_checkpoint` returns `(0, -1, -1)` off-WAL,
   which passes the `busy !== 0 || log !== checkpointed` test as "complete" — state this so
   the implementer does not "fix" it into a `log === 0` check (T4 delta-5 m5). Test: a
   two-connection fixture (a second reader holding a read open)
   asserts compact surfaces the incomplete-checkpoint diagnostic instead of returning
   success.

A store with no FTS tables (no-FTS runtime — hosts whose FTS5 availability probe fails, so
`createIndexStrategy.ts` falls back to `UnavailableIndexStrategy` (`createIndexStrategy.ts:123`);
there is no `enableFTS` option in the tree, T4 delta-6 m2) skips the FTS
steps (3, 4, 7) for surfaces that don't exist — but step 4 still runs for any retired tables
left behind — and remains correct: there is nothing to drain or optimize,
and the other steps still erase. **`syncEntries` never rejects** (`SearchService.ts:199-208`) —
it **resolves `false` only when a ledger drain failed** (the caller's ids were not applied), so
step 6 treats a `false` return as a **failed step** (T4 m3). VACUUM and checkpoint are whole-file operations — they
rewrite the host's own tables too, and VACUUM fails while the host holds a transaction on the
shared connection (guide 110-113); compact's locking contract states this (today locks are
per-entity, `MaintenanceService.ts:250`) and the whole-file scope joins owner question B's
INTENT.md:137-138 tension (T3 m6).

### 3. Chain forget — `forget({ entryId, includeChain: true })`

New optional flag on the entryId selector. Reuses `EntryRepository.findSupersessionChainIds`
(`:1085-1116`): both directions, capped at `HISTORY_MAX_DEPTH = 100`
(`TemporalService.ts:9`). The walk has **no `deleted_at` filter** — soft-deleted chain members
are included, which is the desired erasure semantics.

**Dry-run contract change (T3 M2):** `forgetDryRun` today **throws** on `entryId`/`taskId`
selectors (`MaintenanceService.ts:875-877`, "the spec keeps dry-run narrow" per the JSDoc at
`:864-865`). That rejection is **lifted for `entryId` when `includeChain` is set** (taskId
stays rejected): the preview returns `chainEntryIds` (every id the walk touches) and
`truncated: true` **with the depth cap stated** when the cap cut the walk. Truncation
detection needs the walk to expose depth — `findSupersessionChainIds` returns ids only, so the
walk gains a `maxDepth + 1` probe or a depth-returning CTE variant. Without this there is no
preview of a walk whose forward CTE (`EntryRepository.ts:1092-1102`) reaches the **live
current fact** — forgetting an old version would silently delete the current one.

**Explicit semantics (T3 m3):** the walk is **not the connected component** — from leaf A in a
fan-in A→C←B it reaches C but not B (the predecessor walk starts at the fact being forgotten,
`EntryRepository.ts:1103-1113`); the forward walk **does delete the live current fact** (that
is the point of `includeChain`, documented); chain ids are added to `deletedEntryIds` so
`syncEntries`, the vector-removal drain and `backstopEnqueue` cover them
(`MaintenanceService.ts:730-743`, drain at `:754`; T4 delta-7 m3). Chain members are
**soft-deleted** into the existing prune flow; their erasure completes at `compact()` like
every other fact.

Mutually exclusive with `clearAll` (existing selector rules unchanged; the flag composes only
with `entryId`). **Future selector cross-ref (T4 m6):** `forget({ eventId })` is the named
deletion path for retained quotes (INTENT.md:428-430, filed as **#386**) — the `ForgetParams`
typing and dry-run selector rules changed here must not box that selector in.

### 4. Optional immediate-erasure enhancement, gated (the issue's FTS5 option)

**No numbered migration (T3 M5).** `setup()` runs each migration once and stamps
`schema_version` unconditionally (`WikiMemory.ts:450-455`), so a v18 one-shot would stamp
every existing store as "done" while the gate passes no runtime today — upgraded stores would
**never** get the option even after a fixed SQLite ships. Instead the gate is evaluated **on
every open** inside `Fts5IndexStrategy.init` / `ensurePassageObjects` / `rearmInTx` via an
idempotent write in the **documented FTS5 command form** —
`INSERT INTO entries_fts(entries_fts, rank) VALUES('secure-delete', 1)` — which bumps the
config cookie so FTS5 reloads it and performs the format-5 upgrade the spec treats as the
one-way door (a direct `%_config` shadow-row write does neither and is undocumented; T4
delta-5 m1). `ft_config` stays the **read-back** surface: option set when the runtime passes
the gate, otherwise skipped
with a surfaced warning. The compact-time guarantee (§1-2) is unaffected either way.

**The gate is lower-bounded on the pinned first-good release — never an exclusion of a
known-buggy interval (T3 M6; rev 20's "equality-based" mislabeled a `>=` bound, T4 delta-3
m2).** The gate is
`sqlite_version() >= <first release containing the fix check-in 0b486e53a4>` — that release
does not exist yet, so **the gate is closed today** (no runtime passes); 3.53.4 is
"**treated as unfixed**" (not listed as fixed — the investigation's wording, T4 m8), never
asserted unfixed as fact. The version comparison is a **numeric tuple compare**
(major.minor.patch), never a string compare. Wording like
"outside the known-buggy range 3.46.0→3.53.2" is forbidden: it would admit 3.42.0-3.45.x
(untested, same merge code) and 3.53.3/3.53.4 (unfixed). **Gate-test detail (T4 m8, cite
corrected T4 delta-3 m3):** the
format-5 mock must raise a **non-`SQLITE_CORRUPT*` code** — FTS5 reports format mismatch as
`SQLITE_ERROR`, and the `ftsCorruptionClass` routing (`Fts5IndexStrategy.ts:737-742`, applied
at `:209`) sends `'corrupt'` to `resetAndRearm` only when the error is FTS-only and
`'vtab'` unconditionally — so only a non-CORRUPT code reaches the `UnavailableIndexStrategy`
path (§4).

Format-5 read errors on older builds (the one-way door): the real fallback path is
`initEntries` rethrow → `UnavailableIndexStrategy` (`Fts5IndexStrategy.ts:213`) — migration
v1 (`migrations.ts:12-19`) is a no-op kept for upgrade paths, **not** a read-error fallback
(T3 m4). Rolling the engine back to an older version after the option was set is **not
mitigable** and is documented as such.

The pragma (§1) is unconditional on every runtime — it has no version constraint and no format
door.

### 5. Source-store erasure: INTENT rule 5 governs — document-as-host-property is the v1 default (T4 BLOCKER-1)

**INTENT.md rule 5 (`INTENT.md:193-200`, re-affirmed by the 2026-11-15 amendment at
`:387-395` after the source store shipped) enumerates exactly when stored text leaves:**
`forget()` on the source, a changed copy stored under the same `sourceRef`, an entity wipe,
or an import with `merge: false`. Compact's last-fact GC would be a **fifth leaving path not
in that list** — a contradiction of intent, which per AGENTS.md makes the spec wrong until
INTENT is amended. The original §5 checked INTENT :135/:137/:468 but never rule 5 (T4
BLOCKER-1); rule 5 governs this data.

`forget({ entryId })` today leaves stored source text (`source_documents.text`,
`schema.ts:74`) on disk when the selector is entry-based. But `source_documents` rows are
host-owned data: they are written **only** by `storeSource` (`SourceStoreService.ts:43-73`,
exposed at `WikiMemory.ts:1110-1118`) and import (`ImportExportService.ts:180`) — **never** by
`remember` or `ingestDocument` (T3 B1/M1) — so a fact-less stored document is a normal,
supported state (`getStoredSource`, passage search).

**v1 decision (recommended default): document-as-host-property.** `compact()` does **not**
touch `source_documents`. The documented erasure path for stored text is
`forget({ sourceRef })`/`forget({ sourceHash })` — hard-deleting at forget time
(`MaintenanceService.ts:696-700`) — plus `clearAll`; both are already rule-5 paths, so **no
INTENT amendment is needed**. A `forget({ entryId })` erases everything **except** host-stored
source text; the guide (§6) states this scoping explicitly. Consequences: no GC machinery, no
`source_gc_pending` ledger in v1, and the B1 invariant (host-stored text survives compact)
holds trivially.

**The GC alternative — ships only if owner question E answers "GC"**, and then only after an
**INTENT rule-5 amendment naming compact-time GC as a fifth leaving path** (moved out of the
end-of-build batch; it gates §5-GC implementation, T4 BLOCKER-1). The full design negotiated
through T3 is retained here as that path's blueprint:

Decision (E=yes design): `compact()`'s GC pass drains a **durable pending-GC ledger** (T3 delta B1 — a
per-run candidate list is empty whenever the hard-deletes happened in an earlier `runPrune`,
which is exactly what the documented recipe and the 7-day automatic prune do):
- **Every prune that hard-deletes facts** — standalone `runPrune` (including the automatic
  7-day sweep) and compact's step 1 — records the
  `(entity_id, source_ref, source_hash)` keys of the rows it hard-deleted into a new
  **`source_gc_pending` ledger table** (new migration; unconditional schema, unlike the
  dropped v18). **The ledger insert commits in the same transaction as the entry
  hard-deletes** (T3 delta-2 M3: a crash between delete and insert would lose the key forever
  — exactly the collect-by-absence gap the ledger exists to close; crash-injection test
  required — failure injected **after `bulkDeletePruned` returns, before the ledger insert**,
  asserting the staged outbox rows (`EntryRepository.ts:868-878`) **and the rebuild-fingerprint
  re-anchor** (`reanchorRebuildFingerprint`, `:882`) roll back too; T3 delta-4
  m4). **Key source inside the transaction (T3 delta-3 M2, corrected T3 delta-7 MAJOR-2,
  nullability T3 delta-8 MAJOR-2):**
  `bulkDeletePruned` already runs
  `DELETE … RETURNING id` (`EntryRepository.ts:862-865`) and already collects deleted ids
  through its `{ deletedIds: string[] }` output option (declared `EntryRepository.ts:847`,
  filled `:867`; the option object originates at `MaintenanceService.ts:365` — T3 delta-11 m2). **`deletedIds` stays
  `string[]`** — it feeds `new Set(deletedIds)` (`:371`), `deletable` (`:377`),
  `deleteForFacts` (`:383-384`) and `syncedIds` (`:393`), all id-shaped; overloading it with
  key objects would break set membership and the vector-ledger cleanup. Instead: widen the
  statement to **`RETURNING id, source_ref, source_hash`** and add a **separate output option
  `deletedKeys?: { id: string; source_ref: string | null; source_hash: string | null }[]`**
  (both columns are nullable on `entries`, `schema.ts:13-14`) that receives the key tuples;
  the return value stays a row count. The in-transaction SELECT alternative is
  rejected: the guard at `:852-853` can keep rows the SELECT already read, making it
  over-inclusive.
  **All prune paths write the ledger**, including the
  `'none'`/hookless branch — a store whose `setup()` never ran, so no ledger table exists
  (`MaintenanceService.ts:338-348`; the removal gate there is `'hook'`, one of
  `'hook' | 'none' | 'force'` from `VectorRemovalService.ts:45-49` — `'legacy'` is the
  maintenance **mode** (the `:407-408` branch tests `'deferred'`/`'ops'`; `'legacy'` is
  the fallback arm), not a gate; T4 m2).
  **Gate on the GC ledger's own existence — nothing else (T3 delta-7 MAJOR-1, correcting T3
  delta-6 MAJOR-1):** the `gate === 'hook'` branch is **not** the only no-table path:
  `ledgerOn = !!vr && !!vrRepo && await vr.ledgerPresent()` (`:306`) is the **vector-removal**
  ledger flag, and `vectorRemoval` is an optional constructor argument (`:239`) — a fully
  set-up store with **no vector-removal service** has `ledgerOn === false` but **does** have
  the migrated `source_gc_pending` table. Gating the GC write on `ledgerOn` (or on the
  `:338` branch) would leave such a store with an empty ledger and surviving
  `source_documents.text` — the exact collect-by-absence gap this redesign closes. Therefore:
  **probe `source_gc_pending`'s existence directly, once per prune, outside the transaction**,
  independent of `ledgerOn`, the vector-removal gate, and the `:338` branch; if absent, skip
  the write and emit **`source_gc_degraded`**. Tests: prune with no `source_gc_pending` table
  still hard-deletes; **a store with no `vectorRemoval` service and a migrated schema still
  records ledger keys**.
- **Compact's GC step drains the ledger**: for each pending key, **in the same transaction as
  the deletes**, re-check that no live entry carries the key (a concurrent `remember` between
  steps can make a key live again — T3 delta m2), and if clear, hard-delete the key's
  `source_documents` row, its `source_passages`, and their FTS rows; keys still live are
  dropped from the ledger un-deleted. **Key matching predicate (T3 delta-4 MAJOR-1, corrected T3 delta-10 M1):**
  `source_documents` has **two** unique indexes — `(entity_id, source_ref)` and
  `(entity_id, source_hash)` (`schema.ts` `idx_source_documents_ref`/`idx_source_documents_hash`,
  created in `createSourceDocumentIndexesIfColumnsExist`) — and `entries.source_hash` and
  `entries.source_ref` are **nullable** (`schema.ts:13-14`), with `source_ref_index` tracking
  the canonical ref per hash (a document can be re-keyed to a new ref). **Ref-OR-hash matching
  is forbidden (T3 delta-10 M1):** `storeSource` upserts by ref (`SourceStoreService.ts:61-63`),
  so a host can replace the text under a ref — an old ledger key `(R, H1)` must NOT delete a
  document now stored at `(R, H2)` (the ref matches, the text is new). Therefore a document is
  a GC **candidate** only when the ledger key matches the document's **current
  `(source_ref, source_hash)` pair** exactly (T3 delta-11 M1, **narrowed to exact-pair by T4
  MAJOR-1** — the hash-alone branch is dropped):
  **`H_key IS NOT NULL AND H_doc = H_key AND R_doc = R_key`**. **Schema premise (T4 delta-2
  MAJOR-2):** `source_documents.source_ref` and `source_documents.source_hash` are
  `TEXT NOT NULL` (`schema.ts:72-73`), so `H_doc` can never be NULL — the former second clause
  ("both hashes NULL, ref match") matched nothing and is deleted; this also closes T3's
  nullability thread with a schema fact. **Why not hash-alone (T4 MAJOR-1):** `sourceStoreUpsert` refuses duplicate
  hashes across the store and live registry (`sourceStoreUpsert.ts:70-80`; upsert-by-ref
  logic: `sourceStoreUpsert.ts:53-93`, T4 m4), so a document can
  never be re-keyed in place — the only way `(R_new, H)` exists while `(R_old, H)` is pending
  is that the old document was already forgotten and the host **freshly re-stored** the text;
  `sourceStoreUpsert.ts:53-93`
  (T4 m4). Plain ref-OR-hash matching is also forbidden (T3 delta-10 M1: `storeSource` upserts
  by ref, so an old `(R, H1)` key must not delete new `(R, H2)` text; and a bare `H_doc ==
  H_key` rule would strand NULL-hash documents). It is **live** if any live entry matches it on
  **either** column (the
  conservative direction: liveness errs toward keeping). Because the document columns are NOT
  NULL, exact-pair matching implies a fact key with **either** column NULL can never match a
  stored document — such a key is dead ledger weight — so a key with **either** `source_ref`
  or `source_hash` NULL is not written to the ledger (T4 delta-2 MAJOR-2; supersedes T3
  delta-8 MAJOR-2's both-columns-NULL rule, which assumed NULLable document columns). Required
  test cases: a live fact sharing the ref but carrying a **different** hash keeps the
  document live; **a re-stored document (`R`, `H1`→`R`, `H2`) with no facts yet survives
  compact() when an old `(R, H1)` key drains** (T3 delta-10 / T4 MAJOR-1 scenario — the
  T3 "re-keyed document matched by old hash" case is deleted: re-keying in place is impossible
  under the duplicate-hash refusal). A
  `storeSource`-only document with zero facts therefore
  **always survives compact()** (its keys never enter the ledger). One document backing N
  facts is untouched while any live fact references it.
- Hosts that need per-document certainty use `sourceRef`/`sourceHash` selectors (hard-deleting
  the stored document at forget time — the facts themselves still soft-delete,
  `MaintenanceService.ts:696-700`/`:709`; T3 delta-3 m4).

**Owner question E (T3 B1 + T4 BLOCKER-1) — decide at the spec stop, before the plan:** does
forgetting the last fact referencing a stored document delete the host's stored text at all
(GC — requires the INTENT rule-5 amendment first), or is `forget({ sourceRef })` the erasure
path with compact() leaving host-stored text alone (document-as-host-property — **recommended
v1 default**)? E is **not** parked for the end-of-build batch: it gates the §5-GC design.

### 6. Docs: the deleting-data guide gets the erasure section

`apps/docs/src/content/docs/guides/deleting-data.md` gains: the erasure recipe
(`forget` → `compact()` — **no standalone `runPrune` step** (T3 delta-10 m2): compact's step 1
already prunes with `retainSoftDeletedFor: 0` and `retainEventsFor: null`, and a standalone
prune with default options would delete events older than 30 days, contradicting the
events-kept framing), the "guaranteed at compact-time, not forget-time"
scoping **with the `pruneSupersededAfter` caveat** (facts soft-deleted by step 1 during this
compact hard-delete at the *next* compact, and only for entities compact enumerated — T4 m5),
the host-stored-document statement (**stored documents survive compact; the erasure path for
them is `forget({ sourceRef })`** — T4 delta MAJOR-2; the GC census line applies only under
E=GC), the host-connection pragma
requirement, the copy census (events kept unless
`includeEvents`; drain the outbox; host-stored documents survive compact unless
`forget({ sourceRef })` or the E=GC path; manifest stays; exports bring data
back), the **VACUUM temporary-database residue window** (investigation §3.5 census: VACUUM
builds its temp copy outside the main file — host guidance is `PRAGMA temp_store=MEMORY`
for the compact call; T4 delta-7 m2), and the no-opt-out pragma statement.

## Files touched

- `packages/core/src/services/search/Fts5IndexStrategy.ts` — per-open gated option set
  (`init` / `ensurePassageObjects` / `rearmInTx`, idempotent write in the documented FTS5
  command form — `INSERT INTO entries_fts(entries_fts, rank) VALUES('secure-delete', 1)` —
  with `ft_config` as the read-back; T4 delta-5 m1); compact-time
  retired-table reclaim-to-completion + full ledger drain with surfaced errors —
  **on a module-less runtime the step-4 fallback reclaim lives beside compact in
  `MaintenanceService` instead (T4 delta-7 MAJOR-2): `Fts5IndexStrategy` is never
  instantiated on that runtime.**
- `packages/core/src/db/migrations.ts` — **only if owner question E answers GC**: new
  migration for the `source_gc_pending` ledger table (unconditional schema). No option
  migration (per-open gate, §4); under the v1 default there is **no** GC migration.
- `INTENT.md` — status lines touched by this behavior (implementation PR per house rule);
  **plus a rule-5 amendment naming compact-time GC as a fifth leaving path — only if E
  answers GC, and it gates §5-GC implementation** (T4 BLOCKER-1).
- `packages/core/src/db/schema.ts` / `packages/core/src/WikiMemory.ts` `setup()` —
  `PRAGMA secure_delete=ON` + read-back in `setup()` (T3 delta-2 m1: one file named).
- `packages/core/src/repositories/MetadataRepository.ts` — `vacuum()` gains **only** the
  post-VACUUM `wal_checkpoint(TRUNCATE)`; **both checkpoints read their result row**
  (`getFirstAsync`) and surface `busy !== 0` / `log !== checkpointed` (T4 delta-3 MAJOR-1);
  the watermark wrapper stays in
  `MaintenanceService._wrappedVacuum()` (T3 delta-2 M1 — §2 step 5 governs).
- `packages/core/src/services/MaintenanceService.ts` — `forget()` chain flag (incl. dry-run
  lift + `chainEntryIds`/`truncated`); `compact()` (8-step composition per §2, incl.
  source-store GC ledger drain — E=GC only — and `_wrappedVacuum()`); hold catching/reporting (external
  holds via the error channel; compact keeps all events, so no event-hold channel).
- `packages/core/src/WikiMemory.ts` — `compact()` public API + `forget` param typing.
- `packages/core/src/repositories/EntryRepository.ts` — depth-aware chain walk (truncation
  detection) + dry-run chain listing helper; `bulkDeletePruned` widens `RETURNING` to
  `id, source_ref, source_hash` and gains a `deletedKeys` output option (for the GC ledger;
  `deletedIds` stays `string[]` — T3 delta-7 MAJOR-2).
- `packages/core/src/services/SearchService.ts` — passage drain surfaced (no swallow) in the
  compact path — a surfaced, `syncChain`-chained variant, never a bare
  `indexStrategy.drainPassages` (T4 delta-4 m3).
- `apps/docs/src/content/docs/guides/deleting-data.md` — erasure section.
- `INTENT.md` — status lines touched by this behavior (updated in the implementation PR per
  house rule).

## Test plan

1. **Canary forensic test (the acceptance criterion) — two tiers** (the copies have different
   documented owners; see investigation §7/§8 Q5): the canary is a **single lowercase
   alphanumeric token** (byte-identical under the engine's `porter unicode61` tokenizer,
   verified via fts5vocab + pre-delete MATCH) — a mixed-case/hyphenated canary can only ever be
   found in the `%_content` copy, so a plain byte-scan proves nothing about the postings
   surface.
   - *Fact-path tier (restructured T4 delta MAJOR-3):* the canary lives **only in the fact** —
     fixture: `ingestDocument` with a stub provider — `ingestDocument` accepts
     `sourceRef`/`sourceHash` and writes `source_ref_index` (`IngestionService.ts:752`,
     `sourceRefIndexRepo.upsert`; `MaintenanceService.ts:710-717` is forget's soft-delete of
     the registry row — T4 delta-3 m1 cite fix)
     but **never writes `source_documents`** (only `SourceStoreService.ts:61` and
     `ImportExportService.ts:180` call `upsertStoredSource`; T4 delta-2 m4 — the fixture's
     canary isolation rests on this, not on `remember`'s `RememberInput`); and **no
     `storeSource`**, so nothing
     host-stored holds the canary) into a tempdir store with 300+ filler facts (multi-segment
     index). Then `forget({ entryId })`,
     `runPrune(entityId, { retainSoftDeletedFor: 0, retainEventsFor: null })` (T3 delta-8 m2 —
     explicit options; the bare default would delete 30-day-old events. T4 delta-2 m5 receipt:
     `retainSoftDeletedFor: 0` passes `_validatePruneDuration`
     (`MaintenanceService.ts:1788-1791` — rejects only negative/non-finite values), so the
     validator accepts 0), `compact()` —
     **assert whole-file absence**: canary absent from the entry row, all FTS surfaces (db
     file, `-wal`, `-journal`, `-shm`, **and every `%_data` block**). Because no host-stored
     document exists, whole-file absence is assertable at this tier. Variant (T4 delta-3 m5):
     the same fixture run as **exactly** `forget({ entryId })` → `compact()` — no standalone
     `runPrune` — so the documented §2 recipe (compact's step 1 → `syncedIds` → step 6) is
     itself under the canary. `events.summary` and the
     entity summary are documented carve-outs (owner question D). Host-stored text has its
     **own tier below** (T4 delta MAJOR-3); the E=GC ledger-exercise variant of this tier
     (with `storeSource` + the same-ref fact, asserting GC removal) runs only under E=GC.
   - *Full-wipe tier:* **seed every derived copy explicitly and assert each exists before the
     wipe** (T3 M1 — none of them arise from ingestion alone): an event whose `summary`
     carries the canary (via `write()`), an unsent outbox row, and an entity summary containing
     it. Then `clearAll({ includeEvents: true })` + outbox drain + `compact()`, **run
     hookless** (no vector-removal hook, or a removal-confirmed stub) — assert the canary is
     absent from the whole file. Whole-file absence claims are made only at this tier.
   Mirror scenario F and G (optimize and rebuild variants; K/K2 are the composed-sequence
   proof).
2. **H-mirror test:** after `setup()` sets the pragma, flip it **`PRAGMA secure_delete=OFF` on
   the same connection** (no engine hook needed — the pragma is per-connection), `'rebuild'`
   alone leaves the canary — **pins that `'rebuild'` alone is insufficient without the pragma**
   (the "pragma is unconditional" wording holds only after owner question B is answered).
3. **compact() holds:** with an unconfirmed external removal, `compact()` hard-deletes nothing
   held and reports the holds via `PrunePartialFailureError` semantics. **Events: compact
   deletes none** (`retainEventsFor: null`) — assert the event count is unchanged after
   compact (T3 delta-8 MAJOR-1; the `event_retention_held` diagnostic is out of scope for
   compact). Note step 1's internal `syncEntries` **ignores `false` returns** (`:451` discards
   the result) — step 6's surfaced `false` is the only failure observer, which is why step 6
   exists (T4 m5). Plus the
   **`source_gc_pending` (E=GC only)** (T3 delta-2 M3): a crash between the entry hard-delete and
   the `source_gc_pending` insert is impossible (same transaction) — inject a failure and
   assert neither the delete nor the ledger row landed.
4. **Chain forget:** fixture lineage with fan-in (A→C←B: forgetting A reaches C, not B —
   documented); dry-run lists exactly the walked ids, `truncated` + cap notice on truncation;
   real run soft-deletes the chain (chain ids covered by sync/drain/backstop); erasure
   completes after compact.
5. **Source GC (E=GC path only — under the v1 default these move to the "survives" cases
   above):** document backing two facts, one forgotten — document stays; both forgotten +
   compact — document and passages gone (including `source_passages_fts`). **B1 regression
   test:** a `storeSource`-only document with zero facts **survives `compact()`** unchanged —
   and under the v1 default **every** stored document survives compact.
   **Key-matching cases (GC path only, T3 delta-4 MAJOR-1 narrowed by T4 MAJOR-1; the
   NULL-match cases are deleted T4 delta-2 MAJOR-2 — `source_documents` ref/hash columns are
   NOT NULL, so a NULL-column key never enters the ledger):** a live fact sharing the ref but
   with a **different** hash keeps the document live; **a re-stored document (`R`, `H1`→`R`, `H2`) with no facts survives an
   old `(R, H1)` key** (the T3 re-key case is deleted — re-keying in place is impossible
   under the duplicate-hash refusal). **Task-only case (T4 MAJOR-2):** forget tasks only +
   compact → task rows gone from the file.
   **Source-document tier (T4 delta MAJOR-3 — scoped to owner question E):**
   - *v1 default:* `storeSource` the canary text (no facts), `forget({ entryId })` + compact →
     **the document survives** (host property); then `forget({ sourceRef: R })` + compact →
     **whole-file clean** (rule-5 path).
   - *E=GC:* the same fixture under the §5 blueprint → the GC removes document + passages +
     registry row on the drained key.
6. **Gate tests:** mock runtimes (refuses option / below the gate / format-5 read error) —
   the per-open gate warns and skips; no-FTS path stays green; pragma read-back surfaces
   refusal. Gate acceptance is tested against a mocked version **at and above** the pinned
   first-good release only — never a range.
7. **M3/M4 regression tests:** compact while FTS rebuild state is `rebuilding` (watermark
   reset + rebuild restart correct); a forced corruption reset leaves a retired table, then
   forget + compact reclaims it to completion and the whole-file scan is clean.
8. Baseline gates: `pnpm -r typecheck`, unit suite (wall-clock-flake-prone timeouts under load
   are re-run in isolation per the known flake signature).

## Rejected alternatives

- **FTS5 `'secure-delete'` option as the required mechanism** (the issue's proposal): version
  gate passes zero verifiable runtimes (upstream merge bug unfixed in every release the
  investigation could confirm) + one-way
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

Semver: new public API (`compact()`, `forget` flag) → minor. The exported `WikiBusyOperation`
union gains `'compact'` — the one public type whose shape changes. **The dry-run lift widens
two more public shapes additively and optionally (minor-safe; T4 delta-5 m4):**
`ForgetParams` gains `includeChain?`, `ForgetResult` gains `chainEntryIds`/`truncated`.
**The union-widening semver
call is a release-time owner ruling (owner question F; T4 delta-4 MAJOR-2):** the
`types.ts:1203-1207` note records a prior widening as a **breaking change** (`import`/
`forget` rode **v3.0.0**; exhaustive consumer switches must add a `default` arm), while
`'ontologyBackfill'` was added afterward and rode **minor** releases (v4.21–4.23, `feat:`
commits — verified against tag history: `807220be`/`19d0255c` shipped in v4.21.0,
`199df2e2` in v4.23.0; T4 delta-7 m4). Do not assert safety from the note — it documents the break. **Under the recommended v1
default (E=default) there is no new migration**; only if owner question E answers GC does a
migration create the `source_gc_pending` ledger table (unconditional schema — consumers run
their migration sweep on upgrade) (T4 delta-2 MAJOR-3: the unconditional wording contradicted
§5 and Files touched). There is **no v18 option migration**: the FTS5 `'secure-delete'` option is
decided by the per-open gate (§4) on every open — a no-op with a surfaced warning while the
gate is closed, self-arming when a fixed SQLite ships. No format change occurs unless the
gate passes (and then the one-way door applies, documented).

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
- **C.** Ship the gated immediate-erasure enhancement in v1 (recommended) or **defer the
  gated option entirely** (no per-open gate, compact-time only; the gate code ships when a
  fixed SQLite release exists).
- **D.** Events and entity-summary erasure scope (investigation §8 Q5): a single-fact
  `forget({ entryId })` cannot promise whole-file erasure while `events.summary` holds fact
  text and only `clearAll({ includeEvents: true })` deletes events. (a) documented host-step
  carve-out (recommended — guide states the full-wipe steps); (b) engine-side scoped event
  deletion on forget; (c) engine-side entity-summary rewrite. Cross-ref: `forget({ eventId })`
  (#386, INTENT.md:428-430) is the named future path for retained-quote deletion (T4 m6).
- **E.** Source-document ownership on last-fact forget (T3 B1 + T4 BLOCKER-1): **recommended
  v1 default is document-as-host-property** — compact leaves host-stored text alone;
  `forget({ sourceRef })`/`forget({ sourceHash })` (already rule-5 paths) and `clearAll` are
  the documented erasure paths. The alternative (compact-time GC) **requires an INTENT rule-5
  amendment first** and ships the §5 blueprint design.
- **F.** Semver for the `WikiBusyOperation` union widening (`'compact'`; T4 delta-4 MAJOR-2):
  the `types.ts:1203-1207` note records a prior widening as **breaking** (`import`/`forget`
  rode v3.0.0), while `'ontologyBackfill'` rode minor releases afterward (v4.21–4.23;
  verified against tag history, T4 delta-7 m4). Ride
  the minor (recommended — the union is diagnostic metadata on an error type) or force a
  major? Ruled at release time, before the version bump.
- **G.** `source_ref_index` tombstone erasure (T4 delta-6 MAJOR-1, store-wide per T4
  delta-7 MAJOR-1): compact **step 1b** runs one store-wide
  `DELETE FROM source_ref_index WHERE deleted_at IS NOT NULL` (recommended — tombstones are
  the only `forget({ sourceRef })` residue compact otherwise leaves in the file, nothing
  reads them, and removing them blocks nothing: the unique index is partial on live rows,
  `schema.ts:62-64`) — or keep the tombstones and document the carve-out in §6 and the
  deleting-data guide instead, dropping step 1b.
