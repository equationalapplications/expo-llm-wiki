# Forget must erase — FTS5 erasure, chain forget, erase()

**Status: rev 28 — implementation folded through Opus delta r2 (PR #404) — rev 27 folded the owner spec stop A–H RATIFIED (2026-11-17); rev 28
genericized all private-repo host references per owner ruling (2026-11-17: the family's
hosted cloud service is private and provides no value to the engine's public docs —
retention opinions stay
host-side). Rulings folded in rev 27: strict
store-wide erase, no retention override (A); secure_delete always-on at FULL, no opt-out,
failed pre-check = honest failure (B); gated immediate-erasure DEFERRED to a later explicit
host opt-in, never self-arming (C); documented host-step carve-out for events/summaries (D);
document-as-host-property, no engine GC — the immutable-source-files founding principle binds
(E); WikiBusyOperation widening rides the MINOR with the policy written into the type's JSDoc
(F); step 1b kept, source_ref_index tombstones deleted store-wide (G); compact() renamed
erase() throughout (H). INTENT alignment: rule 5 already names every leaving path — no
rule-5 amendment is needed; the GC alternative is rejected, not deferred.**  
**Issue:** equationalapplications/expo-llm-wiki#401 · **Investigation:** [`investigation.md`](./investigation.md) (rev 12, converged)

## Problem

A `forget()` call does not erase. Facts are soft-deleted and hard-delete only through
`runPrune` (default 7-day retention); FTS5 postings and row content survive deletes in the
database file; WAL/journal residue is host-dependent. A hosted deployment gates
its privacy promises on real erasure: its founding charter promises
deletion — "a delete the host's index never heard about is not done"; this spec **extends that precedent**
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
erase step 1b under owner ruling G: tombstones are deleted store-wide, no exceptions;
census row added T4 delta-6 MAJOR-1),
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
full erase() composition as one unit, also clean; a second independent run (A-H2) **and a
third full run including K/K2** are recorded in
the LEDGER; these are synthetic-schema proofs of the *mechanism* — the engine-schema proof is
the acceptance test below): core pragma + plain delete + FTS `'optimize'`
**or** `'rebuild'` + `wal_checkpoint(TRUNCATE)` erases the canary completely.

## The decisions

### 1. The erasure guarantee lives at erase-time, not at forget-time

`PRAGMA secure_delete=ON` is set in `setup()` on the **host-provided handle** (the engine never
opens connections; INTENT.md:137, guide §157). **Owner ruling B (2026-11-17): `secure_delete=FULL`, always on, no opt-out, on every
release.** The pragma is read back after setting and surfaced: if the
runtime refuses it, `setup()` warns — and the erase-time step-0 read-back (§2) turns a
refusal that slipped past setup into an honest erase failure, not a false success. Errata
(implementation probe, 2026-11-17): SQLite has no `FULL` pragma value — the literal
`PRAGMA secure_delete=FULL` is a silent no-op (reads back 0). Ruling B's "FULL" means the
full-zeroing level, which is pragma value `ON` (reads back `1`); `FAST` (`2`, partial) is
rejected. The implementation and every read-back check in this spec use `ON`/`1` — writing
the literal `FULL` anywhere would silently disable erasure (T1 probe on SQLite 3.53.4). The
pragma is connection-wide and ATTACH-wide: it changes delete behavior and write cost for the
host's own tables (INTENT.md:137-138 tension); the owner accepted that cost — without the
pragma even `'rebuild'` leaves text in freed pages (scenario H), and `FULL` is the level the
erasure guarantee is proven at. Host connections that write wiki tables
themselves must set the pragma too (documented; guide §"If your app writes to the wiki tables
itself"). No opt-out option exists and none will be added.

The erasure promise is scoped: **erasure of the store file is guaranteed at `erase()` time,
not at `forget()` time.** Between them the soft-delete window and journal residue remain
(deterministically, not accidentally). The deleting-data guide states this explicitly.

### 2. `erase()` — the erasure API

Store-wide `wiki.erase()` (owner ruling A, 2026-11-17: strict store-wide erasure, **no
`retainSoftDeletedFor` override** — erase accepts no retention knob; hosts that want archives
keep superseded rows, which erase never touches; a **new public API** — no method or
public API named `erase` exists in the tree; `types.ts:1186` has only a `erase?: boolean`
format-context option, no collision — T4 m1). Composition, in order (T3 M7 — each step
surfaces errors; a failed step fails the erase and reports where it stopped):

0. **Runtime pragma verification (T4 delta-8 MAJOR-1)** — read `PRAGMA secure_delete` on
   the connection erase is about to use; if it is not `1`, re-assert it and read back, or
   fail the erase with a `erase_secure_delete_off` diagnostic marking erasure
   **unverified**. Rationale: the pragma is load-bearing (scenario H: without it even
   `'rebuild'` leaves text in freed pages) and setup()-time set-and-read-back does not
   survive a host flipping it OFF on the shared connection afterward — the spec's own
   H-mirror test demonstrates exactly that flip — nor does the setup-time pragma cover an
   adapter that multiplexes more than one underlying connection (it may have landed on a
   different handle; the single-connection adapter assumption is stated beside
   INTENT.md:137). Without step 0, every step can succeed, both checkpoints can report
   complete, and the report claims erasure while the canary sits in freed pages and
   `%_data` — the false success the T3 M7 contract forbids. Test: flip the pragma OFF
   after setup, call `erase()`, assert the step-0 failure instead of success.

1. **Per-entity prune** with `retainSoftDeletedFor: 0` **and `retainEventsFor: null`** — events
   are genuinely **kept** by erase (T3 delta-6 MAJOR-2: the engine default is
   `pruneEventsAfter ?? 30` (`MaintenanceService.ts:254`), which silently deletes events older
   than 30 days — the opposite of this spec's "events kept unless an `includeEvents`-shaped
   opt-in" framing; erase passes `retainEventsFor: null` explicitly, and the opt-in for
   event deletion is the `clearAll({ includeEvents: true })` full-wipe path, owner ruling D).
   **Consequence (T3 delta-8 MAJOR-1):** with `null`, the entire event-retention block is
   skipped (`if (retainEventsFor !== null)`, `MaintenanceService.ts:406` — including
   `countHeldBack` and the `event_retention_held` diagnostic at `:435-439`), so erase has
   **no event holds to report** — events are simply never deleted. Holds reporting in erase
   covers **external-removal holds only**. (The `'legacy'`-mode watermark caveat below applies
   to **standalone `runPrune`** calls, not to erase under the null pin.)
   Inheriting `runPrune`'s safety
   holds: no hard-delete of facts whose external-index removal is unconfirmed (guide 55-56).
   Holds are **caught per entity** (`PrunePartialFailureError`, `MaintenanceService.ts:452-455`): erase
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
   — T4 delta-3 m4) — rather than a new UNION query. Test: task-only forget + erase → task rows gone from the file.
   A `WikiBusyError` on a per-entity `'prune'` lock (`acquireLock('prune', entityId)`,
   `MaintenanceService.ts:250` — T3 delta-11 m1; `:459` is the release call) — a concurrent
   operation on that entity — **skips that entity** with a surfaced diagnostic and does not
   fail the erase; the report lists skipped entities. **Erase's own lock (T4 m7,
   concretized T4 delta MAJOR-1):** `'erase'` does **not** exist in `OperationType`
   (`JobManager.ts:3-14`) or `WikiBusyOperation` (`types.ts:1209-1218`), and `acquireLock` is
   a hand-written per-operation switch (`JobManager.ts:190-299`) — the `'*'` at
   `MaintenanceService.ts:530-531` is two distinct operations (`'reembed'`/`'global_reembed'`),
   each with its own branch. So: **add `'erase'` to both enums** (the `WikiBusyOperation` union widening is a
   **prerequisite of this section**, not just a release note — the universal pre-check's
   `WikiBusyError('erase', '*')` does not type-check without it; cross-ref from the
   Release section, T4 delta-8 m6); `acquireLock`/`releaseLock`
   gain a `'erase'` case — and, **instead of per-arm erase checks (T4 delta-4 MAJOR-1: the
   rev-21 per-arm enumeration missed `global_reembed`, `JobManager.ts:236-247`, and any future
   arm), ONE universal pre-check beside the `global_import` pre-check
   (`JobManager.ts:193-195`):**
   `operation !== 'erase' && !(operation === 'prune' && owner === 'erase') &&
   this.activeMaintenanceJobs.has(this._eraseKey())` →
   `throw new WikiBusyError('erase', '*')`.
   Every present and future operation except erase itself and erase-owned prune is refused
   while erase holds the key, in one place. Pin `_eraseKey()` to `` `${prefix}:erase` ``
   so no suffix scan matches it, and exclude `'erase'` from the `lockKeyFns` map type
   (`JobManager.ts:104-107`, typed over `Exclude<OperationType, ...>`) — or `releaseLock`'s
   per-operation fallthrough (`:322`) indexes a missing entry (T4 delta-7 m1). **The same
   check is mirrored in `isBlocked` (`JobManager.ts:332-389`, T4 delta-7 MAJOR-3)** — a
   parallel hand-written decision copy that already duplicates the `global_import` pre-check
   (`:333`) and which `write()` consults before its auto-librarian/auto-heal triggers
   (`WriteService.ts:145`, `:154`, `:194`). Without the mirror, every `write()` during
   erase advances the memory checkpoint inside its transaction
   (`WriteService.ts:149-150`), has `acquireLock('librarian')` throw at `:172`, and rolls
   the checkpoint back in a **second, unlocked** transaction (`:189-192`) — extra unfenced
   transactions in exactly the window step 5's VACUUM is most exposed; the heal branch at
   `:194` behaves the same. The mirror uses the **simpler form**
   `operation !== 'erase' && this.activeMaintenanceJobs.has(this._eraseKey())` —
   `isBlocked(operation, entityId)` (`JobManager.ts:332`) carries no `owner` parameter, and
   it is consulted only for `librarian`/`heal` from `write()`, so the erase-owned-prune
   exemption cannot arise there (T4 delta-8 m2). Test: `write()` during erase neither advances nor rolls back
   the memory checkpoint. The `'erase'` arm self-checks first (a second
   concurrent `erase()` throws `WikiBusyError('erase', '*')` — mirroring the self-key
   check that opens `global_reembed`'s arm, `JobManager.ts:237`; T4 delta-4 m2) and
   **inherits** — not mirrors — the `global_import` pre-check so erase refuses to start
   during a global import: the existing pre-check (`JobManager.ts:193`) fires for every
   operation **except** `global_import`, including `erase`, so no new code is needed
   there (T4 delta-8 m5; the pairing is bidirectional: a global import refuses during
   erase via the universal pre-check). The `WikiBusyError` construction (`JobManager.ts:295-298`) passes `'*'` only
   for the two global ops — add `'erase'` there so `WikiBusyError('erase', '*')` actually
   carries `'*'`. **Erase's acquisition rule (T4 delta-3 MAJOR-2):** erase starts with
   `acquireLock('erase', '*')`, and the `'erase'` arm mirrors `global_reembed`'s
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
   explicit check + reverse-direction test are folded as hardening: erase refused while a
   global re-embed is active throws `WikiBusyError('reembed', '*')`).
   This is what keeps steps 5-6's store-wide VACUUM out from under an in-flight transaction —
   a librarian/ingest running when erase starts would otherwise hold the connection at step
   5 and VACUUM throws "cannot VACUUM from within a transaction". **Fence boundary (T4
   delta-5 MAJOR-1):** the start refusal fences only operations that **call `acquireLock`**
   (librarian, heal, ingest, store, prune, ontologyBackfill, forget, reembed/global_reembed —
   plus erase itself). `write()`/`remember()` event appends run `withTransactionAsync`
   **without any lock** (`WriteService.ts:102`, `:124`; the only lock in that file is the
   inline librarian at `:172`), and the setup-time external-deletion drain runs unlocked
   short transactions on the shared connection for up to 10 s (guide 108-113). These paths
   are **not fenced**: a write transaction open between erase's steps 4 and 5 makes step
   5's VACUUM throw "cannot VACUUM from within a transaction". **Already-queued
   `syncChain` work (T4 delta-8 m4):** step 3's passage drain chains on `this.syncChain`
   (`SearchService.ts:349-357` — every rebuild queued on that chain runs unlocked), so
   erase **awaits the full chain**, draining a rebuild queued before erase started
   before step 5; any **new** chain entries created mid-erase by unfenced writes fall
   under the same reported, retryable step-5 failure. That failure is a **reported,
   retryable step failure** under the T3 M7 semantics: erase has pruned but **not erased**,
   the report says exactly that (bytes may remain in freed pages/`%_data`), and the host
   re-runs erase — it is never a false success. (§5's concurrent-`remember` caveat is the
   same unfenced boundary.) Test: a `write()` racing erase's step 5 surfaces the
   deterministic step-5 failure rather than success. **The erase-owner
   mechanism for step 1 (T4 delta-3 MAJOR-2, param placement T4 delta-4 m4):**
   `MaintenanceService` gains a private `_runPrune(entityId, opts, owner)`; public `runPrune`
   passes `owner: 'host'`, erase's step 1 passes `owner: 'erase'`; `acquireLock` gains a
   **fourth parameter** `owner` (default `'host'` — the existing third positional parameter
   `sourceRef?`, `JobManager.ts:190`, is not reused). The universal pre-check exempts only
   erase-owned prune; step 1 still traverses the `prune` case normally — the arm erase's
   step 1 goes through (`JobManager.ts:198-207`; every per-entity arm detects in-flight work
   on its own entity — T4 delta-4 m1 reword). Under the start-refusal the per-entity skip is
   not expected to fire; it stays as defense-in-depth — a lock that slipped the acquisition
   window surfaces as a skip diagnostic, not a hard failure (if erase-owned prune consulted
   the erase key, step 1 would throw `WikiBusyError` on every entity and erase would
   "succeed" having deleted nothing). Symmetrically, an **external standalone `runPrune`
   during erase's steps 3-8 is refused**: `owner: 'host'` fails the universal pre-check's
   exemption, so a host `runPrune(e, { vacuum: true })` cannot interleave a second VACUUM /
   `restartRebuildAfterVacuum` with erase's steps 5-6. Tests: erase with N
   entities hard-deletes in all N; a concurrent `storeSource` during erase throws
   `WikiBusyError('erase', '*')`; a standalone `runPrune` during erase throws
   `WikiBusyError('erase', '*')` (universal pre-check — the blocker is store-wide);
   a second concurrent `erase()` throws `WikiBusyError('erase', '*')` (self-check); a
   `global_reembed` during erase throws `WikiBusyError('erase', '*')` (T4 delta-4
   MAJOR-1); erase refused at start while a librarian is active throws
   `WikiBusyError('librarian', '*')`. **Scope (T3 delta-2 M2, corrected T3 delta-9 MAJOR-1):** the caught error
   covers **external-removal holds only** (`MaintenanceService.ts:397-401`). Event-retention
   holds **cannot arise in erase** — with `retainEventsFor: null` the retention block never
   runs (see above) — they apply only to standalone `runPrune`.
   Step 1 runs prune with **`vacuum: false`** — the per-entity VACUUM must not
   run N times; the wrapped store-wide VACUUM happens once at step 5 (T3 delta-2 m2). Known
   edge (T3 delta-7 m2, documented): with `pruneSupersededAfter` set, step 1 soft-deletes
   expired history stamped at/after this run's cutoff, so those rows hard-delete at the
   **next** erase — accepted. **Scope (T4 m5):** the expired-history soft-delete runs only
   for entities step 1 enumerates; an entity with expired history but no soft-deleted rows is
   never visited — the "next erase" claim holds only for enumerated entities.
   **Step 1b — registry tombstone hard-delete (T4 delta-6 MAJOR-1; store-wide per T4
   delta-7 MAJOR-1; owner ruling G: deleted store-wide, no exceptions):**
   erase hard-deletes **all** `source_ref_index` tombstones in one store-wide statement —
   `DELETE FROM source_ref_index WHERE deleted_at IS NOT NULL` — **not** per enumerated
   entity, and **only after a `sourceRefIndexPresent(tx)` probe** (mirroring `clearAll`'s
   guard, `MaintenanceService.ts:640-643`): a pre-v9 store lacks the table, and under a
   `refuse`/`auto` migration gate it can reach runtime — without the probe, step 1b throws
   "no such table" and fails every erase on that store (T4 delta-8 m1; skip with a
   diagnostic when absent). Per-entity scoping would be wrong:
   step 1 enumerates only entities holding soft-deleted entries/tasks/events past
   the cutoff, so an entity whose facts a prior 7-day `runPrune` already hard-deleted (the
   forget → sweep path; every re-ingest also tombstones its prior row,
   `IngestionService.ts:749`) is never enumerated, and per-entity scoping would leave that
   entity's tombstone in the file forever (`SourceRefIndexRepository.ts:46-49` records both
   facts: "nothing reads a soft-deleted row and runPrune never sweeps this table"). Nothing
   reads a tombstone — `findActiveByEntityAndHash` filters live and the duplicate-hash
   check reads live rows only (`sourceStoreUpsert.ts:77`) — and ingest is fenced by
   erase's start refusal, so there is no per-entity reason to scope it. Still safe:
   the unique index is partial on `deleted_at IS NULL` (`schema.ts:62-64`), so removing
   tombstones blocks nothing; re-ingest ownership still works because the ingest pre-check
   looks for a **live** ref. (Today nothing but `clearAll` erases them —
   `MaintenanceService.ts:636-643` hard-deletes the table live-or-not; `forget({
   sourceRef })` soft-deletes the row, `MaintenanceService.ts:715-717`.) Fails the erase
   per the T3 M7 contract like every step. Owner ruling G (2026-11-17): step 1b is kept and the deletion
   is store-wide — erase leaves nothing behind, no exceptions; there is no documented
   tombstone carve-out. Tests: `forget({ sourceRef: R })` + `erase()` → the file contains
   no `source_ref_index` row carrying `R`, live or tombstoned; **variant (T4 delta-7
   MAJOR-1): `forget({ sourceRef: R })` → standalone `runPrune` → `erase()` → same
   assertion** (the sweep hard-deletes the facts first, so the entity is unenumerated).
2. **Source-store GC** (§5) — **absent, permanently (owner ruling E, 2026-11-17):
   document-as-host-property, no engine GC.** The engine never mutates or auto-deletes
   source documents — the founding principle of the LLM Wiki pattern (immutable source
   files) binds engine design. There is no `source_gc_pending` ledger, no GC step, and no
   INTENT rule-5 amendment.
3. **Full FTS ledger drain** — entries and passages — via a **surfaced, `syncChain`-chained
   variant on `SearchService`** (never a bare `indexStrategy.drainPassages` call: today
   `syncPassages` serializes the drain behind queued entry rebuilds on `this.syncChain` and
   swallows failures, `SearchService.ts:349-357` — a bare drain would race a queued rebuild,
   T4 delta-4 m3), **no deadline, errors surfaced** (today `syncPassages` swallows failures,
   `SearchService.ts:353-355`, and
   `drainPassages` no-ops when passages are disabled, `Fts5IndexStrategy.ts:134`. T4 delta-2
   m2: `passagesDisabled` is set on **any** `ensurePassageObjects` throw at open
   (`Fts5IndexStrategy.ts:80-86`) — including stores with an empty passage ledger and nothing
   to erase — so erase **fails and reports** rather than claiming erasure (T3 M7) only when
   `passagesDisabled` **and** the `source_passages_fts_pending` ledger has rows (the ledger
   probe, `Fts5IndexStrategy.ts:136`, already exists); otherwise it warns and continues).
   Errata (delta r2/r3, 2026-11-17): when FTS5 init fails on this open and the engine falls
   back to `UnavailableIndexStrategy` (FTS tables still present, triggers alive), erase fails
   with an unverified report whenever either FTS ledger still holds rows — queued deletes mean
   undrained text, which cannot be claimed erased. A runtime that never had FTS5 at all
   detaches with the ledgers dropped (nothing to drain). A module-less runtime that earlier ran
   FTS5 keeps the live `entries_fts`/`source_passages_fts` content tables, whose stored text
   erase does not reach today — known limitation, tracked in issue #407.
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
   `delistRetired(name, true)` at `:454-457` issues the bare `DROP` at `:456`; T4 delta-8
   m5). So on that runtime
   step 4 **cannot use `DROP`** and **cannot live in `Fts5IndexStrategy`** (see Files
   touched): erase runs a **module-independent fallback** — `DELETE FROM` each retired
   table's plain shadow tables (`<name>_content`, `<name>_data`, `<name>_idx`,
   `<name>_docsize`, `<name>_config` — it holds no text but is listed for completeness,
   T4 delta-8 m3) under the `secure_delete` pragma (the row content is the erasure
   target; the virtual-table shell is inert), **keep the retired name listed**, and surface
   a `erase_retired_vtab_undroppable` diagnostic; a later FTS5-capable open's step 4
   completes the `DROP`. **Hollowed-shell expectation (T4 delta-8 m3):** after the
   `_data` delete the retired table's structure record is gone, so the ordinary open
   path's read (`SELECT rowid FROM ${name} LIMIT 1`, `Fts5IndexStrategy.ts:437`) raises
   `SQLITE_CORRUPT_VTAB` — that is **designed**, not accidental: `reclaimRetired`'s
   corruption-class catch (`:421-428`) is the exit that performs the `DROP`. State it so an
   implementer does not "fix" the corruption error, and erase's own step 4 must `DROP`
   without reading first. Skipping the fallback is the exact false-success the T3 M7
   contract forbids — erase would "succeed" while the retired shadows keep verbatim fact
   text that VACUUM copies intact. Test: no-FTS runtime with an `entries_fts_retired_N`
   present → shadow tables empty, name still listed, diagnostic surfaced. **Re-run after
   step 6 (T4 delta-5 m2):** a corruption
   reset during step 6's `syncEntries` can mint a fresh `entries_fts_retired_N` after step 4
   already ran (retirement happens only in `resetAndRearm`, `Fts5IndexStrategy.ts:307-324`) —
   erase **re-runs step 4 after step 6** (cheap when the list is empty), and the test
   asserts **no `entries_fts_retired_*` table exists when erase returns**.
5. **Wrapped VACUUM** — the watermark-safe sequence `resetNormalizeWatermarks` →
   `metadataRepo.vacuum()` → `restartRebuildAfterVacuum` (`MaintenanceService.ts:443-449`:
   VACUUM may renumber rowids; a watermark must never survive it; the restarted rebuild must
   snapshot the renumbered rowids). **Layering (T3 delta M2):** the wrapper lives in a
   `MaintenanceService` private method (`_wrappedVacuum()`) that both `runPrune` and `erase`
   call — moving it into `MetadataRepository.vacuum()` would create a repository→service
   dependency cycle (`restartRebuildAfterVacuum` comes from `services/search/fts5Progress`,
   `resetNormalizeWatermarks` from `db/sourceRefNormalize`, and both take `metadataRepo` as an
   argument). `vacuum()` itself gains **only** the post-VACUUM `wal_checkpoint(TRUNCATE)`.
   Erase must not call `metadataRepo.vacuum()` bare.
6. **`syncEntries` for the entities erase pruned** — **immediately after the VACUUM**
   (mirroring `runPrune`, `MaintenanceService.ts:451`) so the FTS index is rebuilt against
   the renumbered rowids; a no-op for ids already absent from the index (T3 delta-3 m1).
   Note: step 1's `runPrune` already ran `syncEntries` (pre-VACUUM) — that pass is
   **redundant but harmless**; do not "deduplicate" by removing this post-VACUUM one (T3
   delta-6 m2). **Id source (T3 delta-7 m1, named T3 delta-11 m5, contract T3 delta-12
   MINOR-1):** `runPrune` returns counts
   only (`:457`), so it
   gains an output option **`opts.syncedIds?: string[]`** (the output-array pattern shared with
   `deletedKeys`) that receives the ids
   it synced; erase passes those to step 6. **Contract: `syncedIds` holds the ids
   `runPrune` synced — a superset of the hard-deleted ids** (it may include
   `pruneSupersededAfter`-soft-deleted ids seeded at `:288`, and on hookless/legacy gates
   `deletable` is the requested list, so a row restored mid-run can appear). Step 6 treats it
   as best-effort input (`syncEntries` discards and re-reads each id — T4 delta-5 m3 wording:
   "throws out" read as "throws"; extra ids are
   harmless); the test asserts **containment**, not exact equality. **The output array is filled before
   `PrunePartialFailureError` throws** (at the `syncedIds` assembly, `:393`/`:451-455`), so a
   held-back entity still contributes its deleted ids to step 6 — test: a hold and a
   successful delete in the same erase, and step 6 receives a superset of the deleted ids
   (T3 delta-8 m1).
7. FTS `'optimize'` on both FTS tables when they exist — **after** `syncEntries`, so the
   delete markers `syncEntries` introduces are merged away under the pragma (a `rebuild`
   escape hatch is exposed as `erase({ rebuild: true })` for stores recovering from
   corruption).
8. `wal_checkpoint(TRUNCATE)` — **last** (`MetadataRepository.vacuum()` today checkpoints
   only before; the post-VACUUM, post-sync checkpoint is what clears everything — including
   any frames `syncEntries` wrote — through the WAL, so no delete-marker term bytes reappear
   in `%_data` or `-wal` after erase returns; T3 delta-3 m1). **Result-row observability
   (T4 delta-3 MAJOR-1):** `PRAGMA wal_checkpoint(TRUNCATE)` does not raise when it cannot
   complete — it returns a `(busy, log, checkpointed)` row and leaves the WAL untruncated,
   and today `MetadataRepository.ts:173` discards that row via `execAsync`. **Both**
   checkpoints (the existing pre-VACUUM one and the new post-VACUUM one) run via
   `getFirstAsync` and treat `busy !== 0` or `log !== checkpointed` as a surfaced step
   failure (`erase_checkpoint_incomplete` diagnostic; the erase report marks erasure
   **unverified**). Non-WAL stores: `PRAGMA wal_checkpoint` returns `(0, -1, -1)` off-WAL,
   which passes the `busy !== 0 || log !== checkpointed` test as "complete" — state this so
   the implementer does not "fix" it into a `log === 0` check (T4 delta-5 m5). Test: a
   two-connection fixture (a second reader holding a read open)
   asserts erase surfaces the incomplete-checkpoint diagnostic instead of returning
   success.

A store with no FTS tables (hosts whose FTS5 availability probe fails on every open, so
`createIndexStrategy.ts` falls back to `UnavailableIndexStrategy` (`createIndexStrategy.ts:123`);
there is no `enableFTS` option in the tree, T4 delta-6 m2) skips the FTS
steps (3, 4, 7) for surfaces that don't exist — but step 4 still runs for any retired tables
left behind, and step 3's ledger guard fails the erase (unverified) whenever either FTS ledger
still holds rows (delta r2 errata, above). A module-less runtime that earlier ran FTS5 keeps
the live FTS content tables, whose stored text erase does not reach today — issue #407.
For a runtime that never had FTS5 at all there is nothing to drain or optimize,
and the other steps still erase. **`syncEntries` never rejects** (`SearchService.ts:199-208`) —
it **resolves `false` only when a ledger drain failed** (the caller's ids were not applied), so
step 6 treats a `false` return as a **failed step** (T4 m3). VACUUM and checkpoint are whole-file operations — they
rewrite the host's own tables too, and VACUUM fails while the host holds a transaction on the
shared connection (guide 110-113); erase's locking contract states this (today locks are
per-entity, `MaintenanceService.ts:250`) and the whole-file scope joins ruling B's
accepted INTENT.md:137-138 tension
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
**soft-deleted** into the existing prune flow; their erasure completes at `erase()` like
every other fact.

Mutually exclusive with `clearAll` (existing selector rules unchanged; the flag composes only
with `entryId`). **Future selector cross-ref (T4 m6):** `forget({ eventId })` is the named
deletion path for retained quotes (INTENT.md:428-430, filed as **#386**) — the `ForgetParams`
typing and dry-run selector rules changed here must not box that selector in.

### 4. Immediate-erasure enhancement — DEFERRED (owner ruling C, 2026-11-17)

**Ruling: the FTS5 `'secure-delete'` option does not ship in v1 in any form.** No per-open
gate, no format-5 upgrade, no self-arming: the gate code ships only when a fixed SQLite
release exists AND the host turns the option on explicitly. It never self-arms — a future
fixed runtime appearing on a store must not silently flip the one-way file-format door.
(The deferred design, kept below for the record, is the shape that ships at that later
opt-in.)

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
with a surfaced warning. The erase-time guarantee (§1-2) is unaffected either way. None of
this machinery exists in v1 (ruling C): the paragraphs above describe the design for the
deferred, explicit-opt-in release.

**The gate is lower-bounded on the pinned first-good release — never an exclusion of a
known-buggy interval (T3 M6; rev 20's "equality-based" mislabeled a `>=` bound, T4 delta-3
m2).** The gate is
`sqlite_version() >= <first release containing the fix check-in 0b486e53a4>` — that release
does not exist yet, so **the gate is closed today** (no runtime passes — and per ruling C the gate itself is not
shipped in v1); 3.53.4 is
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
door; it ships in v1. The FTS5 option does not (deferred, explicit host opt-in).

### 5. Source-store erasure: INTENT rule 5 governs — document-as-host-property, no engine GC (owner ruling E)

**INTENT.md rule 5 (`INTENT.md:193-200`, re-affirmed by the 2026-11-15 amendment at
`:387-395` after the source store shipped) enumerates exactly when stored text leaves:**
`forget()` on the source, a changed copy stored under the same `sourceRef`, an entity wipe,
or an import with `merge: false`. Erase's last-fact GC would be a **fifth leaving path not
in that list** — a contradiction of intent, which per AGENTS.md makes the spec wrong until
INTENT is amended. The original §5 checked INTENT :135/:137/:468 but never rule 5 (T4
BLOCKER-1); rule 5 governs this data.

`forget({ entryId })` today leaves stored source text (`source_documents.text`,
`schema.ts:74`) on disk when the selector is entry-based. But `source_documents` rows are
host-owned data: they are written **only** by `storeSource` (`SourceStoreService.ts:43-73`,
exposed at `WikiMemory.ts:1110-1118`) and import (`ImportExportService.ts:180`) — **never** by
`remember` or `ingestDocument` (T3 B1/M1) — so a fact-less stored document is a normal,
supported state (`getStoredSource`, passage search).

**Owner ruling E (2026-11-17): document-as-host-property, no engine GC — final, not a
default awaiting confirmation.** `erase()` does **not**
touch `source_documents`. The documented erasure path for stored text is
`forget({ sourceRef })`/`forget({ sourceHash })` — hard-deleting at forget time
(`MaintenanceService.ts:696-700`) — plus `clearAll`; both are already rule-5 paths, so **no
INTENT amendment is needed** (rule 5 already names every leaving path). A `forget({ entryId })`
erases everything **except** host-stored
source text; the guide (§6) states this scoping explicitly. Consequences: no GC machinery, no
`source_gc_pending` ledger, ever, and the B1 invariant (host-stored text survives erase)
holds trivially.

**The GC alternative is REJECTED, not deferred (owner ruling E).** Kurt's standing ruling,
first-class: *"we cannot violate the founding principle of the LLM Wiki pattern, immutable
source files."* Source documents are immutable host property; the engine never mutates or
auto-deletes them. Erase-time GC — even the exact-pair-matching, positive-predicate ledger
design negotiated through T3 (retained in git history at spec revs 6-26) — is an engine
deletion path for host property and is off the table. `forget({ sourceRef })` is the erasure
path; the engine never GCs. The T3-era blueprint design (durable `source_gc_pending` ledger,
`RETURNING id, source_ref, source_hash`, exact-pair predicate `(H_key IS NOT NULL AND
H_doc = H_key AND R_doc = R_key)`, liveness re-check in the delete transaction) is dropped
from this spec; on an erasure request the host calls `forget({ sourceRef })` for every
stored document of the subject (GDPR consult §8-E, ratified).

### 6. Docs:

`apps/docs/src/content/docs/guides/deleting-data.md` gains: the erasure recipe
(`forget` → `erase()` — **no standalone `runPrune` step** (T3 delta-10 m2): erase's step 1
already prunes with `retainSoftDeletedFor: 0` and `retainEventsFor: null`, and a standalone
prune with default options would delete events older than 30 days, contradicting the
events-kept framing), the "guaranteed at erase-time, not forget-time"
scoping **with the `pruneSupersededAfter` caveat** (facts soft-deleted by step 1 during this
erase hard-delete at the *next* erase, and only for entities erase enumerated — T4 m5),
the host-stored-document statement (**stored documents survive erase; the erasure path for
them is `forget({ sourceRef })`** — T4 delta MAJOR-2 / owner ruling E; on an erasure request
the host calls `forget({ sourceRef })` for every stored document of the subject), the
host-connection pragma
requirement, the copy census (events kept unless
`clearAll({ includeEvents: true })` — the documented host-step carve-out, owner ruling D;
drain the outbox; host-stored documents survive erase unless
`forget({ sourceRef })`; manifest stays; exports bring data
back), the **VACUUM temporary-database residue window** (investigation §3.5 census: VACUUM
builds its temp copy outside the main file — host guidance is `PRAGMA temp_store=MEMORY`
for the erase call; T4 delta-7 m2), and the no-opt-out pragma statement
(`secure_delete=FULL`, always on — owner ruling B). Ruling D's guide sentences: events
follow the host's `retainEventsFor` — each host publishes its own value; a **"handling an erasure request" recipe** names `forget({ eventId })` (#386) as the
prerequisite path for retained quotes — a host that claims GDPR erasure needs it, it is not
a convenience follow-up.

## Files touched

- `packages/core/src/services/search/Fts5IndexStrategy.ts` — the per-open gated option set
  is **not in v1** (deferred, owner ruling C — ships later behind an explicit host opt-in,
  never self-arming); erase-time
  retired-table reclaim-to-completion + full ledger drain with surfaced errors —
  **on a module-less runtime the step-4 fallback reclaim lives beside erase in
  `MaintenanceService` instead (T4 delta-7 MAJOR-2): `Fts5IndexStrategy` is never
  instantiated on that runtime.**
- `packages/core/src/db/migrations.ts` — **no new migration** (owner rulings C and E: no
  option migration, no GC ledger migration, ever).
- `INTENT.md` — status lines touched by this behavior (implementation PR per house rule);
  **plus rules 12-13 (the four-states/five-verbs taxonomy and "erasure is verifiable,
  portability is clean") and the Superseded/Forgotten/Gone/Erased glossary — folded in this
  rev (INTENT amendment accompanying rev 27). No rule-5 amendment is needed** (owner ruling
  E: rule 5 already names every leaving path; the GC alternative is rejected).
- `packages/core/src/db/schema.ts` / `packages/core/src/WikiMemory.ts` `setup()` —
  `PRAGMA secure_delete=ON` + read-back in `setup()` (T3 delta-2 m1: one file named).
- `packages/core/src/repositories/MetadataRepository.ts` — `vacuum()` gains **only** the
  post-VACUUM `wal_checkpoint(TRUNCATE)`; **both checkpoints read their result row**
  (`getFirstAsync`) and surface `busy !== 0` / `log !== checkpointed` (T4 delta-3 MAJOR-1);
  the watermark wrapper stays in
  `MaintenanceService._wrappedVacuum()` (T3 delta-2 M1 — §2 step 5 governs).
- `packages/core/src/services/MaintenanceService.ts` — `forget()` chain flag (incl. dry-run
  lift + `chainEntryIds`/`truncated`); `erase()` (8-step composition per §2, incl.
  `_wrappedVacuum()`); hold catching/reporting (external
  holds via the error channel; erase keeps all events, so no event-hold channel).
- `packages/core/src/WikiMemory.ts` — `erase()` public API + `forget` param typing;
  `exportDump` gains `includeForgotten` (default `false` — exports exclude forgotten rows
  unless the caller asks for a backup dump; ratified rev-27 addition, GDPR consult §8);
  `getRetentionPolicy()` reads the host's declared retention back on request (ratified
  rev-27 addition).
- `packages/core/src/repositories/EntryRepository.ts` — depth-aware chain walk (truncation
  detection) + dry-run chain listing helper. (The `RETURNING` widening and `deletedKeys`
  output option existed only for the rejected GC ledger — dropped, owner ruling E.)
- `packages/core/src/services/SearchService.ts` — passage drain surfaced (no swallow) in the
  erase path — a surfaced, `syncChain`-chained variant, never a bare
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
     validator accepts 0), `erase()` —
     **assert whole-file absence**: canary absent from the entry row, all FTS surfaces (db
     file, `-wal`, `-journal`, `-shm`, **and every `%_data` block**). Because no host-stored
     document exists, whole-file absence is assertable at this tier. Variant (T4 delta-3 m5):
     the same fixture run as **exactly** `forget({ entryId })` → `erase()` — no standalone
     `runPrune` — so the documented §2 recipe (erase's step 1 → `syncedIds` → step 6) is
     itself under the canary. `events.summary` and the
     entity summary are documented carve-outs (owner ruling D). Host-stored text has its
     **own tier below** (T4 delta MAJOR-3); the GC ledger-exercise variant is dropped with
     the GC path (owner ruling E).
   - *Full-wipe tier:* **seed every derived copy explicitly and assert each exists before the
     wipe** (T3 M1 — none of them arise from ingestion alone): an event whose `summary`
     carries the canary (via `write()`), an unsent outbox row, and an entity summary containing
     it. Then `clearAll({ includeEvents: true })` + outbox drain + `erase()`, **run
     hookless** (no vector-removal hook, or a removal-confirmed stub) — assert the canary is
     absent from the whole file. Whole-file absence claims are made only at this tier.
   Mirror scenario F and G (optimize and rebuild variants; K/K2 are the composed-sequence
   proof).
2. **H-mirror test:** after `setup()` sets the pragma, flip it **`PRAGMA secure_delete=OFF` on
   the same connection** (no engine hook needed — the pragma is per-connection), `'rebuild'`
   alone leaves the canary — **pins that `'rebuild'` alone is insufficient without the pragma**
   (owner ruling B: the pragma is unconditional at FULL; this test is its evidence).
3. **erase() holds:** with an unconfirmed external removal, `erase()` hard-deletes nothing
   held and reports the holds via `PrunePartialFailureError` semantics. **Events: erase
   deletes none** (`retainEventsFor: null`) — assert the event count is unchanged after
   erase (T3 delta-8 MAJOR-1; the `event_retention_held` diagnostic is out of scope for
   erase). Note step 1's internal `syncEntries` **ignores `false` returns** (`:451` discards
   the result) — step 6's surfaced `false` is the only failure observer, which is why step 6
   exists (T4 m5). Step-0 (ruling B): flip the pragma OFF after setup → erase fails with
   `erase_secure_delete_off`, erasure marked unverified — never a false success; the
   step-0 read-back reports the pragma state and `sqlite_version()` in the erase report
   (ratified rev-27 addition, GDPR consult §8-B). The `source_gc_pending` crash test is
   dropped with the GC path (owner ruling E).
4. **Chain forget:** fixture lineage with fan-in (A→C←B: forgetting A reaches C, not B —
   documented); dry-run lists exactly the walked ids, `truncated` + cap notice on truncation;
   real run soft-deletes the chain (chain ids covered by sync/drain/backstop); erasure
   completes after erase.
5. **Source documents (owner ruling E — document-as-host-property, no GC):**
   document backing two facts, one forgotten — document stays; both forgotten +
   erase — **the document still stays** (no GC, ever); `forget({ sourceRef })` + erase →
   document and passages gone (including `source_passages_fts`). **B1 regression
   test:** a `storeSource`-only document with zero facts **survives `erase()`** unchanged —
   and **every** stored document survives erase.
   **Task-only case (T4 MAJOR-2):** forget tasks only +
   erase → task rows gone from the file.
   **Source-document tier (T4 delta MAJOR-3):** `storeSource` the canary text (no facts),
   `forget({ entryId })` + erase →
   **the document survives** (host property); then `forget({ sourceRef: R })` + erase →
   **whole-file clean** (rule-5 path).
6. **Gate tests:** **not in v1** (owner ruling C — the gate ships with the deferred,
   explicit host opt-in). When it ships: mock runtimes (refuses option / below the gate /
   format-5 read error) — the per-open gate warns and skips; no-FTS path stays green; pragma
   read-back surfaces refusal. Gate acceptance is tested against a mocked version **at and
   above** the pinned first-good release only — never a range.
7. **M3/M4 regression tests:** erase while FTS rebuild state is `rebuilding` (watermark
   reset + rebuild restart correct); a forced corruption reset leaves a retired table, then
   forget + erase reclaims it to completion and the whole-file scan is clean.
8. Baseline gates: `pnpm -r typecheck`, unit suite (wall-clock-flake-prone timeouts under load
   are re-run in isolation per the known flake signature).

## Rejected alternatives

- **FTS5 `'secure-delete'` option as the required mechanism** (the issue's proposal): version
  gate passes zero verifiable runtimes (upstream merge bug unfixed in every release the
  investigation could confirm) + one-way
  format-5 door. Deferred as an optional enhancement behind explicit host opt-in (§4,
  owner ruling C) — not in v1.
- **VACUUM alone as the mechanism:** drops freed content pages but copies live `%_data` pages
  as-is, so term bytes under delete markers survive it — **measured NOT clean (B′, postings
  present)**. Part of the recipe, not the guarantee.
- **Erasing events/outbox unconditionally on `forget({entryId})`:** breaks the librarian's
  rebuild-from-events contract and the outbox delivery guarantee; documented as host steps
  instead (guide already covers both).
- **Per-connection pragma opt-out:** rejected (scenario H; owner ruling B — always on at
  FULL, no opt-out, no revisit clause).
- **A `retainSoftDeletedFor` override on `erase()`** (the prior survey's proposal, to
  protect hosts keeping `deleted_at` archives): rejected (owner ruling A — a strict
  store-wide erasure verb; an erase that can be told to keep forgotten rows produces a
  report that lies; hosts keep archives as superseded rows, which erase never touches).
- **Engine GC of host-stored source documents:** rejected, not deferred (owner ruling E —
  "we cannot violate the founding principle of the LLM Wiki pattern, immutable source
  files"; the T3-era ledger blueprint is preserved in git history, spec revs 6-26).

## Release

Semver: new public API (`erase()`, `forget` flag) → minor. The exported `WikiBusyOperation`
union gains `'erase'` — the one public type whose shape changes. **Owner ruling F
(2026-11-17): the union widening rides the MINOR, with the policy written into the type's
JSDoc at `types.ts`** (the union is diagnostic metadata on an error type; exhaustive
consumer switches should add a `default` arm) so the minor-vs-major call never needs a fresh
ruling. **The dry-run lift widens
two more public shapes additively and optionally (minor-safe; T4 delta-5 m4):**
`ForgetParams` gains `includeChain?`, `ForgetResult` gains `chainEntryIds`/`truncated`.
**The union-widening semver
call is now settled (owner ruling F; T4 delta-4 MAJOR-2 was the open question):** the
`types.ts:1203-1207` note records a prior widening as a **breaking change** (`import`/
`forget` rode **v3.0.0**; exhaustive consumer switches must add a `default` arm), while
`'ontologyBackfill'` was added afterward and rode **minor** releases (v4.21–4.23, `feat:`
commits — verified against tag history: `807220be`/`19d0255c` shipped in v4.21.0,
`199df2e2` in v4.23.0; T4 delta-7 m4). Do not assert safety from the note — it documents
the break; ruling F supersedes the caution with the JSDoc policy. **No new migration**
(owner ruling E — there is no `source_gc_pending` ledger table, ever; T4 delta-2 MAJOR-3
resolved). There is **no v18 option migration and no per-open gate in v1**: the FTS5
`'secure-delete'` option is deferred (owner ruling C) and ships later only behind an
explicit host opt-in — it never self-arms when a fixed SQLite appears; no format change
occurs unless a host opts in (and then the one-way door applies, documented).

`expire()` is ratified (owner, harmonization 2026-11-17) — a thin
`setTemporal` wrapper for archive-without-replacement. It needs its own
small spec before implementation and is NOT part of this lane's
implementation scope.

## Non-goals

- Erasing events or outbox rows on single-fact `forget()` (documented host steps).
- Erasing export files (outside the store; documented).
- Removing the entity manifest (fact-derived types, documented).
- Vector/external-index erasure (shipped: durable-vector-removal, PR #372; this lane is the
  store-file side only).
- Performance tuning of secure deletes (measure first, per the issue's acceptance).

## Owner rulings (spec stop A–H, ratified 2026-11-17)

The eight questions parked at rev 26 are now rulings; each is folded into the sections above.

- **A (scope).** Strict store-wide erase — and **no `retainSoftDeletedFor` override**. An
  erase that can be told to keep forgotten rows produces a report that lies (GDPR consult
  §8-A). Folded: §2 intro; a rejected alternative.
- **B (`secure_delete`).** Always on at **FULL**, no opt-out, read-back surfaced
  (setup-time §1 and erase-time step 0); a failed pre-check is an **honest failure**
  (`erase_secure_delete_off`, erasure marked unverified) — never a false success. The
  step-0 read-back and `sqlite_version()` go into the erase report (GDPR consult §8-B).
  Folded: §1, §2 step 0, test plan 2-3, a rejected alternative.
- **C (gated immediate erasure).** **Deferred.** The gate code ships only when a fixed
  SQLite release exists AND the host opts in explicitly; it never self-arms (a self-arming
  format-5 door would also break restores onto older builds — Art. 32(1)(c) availability,
  GDPR consult §8-C). Folded: §4, Files touched, test plan 6, Release.
- **D (events/summaries).** Documented **host-step carve-out**: the guide names the
  `clearAll({ includeEvents: true })` full-wipe path and `forget({ eventId })` (#386) as the
  prerequisite for any host claiming GDPR erasure; events follow the host's
  `retainEventsFor` — each host publishes its own value (GDPR
  consult §8-D reframes the carve-out around the erasure-request recipe). Folded: §6.
- **E (source ownership).** **Document-as-host-property, no engine GC** — final. Standing
  owner principle, first-class: *"we cannot violate the founding principle of the LLM Wiki
  pattern, immutable source files."* The engine never mutates or auto-deletes source
  documents; the T3-era GC blueprint is rejected (not deferred) and preserved only in git
  history. On an erasure request the host calls `forget({ sourceRef })` for every stored
  document of the subject. Folded: §2 step 2, §5, Files touched, test plan 5, Release,
  a rejected alternative.
- **F (semver).** The `WikiBusyOperation` union widening (`'erase'`) **rides the MINOR**;
  the policy is written into the type's JSDoc at `types.ts` so it does not recur as a
  question. Folded: Release.
- **G (`source_ref_index` tombstones).** **Keep step 1b, store-wide** —
  `DELETE FROM source_ref_index WHERE deleted_at IS NOT NULL`, behind the
  `sourceRefIndexPresent(tx)` probe, no exceptions and no documented carve-out. Folded:
  §2 step 1b, the §3 census line.
- **H (naming).** `compact()` is renamed **`erase()`** throughout this spec, the
  deleting-data guide, and every code identifier this spec names (`OperationType` /
  `WikiBusyOperation` member `'erase'`, `JobManager` case + `_eraseKey()` →
  `` `${prefix}:erase` ``, diagnostics `erase_secure_delete_off` /
  `erase_checkpoint_incomplete` / `erase_retired_vtab_undroppable`,
  `erase({ rebuild: true })`). Historical review tags (T3/T4 findings) keep their original
  wording where they quote pre-rev-27 text.

**Ratified rev-27 additions carried from the GDPR consult (§8, "additions, not new
questions"):** the **erase report shape** (§2 steps 0 and 8 — the report names the
runtime and `sqlite_version()`, the pragma state, every step's outcome, skipped entities and
holds, and whether erasure is verified; it never claims success it cannot show — INTENT rule
13); **`exportDump` `includeForgotten`** flag, default `false` — exports exclude forgotten
rows unless the caller asks for a backup dump; **`getRetentionPolicy()`** — retention is the
host's declaration and the engine reads it back on request; and the **tombstone-wins import
guard** — an import whose dump carries a `deleted_at` tombstone for a live ref keeps the
tombstone (forget wins over re-ingest). The engine makes GDPR compliance possible for its
hosts; it does not perform it for them.

