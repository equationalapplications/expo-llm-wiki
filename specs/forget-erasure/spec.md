# Forget must erase — FTS5 erasure, chain forget, compact()

**Status: Draft rev 14 — under review (T3 delta-9 pending; delta-8's findings folded)**  
**Issue:** equationalapplications/expo-llm-wiki#401 · **Investigation:** [`investigation.md`](./investigation.md) (rev 11, converged)

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

Plus the derived/upstream copies of fact text (investigation §3.5 census): events
(`schema.ts:124-128`), unacked outbox rows (`:156-162`), `source_documents.text`
(`:74` — `forget({entryId})` never touches it), entity summaries (`meta`), the entity manifest
(fact-derived, not text), and export files outside the store.

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

Store-wide `wiki.compact()` (owner question A on scope; a **new public API** — nothing named
`compact` exists in this tree). Composition, in order (T3 M7 — each step surfaces errors; a
failed step fails the compact and reports where it stopped):

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
   Holds are **caught per entity** (`PrunePartialFailureError`, `MaintenanceService.ts:452-456`): compact
   continues to the file steps for the other entities and returns the holds per entity rather
   than throwing (T3 m2). **Scope (T3 delta-2 M2, corrected T3 delta-9 MAJOR-1):** that error
   covers **external-removal holds only** (`MaintenanceService.ts:397-401`). Event-retention
   holds **cannot arise in compact** — with `retainEventsFor: null` the retention block never
   runs (see above) — they apply only to standalone `runPrune`.
   Step 1 runs prune with **`vacuum: false`** — the per-entity VACUUM must not
   run N times; the wrapped store-wide VACUUM happens once at step 5 (T3 delta-2 m2). Known
   edge (T3 delta-7 m2, documented): with `pruneSupersededAfter` set, step 1 soft-deletes
   expired history stamped at/after this run's cutoff, so those rows hard-delete at the
   **next** compact — accepted.
2. **Source-store GC** (§5) — drains the durable `source_gc_pending` ledger (§5), never
   collect-by-absence.
3. **Full FTS ledger drain** — entries and passages (`drainPassages`), **no deadline, errors
   surfaced** (today `syncPassages` swallows failures, `SearchService.ts:353-355`, and
   `drainPassages` no-ops when passages are disabled, `Fts5IndexStrategy.ts:134` — if the
   passage index is disabled but its tables exist, compact **fails and reports** rather than
   claiming erasure, T3 M7).
4. **Retired-table reclaim to completion** — `DROP` + delist for every
   `entries_fts_retired_N` and its shadow tables, **no deadline**, failures surfaced (today
   reclamation is deadline-bounded best-effort, `Fts5IndexStrategy.ts:410-452`; a retired
   table's `%_content` holds verbatim fact text and VACUUM would copy it intact — T3 M4).
   Required **whenever retired tables exist, even if `entries_fts` itself is missing** (a
   forced reset on a runtime where FTS later became unavailable still leaves verbatim text in
   the retired shadows — T3 delta m1).
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
   delta-6 m2).   **Id source (T3 delta-7 m1):** `runPrune` returns counts only (`:457`), so it
   gains an output channel (the same output-array pattern as `deletedKeys`) returning the ids
   it synced; compact passes those to step 6. **The output array is filled before
   `PrunePartialFailureError` throws** (at the `syncedIds` assembly, `:393`/`:451-455`), so a
   held-back entity still contributes its deleted ids to step 6 — test: a hold and a
   successful delete in the same compact, and step 6 receives exactly the deleted ids (T3
   delta-8 m1).
7. FTS `'optimize'` on both FTS tables when they exist — **after** `syncEntries`, so the
   delete markers `syncEntries` introduces are merged away under the pragma (a `rebuild`
   escape hatch is exposed as `compact({ rebuild: true })` for stores recovering from
   corruption).
8. `wal_checkpoint(TRUNCATE)` — **last** (`MetadataRepository.vacuum()` today checkpoints
   only before; the post-VACUUM, post-sync checkpoint is what clears everything — including
   any frames `syncEntries` wrote — through the WAL, so no delete-marker term bytes reappear
   in `%_data` or `-wal` after compact returns; T3 delta-3 m1).

A store with no FTS tables (no-FTS runtime, expo hosts without `enableFTS`) skips the FTS
steps (3, 4, 7) for surfaces that don't exist — but step 4 still runs for any retired tables
left behind — and remains correct: there is nothing to drain or optimize,
and the other steps still erase. VACUUM and checkpoint are whole-file operations — they
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
(`MaintenanceService.ts:730-743`). Chain members are
**soft-deleted** into the existing prune flow; their erasure completes at `compact()` like
every other fact.

Mutually exclusive with `clearAll` (existing selector rules unchanged; the flag composes only
with `entryId`).

### 4. Optional immediate-erasure enhancement, gated (the issue's FTS5 option)

**No numbered migration (T3 M5).** `setup()` runs each migration once and stamps
`schema_version` unconditionally (`WikiMemory.ts:450-455`), so a v18 one-shot would stamp
every existing store as "done" while the gate passes no runtime today — upgraded stores would
**never** get the option even after a fixed SQLite ships. Instead the gate is evaluated **on
every open** inside `Fts5IndexStrategy.init` / `ensurePassageObjects` / `rearmInTx` via an
idempotent `ft_config` write: option set when the runtime passes the gate, otherwise skipped
with a surfaced warning. The compact-time guarantee (§1-2) is unaffected either way.

**The gate is equality-based on a known-good release, not a range (T3 M6).** The gate is
`sqlite_version() >= <first release containing the fix check-in 0b486e53a4>` — that release
does not exist yet, so **the gate is closed today** (no runtime passes). Wording like
"outside the known-buggy range 3.46.0→3.53.2" is forbidden: it would admit 3.42.0-3.45.x
(untested, same merge code) and 3.53.3/3.53.4 (unfixed).

Format-5 read errors on older builds (the one-way door): the real fallback path is
`initEntries` rethrow → `UnavailableIndexStrategy` (`Fts5IndexStrategy.ts:213`) — migration
v1 (`migrations.ts:12-19`) is a no-op kept for upgrade paths, **not** a read-error fallback
(T3 m4). Rolling the engine back to an older version after the option was set is **not
mitigable** and is documented as such.

The pragma (§1) is unconditional on every runtime — it has no version constraint and no format
door.

### 5. Source-store erasure: positive-predicate document GC (T3 B1 redesign)

`forget({ entryId })` today leaves stored source text (`source_documents.text`,
`schema.ts:74`) on disk when the selector is entry-based. But `source_documents` rows are
host-owned data: they are written **only** by `storeSource` (`SourceStoreService.ts:43-73`,
exposed at `WikiMemory.ts:1110-1118`) and import (`ImportExportService.ts:180`) — **never** by
`remember` or `ingestDocument` (T3 B1/M1) — so a fact-less stored document is a normal,
supported state (`getStoredSource`, passage search).

Decision: `compact()`'s GC pass drains a **durable pending-GC ledger** (T3 delta B1 — a
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
  asserting the staged outbox rows (`EntryRepository.ts:868-874`) roll back too; T3 delta-4
  m4). **Key source inside the transaction (T3 delta-3 M2, corrected T3 delta-7 MAJOR-2,
  nullability T3 delta-8 MAJOR-2):**
  `bulkDeletePruned` already runs
  `DELETE … RETURNING id` (`EntryRepository.ts:862-865`) and already collects deleted ids
  through its `{ deletedIds: string[] }` output option (`:365`). **`deletedIds` stays
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
  `'legacy'`/no-ledger-gate branches (`MaintenanceService.ts:338-348`).
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
  dropped from the ledger un-deleted. **Key matching predicate (T3 delta-4 MAJOR-1):**
  `source_documents` has **two** unique indexes — `(entity_id, source_ref)` and
  `(entity_id, source_hash)` (`schema.ts` `idx_source_documents_ref`/`idx_source_documents_hash`,
  created in `createSourceDocumentIndexesIfColumnsExist`) — and `entries.source_hash` is
  **nullable** (`schema.ts:13`), with `source_ref_index` tracking the canonical ref per hash
  (a document can be re-keyed to a new ref). Therefore: a document is a GC **candidate** if it
  matches the deleted fact's key on `(entity_id, source_ref)` **or** `(entity_id,
  source_hash)`; it is **live** if any live entry matches it on **either** column, with NULL
  hashes ignored (a NULL-hash fact key matches on ref alone). **NULL symmetry (T3 delta-8
  MAJOR-2):** a NULL column never matches on either side (`source_ref = ?` bound to NULL
  matches nothing — that is the rule, not luck; an `IS`-based match that treats every
  NULL-ref fact as live would permanently block GC); a key with **both** columns NULL is
  **not written to the ledger** (nothing to match). Required test cases: a NULL-hash
  fact key still GC-matches; a NULL-ref fact key with a hash GC-matches on hash alone; a
  re-keyed document (`R_old`→`R_new`, same hash) is matched by
  the old fact's hash; a live fact sharing the ref but carrying a **different** hash keeps the
  document live. A `storeSource`-only document with zero facts therefore
  **always survives compact()** (its keys never enter the ledger). One document backing N
  facts is untouched while any live fact references it.
- Hosts that need per-document certainty use `sourceRef`/`sourceHash` selectors (hard-deleting
  the stored document at forget time — the facts themselves still soft-delete,
  `MaintenanceService.ts:696-700`/`:709`; T3 delta-3 m4).

**Owner question E (T3 B1):** should forgetting the last fact referencing a stored document
delete the host's stored text at all (the GC above), or is `forget({ sourceRef })` the
documented erasure path with compact() leaving host-stored text alone? The GC is the
erasure-complete default; the alternative is document-as-host-property.

### 6. Docs: the deleting-data guide gets the erasure section

`apps/docs/src/content/docs/guides/deleting-data.md` gains: the erasure recipe (forget → prune
`retainSoftDeletedFor: 0` → `compact()`), the "guaranteed at compact-time, not forget-time"
scoping, the host-connection pragma requirement, the copy census (events kept unless
`includeEvents`; drain the outbox; source documents GC; manifest stays; exports bring data
back), and the no-opt-out pragma statement.

## Files touched

- `packages/core/src/services/search/Fts5IndexStrategy.ts` — per-open gated option set
  (`init` / `ensurePassageObjects` / `rearmInTx`, idempotent `ft_config` write); compact-time
  retired-table reclaim-to-completion + full ledger drain with surfaced errors.
- `packages/core/src/db/migrations.ts` — new migration: `source_gc_pending` ledger table
  (unconditional schema). No option migration (per-open gate, §4).
- `packages/core/src/db/schema.ts` / `packages/core/src/WikiMemory.ts` `setup()` —
  `PRAGMA secure_delete=ON` + read-back in `setup()` (T3 delta-2 m1: one file named).
- `packages/core/src/repositories/MetadataRepository.ts` — `vacuum()` gains **only** the
  post-VACUUM `wal_checkpoint(TRUNCATE)`; the watermark wrapper stays in
  `MaintenanceService._wrappedVacuum()` (T3 delta-2 M1 — §2 step 5 governs).
- `packages/core/src/services/MaintenanceService.ts` — `forget()` chain flag (incl. dry-run
  lift + `chainEntryIds`/`truncated`); `compact()` (8-step composition per §2, incl.
  source-store GC ledger drain and `_wrappedVacuum()`); hold catching/reporting (external
  holds via the error channel; compact keeps all events, so no event-hold channel).
- `packages/core/src/WikiMemory.ts` — `compact()` public API + `forget` param typing.
- `packages/core/src/repositories/EntryRepository.ts` — depth-aware chain walk (truncation
  detection) + dry-run chain listing helper; `bulkDeletePruned` widens `RETURNING` to
  `id, source_ref, source_hash` and gains a `deletedKeys` output option (for the GC ledger;
  `deletedIds` stays `string[]` — T3 delta-7 MAJOR-2).
- `packages/core/src/services/SearchService.ts` — passage drain surfaced (no swallow) in the
  compact path.
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
   - *Fact-path tier:* fixture pinned (T3 B1/M1 — `source_documents` is written only by
     `storeSource` and import; `remember`/`ingestDocument` create no source rows and no
     events): **`storeSource({ sourceRef: R, sourceHash, text containing the canary })`** into
     a tempdir store with 300+ filler facts (multi-segment index), then create **exactly one**
     canary fact carrying the same `sourceRef` (via `remember`/`ingestDocument` with a stub
     provider), and **assert the `source_documents` row exists before the forget** (the check
     must not be vacuous). Then `forget({ entryId })`,
     `runPrune(entityId, { retainSoftDeletedFor: 0, retainEventsFor: null })` (T3 delta-8 m2 —
     explicit options; the bare default would delete 30-day-old events),
     `compact()` — assert the canary is absent from the entry row, all FTS surfaces (db file,
     `-wal`, `-journal`, `-shm`, **and every `%_data` block**), and that the compact-time
     source GC removed the `source_documents`/`source_passages` rows (including
     `source_passages_fts`). **Second case:** a document backing **two** facts —
     after forgetting one, its `source_documents` row and passages must **survive** (GC must
     not fire while a live fact references it). The explicit
     `runPrune(entityId, { retainSoftDeletedFor: 0, retainEventsFor: null })` before
     `compact()` is **intentional** (T3
     delta-2 m4): it exercises the ledger path across separate prune and compact calls — the
     exact shape of the documented host recipe, where the ledger must carry the keys.
     `events.summary` and the
     entity summary are documented carve-outs at this tier (owner question D).
   - *Full-wipe tier:* **seed every derived copy explicitly and assert each exists before the
     wipe** (T3 M1 — none of them arise from ingestion alone): an event whose `summary`
     carries the canary (via `write()`), an unsent outbox row, and an entity summary containing
     it. Then `clearAll({ includeEvents: true })` + outbox drain + `compact()`, **run
     hookless** (no vector-removal hook, or a removal-confirmed stub) — assert the canary is
     absent from the whole file. Whole-file absence claims are made only at this tier.
   Mirror scenario F and G (optimize and rebuild variants; K/K2 are the composed-sequence
   proof).
2. **H-mirror test:** with the pragma unset via a test hook, `'rebuild'` alone leaves the
   canary — **pins that `'rebuild'` alone is insufficient without the pragma** (the
   "pragma is unconditional" wording holds only after owner question B is answered).
3. **compact() holds:** with an unconfirmed external removal, `compact()` hard-deletes nothing
   held and reports the holds via `PrunePartialFailureError` semantics. **Events: compact
   deletes none** (`retainEventsFor: null`) — assert the event count is unchanged after
   compact (T3 delta-8 MAJOR-1; the `event_retention_held` diagnostic is out of scope for
   compact). Plus the
   **ledger crash-injection test** (T3 delta-2 M3): a crash between the entry hard-delete and
   the `source_gc_pending` insert is impossible (same transaction) — inject a failure and
   assert neither the delete nor the ledger row landed.
4. **Chain forget:** fixture lineage with fan-in (A→C←B: forgetting A reaches C, not B —
   documented); dry-run lists exactly the walked ids, `truncated` + cap notice on truncation;
   real run soft-deletes the chain (chain ids covered by sync/drain/backstop); erasure
   completes after compact.
5. **Source GC:** document backing two facts, one forgotten — document stays; both forgotten +
   compact — document and passages gone (including `source_passages_fts`). **B1 regression
   test:** a `storeSource`-only document with zero facts **survives `compact()`** unchanged.
   **Key-matching cases (T3 delta-4 MAJOR-1):** a NULL-hash fact key GC-matches on ref alone;
   a re-keyed document (`R_old`→`R_new`, same hash) is matched by the old fact's hash; a live
   fact sharing the ref but with a **different** hash keeps the document live.
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

Semver: new public API (`compact()`, `forget` flag) → minor. New migration creates the
`source_gc_pending` ledger table (unconditional schema — consumers run their migration sweep
on upgrade). There is **no v18 option migration**: the FTS5 `'secure-delete'` option is
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
  deletion on forget; (c) engine-side entity-summary rewrite.
- **E.** Source-document ownership on last-fact forget (T3 B1): does compact()'s GC delete
  host-stored text (`storeSource`) when the last fact referencing it is gone (erasure-complete
  default, §5), or is `forget({ sourceRef })` the documented erasure path with compact()
  leaving host-stored text alone (document-as-host-property)?
