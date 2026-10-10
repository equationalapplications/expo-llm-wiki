# Spec: `wiki.setup()` wall time — minimal viable open, converging index

**Date:** 2026-10-10
**Status:** Draft (rev 9 — Opus delta cycle #4 adjudicated: spec 0 BLOCKER/5 MAJOR/9 minor + plan 0 BLOCKER/5 MAJOR/10 minor, all verified against source and applied; reviews: GLM r1-r4, Opus full ×2, Opus delta ×3 cycles; logs under `~/.hermes/cache/scratch/issue280/`)
**Branch:** `spec/issue280-setup-walltime` · **PR:** [#281](https://github.com/equationalapplications/expo-llm-wiki/pull/281) (DRAFT until implemented)
**Priority:** High — blocks the SynapseTree ARM64 gate (15 s writer-lease fence vs 693 s measured setup)

Fixes #280.

---

## Problem

`wiki.setup()` wall time scales super-linearly with store size because every open
repeats work that is only needed once per data-changing event:

| Store | setup() wall | Source |
|---|---|---|
| 50 MB | 5.1 s | reported in #280 (issue number only; not reproduced by our legs — smallest leg was 55.7 MB) |
| 4.7 GB | **693 s** | SynapseTree ARM64 gate: the writer-lease fence is 15 s, so setup holds/blocks the fence ~46× over |
| 1M entries, first open | 108.3–117.6 s (V1 rebuild) | investigation §2.1 (NVMe legs) |
| 1M entries, marker-lost | 165.4–209.4 s (V3) | investigation §2.1 |
| 1M entries, warm | 1.74 s (of which survival scans 1.73 s) | investigation §2.2/§2.3 |

Root causes use the **investigation §3 canonical numbering**:

- **RC-1 — rebuild paths are one giant transaction.** First open and marker-lost
  open rebuild the FTS index inside a single transaction (V1: the rebuild INSERT
  is 52.6 s of a 117.6 s open; V3: 99.2% of the open is one tx). The process is
  uninterruptible for that window; the writer lease cannot be honored.
- **RC-2 — every-open survival scans.** The legacy `source_type` check
  (`assertNoLegacySourceTypes`, `ImportExportService.ts:638`, probing via
  `hasLegacySourceTypes`, `EntryRepository.ts:1211-1218` — the probe also runs
  in `importDump`, `ImportExportService.ts:67`)
  and the `source_ref` normalization scan (`findRowsForSourceRefMigration` — GLOB,
  `EntryRepository.ts:1252`) run on **every** open: 0.60 s + 1.13 s @1M rows,
  exponent ≈1.3 on warm open; interpolating the measured 1M/2M points gives
  **16–30 s at 4.2M** (the spread reflects the 2M point sitting below the pure
  1.3 curve). Fence-critical either way.
- **RC-3 — brittle binary marker semantics.** FTS index health is a single meta
  row (`fts5_index_state`) plus three triggers; any marker loss or trigger loss
  demotes a healthy multi-GB index to a full RC-1 rebuild on the next open.
- **RC-4 — crash backlog drains inside the next open.** After a crash, the
  `fts_pending` ledger survives WAL replay and the next `setup()` drains it in
  one go: ≈123 s per 1M undrained rows [C — derived from the measured 8.1k
  rows/s drain throughput; the direct WAL-leg backlog measurement was lost to
  harness errors]. (Pure WAL replay is
  exonerated — measured at noise level.)
- **RC-5 — drain throughput/convergence.** Any budgeted-drain fix must actually
  converge: measured chunk throughput 7.6–8.1k rows/s, max chunk 733–1010 ms @1M.
- **RC-6 — FTS init failure silently demotes the store (measured: data-destroying crash path).**
  In `createIndexStrategy` (`packages/core/src/services/search/createIndexStrategy.ts:60-67`,
  demoting call at :72), an `init()` throw on `indexStrategy: 'auto'` logs a
  warning, **drops the ledger and FTS artifacts** (`detachFts5`), and falls back
  to MiniSearch. Measured (`minisearch-fallback-cost` leg, healthy 2.6 GB / 1M
  store, forced transient failure): `detachFts5` commits the demotion
  (`state='detached'`, ledger/map/FTS table/triggers all dropped) and the
  MiniSearch full sync then **OOM-kills the process at ~202 s, 1.83 GB heap,
  exit 134** on a default Node heap. A transient failure permanently destroys
  the incremental index — recovery is RC-1's single-tx rebuild — and kills the
  host process at pro scale.
- **RC-7 — the normalize loop is itself an unbounded tx.**
  `WikiMemory.ts:302-309` normalizes every row in ONE transaction — the same
  fence-critical shape as RC-1 even after RC-2's scans are made skippable.

**Gate-scale attribution [C — inferred, not measured]:** the 693 s gate leg is
consistent with a marker-lost rebuild path (RC-1 + RC-3 shape, ×~3.8 over 1M)
plus RC-2 scans; the investigation holds this only as a strong hint ("gate store
state not retrievable"), and a foreign-store first-open (V1 shape incl. the
16.5 s @1M `setupDatabase` DDL — repeated CREATE INDEX statements, per the
investigation §2.1, not the migration ladder) fits equally well. No additive breakdown is
claimed, and no crash-backlog term is asserted for the gate number — the gate
store's ledger state was not retrievable. Both candidate paths are addressed by
the changes below; the migration-ladder cost on foreign stores is bounded by
Acceptance 6's re-measure rather than by a dedicated change.

## Approach

Framing (converged with both Step-0 reviewers): **the fence cannot tolerate
block-until-ready at 4.7 GB regardless of chunk size.** The design goal is
therefore a **minimal viable open** — make every open O(state-change) instead
of O(database) — plus a **converging index**: bounded work per open that
shrinks incompleteness without ever holding the fence.

| # | Change | Fixes (canonical RC#) |
|---|---|---|
| 1 | `v14` stamped source_ref normalize (one-shot migration + stamp lifecycle) | RC-2 (source_ref half), RC-7 |
| 2 | Partial covering index for the legacy `source_type` check | RC-2 (source_type half) |
| 3 | FTS state machine: watermark chunked rebuild, budgeted drain, defined marker-loss semantics | RC-1, RC-3, RC-4, RC-5 |
| 4 | RC-6 guard: failure-ordered init, retry, never demote, typed error (6 pinned call sites — rev 7) | RC-6 |

(Former "Change 5" — batched normalize — is folded into Change 1; there is no
separate fifth change.)

### Change 1 — v14 stamped source_ref normalize

- New schema version 14. The normalize runs ONCE, to completion, inside the
  migration open (Acceptance 6's ≤240 s case): **rowid-watermarked chunk
  transactions** (≤500 entries-rows per tx) so each tx stays fence-tolerable,
  but **not deferred by the time budget** — a store serving `hasChanged` /
  `forget({sourceRef})` with partially normalized refs would answer lookups
  wrongly (Opus M-5). Resumes from its watermark after a crash mid-migration.
- Mechanics: the violation query is the existing GLOB predicate
  (`findRowsForSourceRefMigration`, `EntryRepository.ts:1242-1255`) plus
  `rowid > ? AND rowid <= ?` windows — chunkable, tracked in meta keys
  `normalize_v14_entries_wm` / `normalize_v14_sri_wm` (rev 9 M2: one per
  pass — see the two-table bullet below). Rows whose ref normalizes to NULL are
  written NULL (today's `updateSourceRefByRowid` behavior, kept deliberately).
- **Stamp lifecycle (atomic):** when a pass's window scan finds that pass's
  watermark ≥ its table's max(rowid) (checked inside the final chunk's tx),
  that tx deletes that pass's watermark; the stamp is written — inside the
  final chunk's tx of the SECOND (`source_ref_index`) pass, together with
  that pass's watermark deletion — ONLY after BOTH passes complete (rev 9
  M2): one invariant, never a stale residue. A missing watermark ⇒ treated
  as 0 (resume = redo whichever pass lacks its own watermark). Stamp meta key:
  `(source_ref_normalize_stamp = {schema_version: 14, normalize_alg: N})`.
- **Skip condition is defined purely on stamp state**, never on
  `schema_version < 14`: if the stamp is present and matches the current
  algorithm id, the scan is skipped. Missing or mismatched stamp ⇒ the full
  chunked re-normalize (to completion), then stamp. This makes
  `version=14, stamp missing` (crash between completion and stamp, or a
  fresh-store path bug) self-healing rather than a permanent rescan.
- **Fresh stores** (no `entries` table at first open) take the existing
  fast path that sets `schema_version = CURRENT` directly
  (`WikiMemory.ts:263-267`); that path MUST also write the v14 stamp and create
  the Change-2 partial index, so a fresh store never enters the migration.
- **Atomicity:** the stamp is written inside the final chunk's transaction
  of the second (`source_ref_index`) pass (with that pass's watermark
  deletion — see lifecycle above). A partially-applied
  migration (some rows normalized, no stamp) is harmless to an older engine:
  the old every-open scan still runs and simply finds nothing (or finishes the
  job).
- **Downgrade/backup-restore:** an older engine ignores the stamp (it does not
  know the key); a newer engine re-validates via the algorithm id — a bump of
  `normalize_alg` forces exactly one re-scan. (Opus delta m2, noted: an OLDER
  engine opening a `rebuilding` store takes today's single-tx rebuild path —
  the 693 s shape; acceptable, documented.) The violation predicate is also
  narrowed to match the stamp's claim exactly: `OR length(source_ref) > 255`
  is added (refs longer than 255 are truncated by `normalizeSourceRef` — the
  old predicate missed them; Opus delta m3). **Rev 7 replaced the SQL-predicate
  approach entirely (m7). Rev 8 closes its residual hole (Opus delta-3 M5):
  trim-then-truncate (`.trim().slice(0, 255)`, `pure.ts:909`) is NOT
  idempotent — a raw ref of 254 chars + a space + more normalizes to a value
  ending in a space, which re-normalizes to a different string — so the rev-7
  per-row check would flag values the write path legitimately stored, breaking
  the stamp invariant the moment it is written and misdirecting
  `forget({sourceRef})` after any re-normalize. `normalizeSourceRef` becomes
  `value.replace(/[^A-Za-z0-9._\- ]/g, '').trim().slice(0, 255).trimEnd()`
  (rev 9: the shorthand names the full pipeline incl. the existing
  character-strip step at `pure.ts:909`) — a true fixed point, pinned by the
  property test `n(n(x)) === n(x)` (7(q)) — and `SOURCE_REF_NORMALIZE_ALG = 1`
  denotes the idempotent semantics. (The old every-open `TRIM(source_ref) !=
  source_ref` scan has this same bug today; the root cause is the
  non-idempotency, not "predicate drift".) The migration window query fetches
  `(rowid, source_ref)` and applies `normalizeSourceRef(v) !== v` in
  TypeScript per row; with an idempotent algorithm, "violating" simply means
  "differs under the current algorithm", and the check is a fixed-point test
  by construction.**
- **Two tables, two passes (rev 9, Opus delta-4 M2):** `source_ref_index.source_ref`
  is a SECOND stored copy of the ref (`schema.ts:53`,
  `SourceRefIndexRepository.ts:40,60,80`), so the v14 normalize must rewrite
  it too: `updateSourceRefByRowid` touches only `entries`
  (`EntryRepository.ts:1257-1262`), `upsertGraph` compares
  `canonical === sourceRef` (`WikiMemory.ts:816-827`), and
  `softDeleteByEntityAndSourceRef` matches on the exact `source_ref` — a ref
  whose 255-char cut ends in a space would leave `entries` normalized while
  `source_ref_index` kept the stale form, and re-ingesting the same document
  would then fail with `WikiSourceRefHashCollision` or, via the missed
  soft-delete, a partial-UNIQUE `(entity_id, source_hash)` collision. The
  migration therefore runs a SECOND watermarked rowid pass over
  `source_ref_index` — same normalize algorithm, own rowid space, run AFTER
  the entries pass — with the two watermarks named above; the
  `SOURCE_REF_NORMALIZE_ALG` stamp lands only after BOTH passes complete.
  Pinned by 7(s).
- The every-open unbounded normalize tx at `WikiMemory.ts:302-309` is deleted
  by the stamp skip; the migration path replaces it (RC-7).

### Change 2 — partial covering index for the legacy check

- The legacy `source_type` check keeps its **fail-closed throw** when a legacy
  row exists (converged decision — semantics unchanged).
- A **partial covering index**
  `CREATE INDEX ... ON entries(source_type) WHERE source_type IN (<legacy values>)`
  makes the every-open probe near-free (planner verified, `profile-partial-index.ts`;
  0.4 ms probe measured).
- **Why partial index for source_type but not source_ref:** the source_ref
  violation-predicate index costs **13× on writes** — disqualified for the hot
  column; the legacy-source_type predicate is near-free because legacy values
  never occur on the write path post-migration.
- `CREATE INDEX` is a single-statement transaction and **cannot be chunked**
  (GLM MIN-8); its one-time build (a full entries scan even with an empty
  predicate result) is budgeted as part of the v14 migration's declared cost
  in Acceptance 6, not per-open.
- `CREATE INDEX IF NOT EXISTS` on every open is the no-op guard (and covers
  the fresh-store fast path per Change 1).

### Change 3 — FTS state machine: watermark rebuild, budgeted drain, marker-loss semantics

**State set** (meta key `fts5_index_state`): `live`, `rebuilding`, `detached`.
`detached` remains a real state — reachable via pinned
`indexStrategy: 'minisearch'` (`createIndexStrategy.ts:72`) and present in
existing stores in the wild. **`detached`-under-preference semantics (NEW-1, decided):** pinned
`indexStrategy: 'minisearch'` holds a store detached — explicit operator
choice. **`auto` re-attaches**: an `auto` open on a `detached` store enters
`rebuilding` via the full rebuild path (table row below). Rationale: detached
stores in the wild are overwhelmingly artifacts of the RC-6 fallback bug this
spec fixes, and keeping them on MiniSearch under `auto` is the measured
deterministic OOM path (Change 4's stakes). **Detached-under-`auto` wording
fixed (rev 8, Opus delta-3 m5):** the re-attach transition happens inside
`setup()` itself, so a completed open serves partial `rebuilding` recall
(below) — `WikiSearchUnavailableError` per query occurs only when init could
not complete (Change 4's failure path), not on the successful re-attach path.
On the **failure** path — the one
Change 4 governs — MiniSearch is **never** instantiated by `auto`. (The
unrelated module-absent path — `probeFts5` false — still falls back to
MiniSearch by design; see Change 4.) Switching back from a pinned-detached
store is the operator re-opening with `'fts5'` or `'auto'`.

**Transition table** (all transitions execute in ONE transaction — decide +
mutate + watermark + state together; the `fb-crash-resume` leg's discipline):

| From | Event | To | Actions in the transition tx |
|---|---|---|---|
| (absent) | fresh store (`entriesExistedBeforeSetup === false`, passed DOWN into `init()` — rev 8 plumbs it through `createIndexStrategy` into `init()`; today `WikiMemory.ts:260-261` computes it but does NOT pass it down — that plumbing is part of this change; Opus plan M4), FTS chosen | `live` | create tables + triggers, stamp `live` |
| `live` | **any trigger missing** (RC-3) | `rebuilding` | **re-create all triggers** (`fts5TriggersDdl`), clear **`fts_pending` only** — `fts_map` and `entries_fts` kept intact (subject to the re-arm consistency check, DDL note) — watermark=0, orphan-sweep cursor reset |
| marker row **lost** OR `fts_map`/`entries_fts` missing while the other has rows (Opus plan M4b — same "state absent, entries pre-existed" shape) OR **both missing/empty while a live row exists AND `fts_pending` is empty** (rev 8, Opus delta-3 m3: the rev-7 fast path recreated empty tables and keyword search stayed empty forever — a live row (`deleted_at IS NULL LIMIT 1`, probed only after `fts_map` is found empty) with an empty `fts_map` means rebuild; rev 9 m4 appends the ledger clause — a fresh store that bulk-writes and crashes before its first drain has live rows, an empty `fts_map`, and a FULL ledger, which its first drain populates: no rebuild) | any | `rebuilding` | same re-arm (keep-map only when BOTH `fts_map` AND `entries_fts` exist AND pass the consistency check; else DROP+CREATE per the DDL note) |
| `live`/`rebuilding` | triggers all present | (unchanged) | no-op fast path — **except `live` with a live row (`deleted_at IS NULL LIMIT 1`) but empty/missing `fts_map` AND an empty `fts_pending` ⇒ DROP+CREATE re-arm (rev 8, Opus delta-3 m3; rev 9 m4 adds the live-row probe + the `fts_pending`-empty clause)** |
| `rebuilding` | resume open | `rebuilding` | **verify `triggersPresent()`** — if any trigger was lost mid-rebuild, writes may have been missed ⇒ restart (watermark=0, same re-arm tx) |
| `rebuilding` | setup() quantum **or** no-arg `syncSearchIndex()` | `rebuilding` | advance watermark by ≤N chunk txs (below) |
| `rebuilding` | **completion: watermark ≥ max(entries.rowid) AS SNAPSHOTTED AT RE-ARM (rev 8, Opus delta-3 plan minor 2 — not the live max: an insert landing between the last window and the flip must not starve it; rows inserted after the re-arm are already ledgered by the triggers and drain normally once `live`) AND orphan-sweep cursor ≥ sweep snapshot AND the residual `fts_pending` fits in ONE final chunk, drained INSIDE the flipping tx (rev 8, Opus delta-3 m2: the rev-7 "`fts_pending` empty" clause is dropped — a `live` store drains its ledger normally, and draining an unbounded backlog inside the flip tx was the RC-1 shape again; the residual is capped at one chunk)** | `live` | flip state in the final chunk's tx |
| `live`/`rebuilding` | explicit `indexStrategy: 'minisearch'` | `detached` | `detachFts5` (unchanged behavior, operator-chosen) |
| `detached` | open with `indexStrategy: 'fts5'` **or `'auto'`** | `rebuilding` | **DROP+CREATE of `entries_fts` + ledger-table re-creation + triggers, watermark=0 — then content arrives via the chunked windows, NOT `rebuildSql`** (rev 7, Opus plan M6: `rebuildSql` over 1M rows is a ~125 s single tx, reintroducing RC-1; `rebuildSql` is deleted from init entirely, alongside `rebuildFromSource`) |

**DDL note (rev 7, extends the rev-6 settlement per Opus delta-cycle-2 spec M3
+ plan M4):** marker-loss and trigger-loss **keep both `fts_map` AND
`entries_fts` intact** — only `fts_pending` is cleared, and only the triggers
are re-created. The rebuild window is a dedicated **`windowChunkSql` (rev 8,
Opus delta-3 m1 — NOT the `drainChunkSql` shape)**: `drainChunkSql`'s fifth
statement is `DELETE FROM fts_pending WHERE seq <= ?`, which — reused with a
rowid binding — would delete unrelated ledger rows and lose concurrent writes
(and its binding shape differs: lo/hi vs seq). `windowChunkSql` has exactly
four statements, none touching the ledger, all bound to the window's
`chunkIds = SELECT id FROM entries WHERE rowid > ? AND rowid <= ?`: delete
FTS rows via the map, delete the map rows for those ids, insert map rows for
live ids, insert the FTS rows. **The conflict-free claim rests on one
invariant, now stated (rev 7): every surviving `entries_fts` rowid has an
`fts_map` row.** When that invariant holds (trigger/marker loss on an intact
store), windows are conflict-free by construction: an id drained ahead of its
window has no ledger row, its map row is deleted+re-inserted by its window
anyway, and `fts_rowid` (INTEGER PRIMARY KEY, no AUTOINCREMENT) never
re-collides. When the invariant is in doubt (external corruption dropped the
map, or a partial detach lost the marker while `entries_fts` survived), the
re-arm tx runs a **cheap consistency check** (Opus spec M3, spelled out rev 8
per delta-3 m4): the keep-map path
is taken only if the max rowid of `entries_fts` (fetched via
`SELECT rowid FROM entries_fts ORDER BY rowid DESC LIMIT 1`, so FTS5 seeks
instead of possibly scanning a multi-GB table for `max()`) `<=
coalesce(max(fts_map.fts_rowid),
0)`; otherwise — and whenever either table is missing while the other has rows
— the re-arm takes the DROP+CREATE path. The max comparison alone cannot see
a ghost FTS row sitting in a GAP of the map's rowid space (its map row
deleted); rev 8 therefore adds plan delta-3 minor 1's **`count(*)` equality
check**, spelled out (rev 9 m1) as `COUNT(*)` on `entries_fts_docsize` — an
ordinary rowid table (one row per document, so `OP_Count` applies), NOT a
count on the FTS5 table whose scan plan steps through the multi-GB
`%_content` table — compared against the `fts_map` count, and run as a
**READ-ONLY probe BEFORE the re-arm transaction opens** (Change 4's
read-only-probes-first ordering; cheap next to a 22 s DROP+CREATE): the invariant
implies equal counts, so any mismatch ⇒ DROP+CREATE (and the orphan sweep,
walking `fts_map` by `fts_rowid`, covers below-max ghosts that still HAVE a
map row). **No DROP+CREATE and no 22.3 s floor**
on the intact marker-loss path; recall stays "previous index, **including rows
whose windows haven't re-run** (they are STALE — they don't reflect writes made
while the triggers were down — not missing; rev 7 m9 wording fix)". The
DROP+CREATE is reserved for (a) tokenizer/DDL mismatch vs the stored DDL
(detected by regexing the `tokenize=` clause, as `WikiMemory.ts:277` does —
raw comparison always mismatches because `sqlite_master` drops
`IF NOT EXISTS`), (b) failed consistency check per above, and (c) the detached
re-attach path where `detachFts5`'s best-effort `entries_fts` drop may have
failed (map untrustworthy ⇒ DROP+CREATE). The old rowid-collision chain (spec
rev 5's "keep map but clear map" contradiction) is closed: with `fts_map`
kept and the consistency check guarding the invariant, window re-dos are
genuinely idempotent.

**Orphan sweep (rev 7, cursor-based — required before the `live` flip):**
windows walk `entries.rowid`, so index rows whose entry no longer exists
(hard-deleted by `runPrune`, or id-changed while triggers were down) are never
visited. The sweep is **cursor-based** (Opus spec M4, replacing the rev-6
"final quantum runs the whole sweep first" shape, which added an unbounded
tail to one quantum): a meta cursor `fts5_orphan_sweep_cursor` (initialized to
0 at every transition INTO `rebuilding`, and set to `sweep snapshot =
max(fts_map.fts_rowid) at init` once reached) advances during full quanta;
each sweep tx deletes orphans in a bounded `fts_rowid` window and advances the
cursor atomically. **The sweep walks `fts_map` by `fts_rowid`, NOT
`entries_fts` (rev 8, Opus delta-3 m4):** on a 1M-row FTS5 table,
a rowid-offset window over `entries_fts` has the wrong cost shape — NOT
because FTS5 cannot use rowid bounds (rev 9 m2: FTS5 full scans DO honour
rowid bounds via `FTS5_STMT_SCAN_ASC`; the earlier "cannot seek" rationale
was wrong), but because each such window still makes FTS5's scan walk from
its lower bound to the offset, so cost grows with the remaining rows instead
of seeking (the starvations previously cited for `runPrune`'s `DELETE WHERE NOT
EXISTS` and the plan's NOT IN form are the same segment-scan cost at different
multipliers). Walking `fts_map` (a normal b-tree table) with the exact-index
anti-join `... FROM fts_map WHERE fts_rowid > ? AND fts_rowid <= ? AND NOT
EXISTS (SELECT 1 FROM entries WHERE entries.id = fts_map.id)` keeps each
sweep tx bounded. (On the detached re-attach path — DROP+CREATE — `fts_map`
starts empty, so the cursor trivially completes.) The sweep snapshot is taken once at init (not
re-evaluated at the end), so new map rows added during the rebuild are covered
by their own windows' live-entry inserts — they cannot be orphans. Completion
condition: **watermark ≥ the re-arm-time snapshot of max(entries.rowid) AND
orphan-sweep cursor ≥ sweep
snapshot AND the residual `fts_pending` fits in one final chunk drained inside
the flipping
tx** (rev 8 m2 rework; see the transition table), so a steady trickle of
writes cannot starve the flip indefinitely — and the flip tx itself stays
bounded.

² The remaining DROP+CREATE cases (tokenizer/DDL mismatch, failed re-arm
consistency check, detached re-attach) are single-statement
DDL and unchunkable: measured 22.3 s @1M (investigation §2.2, V3 bucket) —
declared, bounded in Acceptance 3, excluded from the steady-state fence claim
(Acceptance 4). RC-3's *prevention* half: init writes state+triggers
atomically in one tx; this spec retains that invariant so a *cleanly crashed*
open never loses the marker (crash ⇒ `rebuilding` resumes; only external
corruption/manual deletion reaches marker-loss paths, which no longer pay the
DDL floor).

**Chunked rebuild mechanics:** rowid **windows** of ≤500 entries-rows per
transaction, bounded the `drainHiSql` way (rev 9, Opus delta-4 M5;
`fts5Sql.ts:64-66` pattern): each window's `hi` = `max(rowid)` over the next
≤500 EXISTING rows — never a fixed-width `rowid > ? AND rowid <= ?` span —
so a window bound always lands on a real row even when deletes left gaps
(throughput legs measured row-dense stores). Each chunk tx commits its inserts + the watermark advance atomically.
Exactly-once under resume verified at 1M (`fb-crash-resume` leg: SIGKILL at
400k/1M mid-rebuild, resume completed 600k in 78.9 s, 1,000,000 map rows,
0 duplicates) — single-writer case; the concurrent-writer shape is covered by
the conflict-free insert construction above plus Acceptance 7(a).

**Concurrent writers during `rebuilding`:** entry triggers (re-created by
every transition into `rebuilding`) keep appending to `fts_pending` while the
watermark advances; a row written mid-rebuild can be present in both the
rebuild range and the ledger. The conflict-free window inserts make that
harmless. Completion condition: **watermark ≥ the re-arm-time snapshot of
max(rowid) AND residual ledger fits one final chunk,
both re-checked inside the flipping transaction**, with the residual drained
inside the flip tx. **Acceptance 7(a) includes the specific
drain-before-window case:** update a row ABOVE the watermark, drain, then let
that row's window run — no duplicate, no stall.

**Budget semantics (rev 6: interface contract per Opus delta M2/M3):** the
quantum is bounded by `setupBudgetMs` (default **1500**), checked **between**
chunk transactions, worst-case wall = budget + 2 × max chunk (rev 8 fixes the
m5 contradiction: line-level "budget + max chunk" undercounted the
drain-overrun case; Acceptance 2/5's "budget + 2 × max chunk" is the
authoritative bound, per Opus delta m1). **The drain interface
is specified**: `drain(opts?: { deadline?: number; mode?: 'ledger' | 'full';
ids?: readonly string[] })` — `mode: 'ledger'` never runs rebuild chunks;
`ids` are the caller's own ledger rows, drained FIRST via an id-targeted chunk
(`SELECT id FROM fts_pending WHERE id IN (SELECT value FROM json_each(?))`),
so read-your-writes survives backlogs regardless of the 500-row seq window
(the "newest seq window" phrasing is retired — it can miss the caller's rows
under >500 concurrent writes). `syncEntries`/`sync(id)` thread their ids
through `drainTurn`. **Empty-`ids` + `entityId` sync targets the ledger by
`entity_id` (rev 8, Opus delta-3 M4):** the `upsertGraph` doc
(`WikiMemory.ts:765-768`) tells hosts to call `syncSearchIndex(entityId)`
after commit, which becomes `syncEntries(entityId, [])` — with an empty id
list there is nothing to drain first and `markStale` does nothing once a
strategy has a `drain` (`SearchService.ts:243`), so under a backlog the
documented call leaves the new nodes unsearchable. `drain({ids: []})` with an
entity target therefore drains `fts_pending WHERE entity_id = ?` — **ORDER BY
seq, ≤500 rows per tx (rev 9 plan m5), the same cap as the ids-first path.**
**ids threading (rev 9, Opus delta-4 M3):** `WikiMemory.upsertGraph` already
holds `params.nodes[].id` in process — it STASHES them per entity (in place
of today's `markStale` call, `WikiMemory.ts:765-768`/`:816-827` contract) and
threads them as `ids` on the next `syncSearchIndex(entityId)`, so the
ids-first ≤500-id chunk covers the new nodes even when a 1M-row crash
backlog all belongs to that single entity (oldest-first seq order alone
would never reach the highest-seq new nodes within the write-turn budget).
Because the ids-first chunk
(`WHERE id IN json_each`) would full-scan the ledger on every write —
`fts_pending` has NO indexes today (`fts5Sql.ts:40-44`) — this change adds
`fts_pending(entity_id)` and `fts_pending(id)` indexes (trigger overhead
accepted; the ids-first step runs on the write path). **These two CREATE
INDEX statements are declared and BUDGETED (rev 9 m5)** alongside the
Change-2 partial index: they are unchunkable DDL built on the first
new-engine open, so a store with a large crash backlog pays their build
there — counted in the chunked-open budget and in Acceptances 4 and 6, not
per-open. The `upsertGraph` and
`syncSearchIndex` doc comments state the bounded-sync contract, and
acceptance 7(r) pins upsertGraph-then-search under a backlog. **One deadline per open**: `setup()` captures
`openDeadline = setup start + budget` (rev 8, plan delta-3 minor 4 — one
capture point, named) and passes it through the migration and the
post-migration `sync({ deadline })` — no per-turn re-budgeting (M-3 holds).
Because normalize runs to completion regardless of budget (Change 1), a
migration open can spend the entire budget in the migration: **the first
index quantum may be skipped on a migration open; convergence resumes on the
next open — stated explicitly, not an accident.** `SearchService.sync` gains
an options parameter — `sync(entityId?: string, opts?: { deadline?: number })`
(rev 8, plan delta-3 minor 3; the existing `sync(entityId)` call at
`ImportExportService.ts:452` keeps compiling unchanged).
**Which entry point does what** (corrected paths per Opus delta m1):
- `setup()` — full quantum (`sync()` → `drainTurn`): normalize (migration
  open), ledger drain, rebuild chunks. The convergence workhorse.
- **no-arg `syncSearchIndex()` → `syncStale()` → `drainTurn`** — full quantum
  (and the init-retry point; `WikiMemory.syncSearchIndex()` owns the retry,
  not `SearchService`, which has no db/prefix/metadataRepo).
- **`syncEntries`/`sync(id)` (write-triggered) — LEDGER DRAIN ONLY** with the
  caller's `ids` first. **Concrete write-turn budget (rev 9, Opus delta-4
  M3):** a write-triggered turn drains **own ids + at most ONE ledger chunk**
  (≤500 rows, `ORDER BY seq` — rev 9 plan m5); any remainder is left to
  background/stale drain (setup() quanta and no-arg `syncSearchIndex()`). A
  write must not pay ~2.5 s.
- Arbitration within a full quantum: ledger drain first, then rebuild chunks
  with the remainder; **at least one rebuild chunk per full quantum unless the
  drain overran the deadline** (bounds worst-case wall at budget + 2 × max
  chunk ≈ 3.5 s, per Opus delta m1 — Acceptance 2/5 updated accordingly).
  **Degraded-write ordering audit (rev 8, Opus delta-3 m7):** every degrade in
  the call-site map below was audited for ordering — each degrades recall or
  spend (prefilter outage propagates with the fallback event fired,
  pass-level gate abort, pass-level heal skip, no-op drain); none leaves a
  half-applied write (the only
  partially-applied surface, `syncEntries`'s per-id loop, already applies
  whole ids or throws). The takeaways §4 partial-visibility concern
  (normal parts searchable, failed parts findable as text) is met by
  gate.ts's exact-text `noop` lookup, not by writing unsafely during an
  outage.
- The migration normalize runs to completion (Change 1), sharing the
  openDeadline only in that both finish within the open; the CREATE INDEX
  build remains a declared one-time cost (Acceptance 6 records observed max
  chunk at gate scale — FTS5 auto-merges can stretch it).

**Convergence vehicle — open-driven, with a safe write path.** There is no
background-tick mechanism in the engine today (`drains run inside sync()`,
`SearchService.ts:96-116`), and this spec does not add one. Convergence
happens in `setup()` and in no-arg `syncSearchIndex()` (→ `syncStale()`);
writes converge only their own ids and stay fast. **Host contract:** a
long-lived process that neither re-opens nor calls no-arg `syncSearchIndex()`
holds a partially-recalled index indefinitely — SynapseTree must call
`syncSearchIndex()` on a schedule it owns (sign-off recorded in the review log
at implementation). Recall during `rebuilding` is **partial, by design, and
the only mode** — there is no strict-recall alternative (the previously
drafted `searchConsistency: 'strict'` LIKE-fallback is cut: no SQL LIKE path
exists in the engine, and a `%q%` body scan would relocate the fence problem
into every query). Mid-drain recall verified (`profile-fb-prototype.ts`);
with the rev-6 re-arm, recall during marker-loss rebuild stays at
"previous index, **including rows whose windows haven't re-run (STALE, not
missing)**" instead of emptying (rev 8 m5: aligned with the rev-7 m9 wording;
the "minus re-run windows" phrasing here contradicted it).
**ACCEPTED RISK, stated explicitly (rev 9 m6):** during `rebuilding` —
especially the common detached→`auto` re-attach — partial recall feeds
INTERNAL consumers: heal stamps `heal_checked_at` against an incomplete
anchor set, and the gate may classify `add` for duplicates not yet
re-indexed (missed duplicates). Mitigations: the pass-level availability
aborts (heal, gate) cover true outages, and the rebuild-completion flip
bounds the window — an incomplete anchor set / missing duplicate exists only
until the rebuild converges, not permanently.

**Watermark validity under VACUUM (rev 8, Opus delta-3 M7 — mechanism, not
just guard):** `entries` is `id TEXT PRIMARY KEY` (`schema.ts:6`), so its
rowids are implicit and VACUUM may renumber them — a resumed rebuild windowing
from a stale watermark would skip renumbered rows and flip to `live` with
permanently unindexed ranges. Two mechanisms, both required: (1) the rebuild
watermark is stored WITH a **fingerprint — the `id` at the watermark row** —
and every quantum (and the flip check) first verifies the fingerprint id still
sits at that rowid. **Window bounds and fingerprint placement (rev 9, Opus
delta-4 M5 — replaces the rev-8 fixed-span + restart-on-missing shape):**
each window's `hi` is `max(rowid)` over the next ≤500 EXISTING rows (the
`drainHiSql` pattern, `fts5Sql.ts:64-66`), and the fingerprint is taken at
THAT row — so the upper bound never lands in a rowid gap (a fixed-width
span's `hi` often lands in a gap, restarting every quantum — a livelock on
any store that has run `runPrune`, whose hard-deletes at
`MaintenanceService.ts:301` can remove the fingerprint row). **On a missing
fingerprint row the engine RE-LOCATES — recomputing the watermark from the
surviving predecessor (rows ≤ wm are exactly the rows before it) — rather
than restarting.** SQLite's docs say only that rowids MAY change on VACUUM —
rev 8's "VACUUM preserves rowid order" reliance is withdrawn; the design
NEVER assumes rowid order: the engine's own vacuum path resets both
watermarks AND the fingerprint (mechanism below), and re-location is the
recovery for any OTHER reorder. (2) The normalize
watermark gets the same fingerprint treatment (7(p), per delta M4), and —
because `runPrune({vacuum: true})` runs VACUUM **in-process**
(`MaintenanceService.ts:345-346`, not only before the "next open") — the
engine's own vacuum path resets BOTH watermarks (and the sweep cursor) as part
of the vacuum step, so a long-lived host's scheduled `syncSearchIndex()`
restarts cleanly instead of windowing over renumbered rowids. Test 7(k) is
extended to cover in-process VACUUM followed by `syncSearchIndex()` in the
same process (plan delta-3 M5).

**`WikiSearchUnavailableError` — complete call-site map (rev 7: 6 sites, per
the issue-271 takeaways §3 rule: grep ALL callers, pin each — the rev-6 map
said "5 sites" and missed one; found by grepping, not trusting the prior map,
Opus plan M2):** the error can surface from 6 sites, each pinned:
- `RetrievalService.ts:189` (prefilter) and `:223` (hybrid keyword boost via
  `getKeywordScores`): at `:189` — **rev 9 (Opus delta-4 M1) REVERSES rev 8's
  fall-through: the pinned behavior is PROPAGATE.** A full-scan fall-through
  is not a degrade, it is the unbounded read path itself: at
  `preFilterLimit` scale the full-scan branch
  (`RetrievalService.ts:212-225`) re-opens the OOM this spec exists to
  prevent — `findWithEmbeddingsByEntityIds` (`EntryRepository.ts:1524-1532`)
  has NO LIMIT and loads `embedding_blob` plus the JSON `embedding` for
  every live row of the scored entities (the 1.83 GB heap class at 1M), and
  a host that sets `preFilterLimit` cannot afford that full scan. Failing
  loudly IS the correct degrade: the error propagates via today's two-hop
  path — caught at `:668`, `onRetrievalFallback` fires, the `:719` site
  throws — with NO silent empty read and NO OOM. At `:223` the pinned
  behavior (rev 9 m9 wording) is to **ADD a local catch → empty keyword
  scores map** (no local catch exists today; today the error escapes to
  :668) — the hybrid blend has a real vector path, so an empty keyword
  scores map degrades recall, not the read. Pinned by 7(n) (prefilter-limit
  host, outage ⇒ two-hop propagate + fallback event; NO full-scan leg) and
  7(n′) (weight < 1 blend).
- `RetrievalService.ts:719` (keyword-only fallback): **propagates** to the
  caller (explicit degraded signal; keyword-only reads genuinely have nothing
  to fall back to). **Rev 8 (Opus delta-3 m6) mechanism note:** the `:550`
  site is NOT the propagation mechanism — it sits inside the try at :142; its
  error is caught at :668, fires `onRetrievalFallback`, and the :719 site
  then throws. Same outcome, two hops; the pinned test asserts the two-hop
  path, not a direct throw at :550.
- `RetrievalService.ts:550`: **propagates** (unchanged rev-5 decision; see
  the two-hop mechanism note above).
- `MaintenanceService.ts:1542` (heal anchors): **rev 8 (Opus delta-3 M3)
  replaces the rev-7 degrade options — BOTH rev-7 options were wrong.**
  Gating stamping on anchors-found > 0 starves zero-anchor facts (a normal,
  non-outage result) at the head of the `updated_at ASC` queue forever — the
  exact bug the stamp prevents (`MaintenanceService.ts:1014-1019`);
  returning before stamping still pays the LLM call (the anchor selection at
  :1527 runs inside the per-batch prompt builder at :860 — the call has
  already happened) and may still apply the model's downgrades/deletes at
  :965-966. **Pinned behavior: availability is checked ONCE at the start of
  `doRunHeal`; on unavailability the whole pass is skipped with one
  diagnostic — no LLM spend, no mutation, no stamps; candidates are treated
  as unattempted (the `unattemptedIds` handling at :1034).** This follows
  takeaways §5 (check the precondition before spending).
- **`services/librarian/ops/gate.ts:143` (librarian gate keyword fallback —
  NEW in rev 7, Opus plan M2; REV 9 (Opus delta-4 plan M1) replaces rev 8's
  per-candidate degrade with a PASS-LEVEL ABORT:** before gating, if keyword
  search is unavailable, abort the librarian pass without advancing the
  watermark — the same pattern as `resolve.ts:123-129` — zero LLM calls,
  zero new rows (rev 8's per-candidate
  `ambiguous`+exact-text shape still duplicates via runResolve's
  draft-insert: an `ambiguous` candidate enters the resolution draft and its
  ADD lands on commit). The bounded SQL exact-text `noop` lookup is kept as
  DEFENSE IN DEPTH INSIDE the pass — an exact duplicate still classifies
  `noop` if the pass runs — but it is not the primary fix. Pinned by 7(e):
  an outage yields zero LLM calls, zero new rows, and an unchanged
  watermark. (Re-verified by grep: `gate.ts` is the sixth and last
  `searchKeyword` caller outside SearchService itself.)
- `syncEntries`/`drainTurn` paths: unavailable strategy's `drain` is a no-op
  (ledger intact; no per-write warning spam).

### Change 4 — RC-6 guard: failure-ordered init, retry, never demote

Measured stakes: today's fallback commits `detachFts5` (artifacts permanently
dropped) then OOM-kills at ~202 s / 1.83 GB on the 1M store. The guard:

- **Ordering:** `init()` performs all *read-only* probes first (state read,
  `triggersPresent()`); the decision to enter `rebuilding` — the first
  mutation — happens in its transition transaction only after the probes
  succeed. A failure during probes therefore leaves zero mutation.
- On `init()` failure with `auto`: **retry once after a 250 ms backoff**
  (covers transient tx locks). The retry re-runs the probes (state may have
  been mutated by the first attempt's partial work — that is acceptable:
  `rebuilding` is a recoverable, converging state, unlike `detached`).
- If the retry also fails: **`detachFts5` is never called** — no demotion is
  committed in any failure path. If state was already mutated to `rebuilding`,
  it stays `rebuilding` (the next open resumes from the watermark). The open
  completes with an **`UnavailableIndexStrategy`** installed: `search()` throws
  `WikiSearchUnavailableError` (cause = the init error); **`drain()` is a
  no-op (PRESENT — returns immediately), not an absent property** (rev 7, per
  Opus plan B1: the `SearchService` drain-less fallback paths
  (`SearchService.ts:127/:177/:255`) call `findMiniSearchRows()` and
  `replaceAll` — a full-table read + in-memory index build, i.e. the measured
  1M OOM path — so a missing `drain` property silently re-opens RC-6's crash
  through the back door; the no-op `drain` keeps every entry point on the
  ledger-safe path). Write paths keep working and
  converging later; no warning spam per write. `replace`/`replaceAll` remain
  no-ops; `hasIndexedEntity()` returns false. **Internal-caller behavior
  (Opus M-7), decided; REV 9 (Opus delta-4 M4) — this paragraph and
  Acceptance 7(e) are REWRITTEN to match the Change-3 call-site map exactly,
  which is the single source of truth for these behaviors; the rev-7
  degrade wording here was stale:** the maintenance heal path
  (`MaintenanceService.ts:1542`) performs the pass-level availability check
  at the START of `doRunHeal` — on unavailability the whole pass is skipped
  with one diagnostic (no LLM spend, no mutation, no stamps; candidates
  unattempted), NOT a rev-7-style "no heal anchors available" degrade; the
  retrieval keyword fallback (`RetrievalService.ts:550`) propagates the error
  via the two-hop path (caught at :668, `onRetrievalFallback` fires, :719
  throws — explicit degraded signal, not silent empty results); the
  librarian gate (`gate.ts:143`) takes the pass-level availability ABORT per
  the map below (zero LLM calls, zero new rows, watermark untouched), with
  the bounded SQL exact-text `noop` lookup kept as defense in depth INSIDE
  the pass; all pinned by tests. Additionally, **no-arg `syncSearchIndex()` retries
  `init()`** — a long-lived host that never re-opens still recovers.
  **Persistent-failure repair path (rev 8, Opus delta-3 M6):** if init fails
  on EVERY attempt (e.g. `SQLITE_CORRUPT_VTAB` from a damaged `entries_fts`
  shadow table, hit by the consistency probe or `fts5TablesDdl`), the transient
  retry alone means a permanent keyword outage — takeaways §2's strict
  precondition without a repair path, and M1–M3's degrades then persist
  indefinitely. Init therefore **classifies the error**: a corruption-class
  error — scoped (rev 9 m3) to `SQLITE_CORRUPT_VTAB` and to errors from
  statements touching ONLY FTS tables (`entries_fts` + its shadow tables) —
  triggers the **safe DROP+CREATE re-arm** into `rebuilding` — safe because
  `entries` is never touched — and the next open converges via the chunked
  windows. A generic `SQLITE_CORRUPT` raised from `entries` pages (e.g. by
  the "live entries exist" probe) must NOT trigger DROP+CREATE: dropping a
  good multi-GB index cannot fix corrupt entries pages and would still fail
  every window — those errors keep the never-demote
  `UnavailableIndexStrategy` path. Other
  persistent errors keep the never-demote `UnavailableIndexStrategy` path with
  the no-arg `syncSearchIndex()` retry. Test 7(e) gains a corrupt-FTS leg.
- Detach + MiniSearch fallback remains available **only** via explicit
  `indexStrategy: 'minisearch'` (operator's deliberate choice). Even that path
  carries the measured memory ceiling: the MiniSearch full sync OOM-killed a
  default Node heap at **1M entries** — operators of pro-scale stores need a
  raised `--max-old-space-size`, documented next to the option.
- `probeFts5` failure (module genuinely absent) still falls back to MiniSearch:
  that case is permanent, not transient. Its memory ceiling is the same
  documented one.

## Write-path invariant audit (precondition for the Change-1 stamp)

The stamp asserts "all stored source_refs are normalized as of algorithm N" —
in BOTH tables that store a copy, `entries.source_ref` AND
`source_ref_index.source_ref` (rev 9, Opus delta-4 M2; the migration's second
watermarked pass covers the second copy). That is sound only if every write
surface normalizes. Audited surfaces
(closing investigation open question 2):

- `WikiMemory.hasChanged` single + batched paths (`normalizeSourceRef` at
  :349/:371/:433/:810), `IngestionService` (:121), `MaintenanceService`
  (:540/:640), `ImportExportService` (:275).
- **Belts:** (a) the violation predicate is cheaply re-checked whenever the
  stamp's `normalize_alg` id bumps (one rescan — already the stamp-mismatch
  behavior); (b) **already satisfied by existing code (Opus MIN-7):**
  `importDump` normalizes every imported `source_ref` at
  `ImportExportService.ts:273-282` (throwing if it normalizes to null), so an
  imported dump can never violate the stamp invariant — no dump-header
  machinery is added. Host-side raw SQL bypassing these surfaces is outside
  the engine's contract and documented as such.

## Config surface

- `setupBudgetMs?: number` (default **1500**): max wall time each quantum
  spends on rebuild/drain/migration chunk work — per open, and per
  `syncSearchIndex()`/`sync()` call — checked between chunk txs.
- `indexStrategy` keeps its existing shape; `'auto'` semantics change per
  Change 4 (never silently demotes) and per Change 3 (`auto` re-attaches
  `detached` stores). No `searchConsistency` option ships.
- `WikiSearchUnavailableError` (new public contract): exported from
  `packages/core/src/index.ts`, stable name, `cause` chains the underlying
  init failure, thrown per search query while keyword search is unavailable.
  The pinned `'fts5'` failure path keeps today's behavior (the underlying
  error propagates, `createIndexStrategy.ts:65`) — unchanged contract.

## Acceptance

Cache state is stated per criterion (warm = page cache retained; the
investigation measured a 2.8× warm/cold swing, §2.3).

1. **Warm open @1M:** setup() ≤ 1 s warm / ≤ 3 s cold (today: 1.74 s warm on
   the profile-setup harness / 4.82 s COLD in the investigation's in-process
   measurement — rev 9 m7 labels it cold; it pairs with the ≤3 s cold target
   of this criterion — delta-3 m7: both figures named — the criterion uses the
   profile-setup harness; either baseline is exceeded by orders of magnitude
   post-fix), of
   which 1.73 s is RC-2 scans; post-fix predicted ~0.01 s for the scan pair).
2. **Converged rebuild open @1M** (`rebuilding`, watermark advanced by prior
   opens): setup() returns within budget + 2 × max chunk (≤ 3.5 s @1M defaults
   — the forced-final-chunk rule allows one extra chunk, Opus delta m1).
   **Pinned `'fts5'` retry behavior (delta-3 m7):** a pinned `'fts5'` init
   failure does NOT retry or demote — the underlying error propagates
   immediately (`createIndexStrategy.ts:65`, unchanged contract).
3. **Marker-loss path @1M:** first open completes the re-arm tx + ≥1 quantum
   and returns; the common marker-loss path has **no DDL floor** (map + table
   kept — see the DDL note). The tokenizer-mismatch and detached-re-attach
   cases keep the measured 22.3 s @1M floor as their accepted bound
   (explicitly outside the steady-state fence claim — see 4). Convergence
   thereafter per 2. Tests: delete the meta row + one trigger on a built
   store, **plus the rev-6 orphan case**: with triggers missing, hard-delete
   one row (runPrune) and rename another, converge, assert neither is
   searchable (orphan sweep works, 7(g′)).
4. **Steady-state fence (the gate claim):** every open of a `live` store —
   warm, cold, and post-crash-resume — completes inside 15 s at 4.7 GB NVMe
   (measured re-run, criterion 6; the unchunkable CREATE INDEX builds —
   partial index + the two `fts_pending` indexes — are budgeted on the
   first new-engine open, criterion 6, not here). Marker-loss/first-migration opens are
   excluded from this claim and bounded by 3 and 6 respectively.
5. **Crash backlog @1M:** 1M undrained ledger rows add at most
   budget + 2 × max chunk to any single open (measured shape: 7.6k rows/s in
   ≤1.01 s chunks), converging across opens instead of the current
   single-open drain (≈123 s per 1M undrained rows, [C] derived).
6. **Gate-scale re-measure (required):** the ~4.7 GB NVMe store re-measured
   before/after on this machine (`profile-setup.ts`; legs ~30–45 min each).
   Includes the foreign-store first-open shape (`setupDatabase` DDL incl.
   repeated CREATE INDEX + normalize + first quantum; rev 9 m5: the two
   unchunkable `fts_pending(entity_id)`/`fts_pending(id)` CREATE INDEX
   builds are budgeted here alongside the partial index). Targets are **derived
   from a required @1M normalize measurement** (the ≈123 s figure is the
   *drain* rate; the normalize rate is unmeasured — Opus delta M3): measure
   chunked normalize @1M, scale ×4.2, add the `setupDatabase` component
   (≈ 69 s) + first quantum, and record the result here — with the explicit
   statement that **a first migration open on a foreign store exceeds the
   15 s fence by design** (one-time, chunked, crash-resumable). Per-tx windows
   stay fence-tolerable throughout; the largest observed chunk commit time at
   gate scale is recorded here (FTS5 auto-merges can stretch it); steady-state
   per 4.
7. **New tests:** (a) concurrent-writer rebuild exactly-once — triggers
   appending while the watermark advances, completion condition per Change 3,
   **including the drain-before-window case** (update a row above the
   watermark, drain, then its window runs: no duplicate, no stall);
   (b) fresh-store fast path writes v14 stamp + partial index (GAP-3);
   (c) downgrade/backup-restore stamp invalidation forces exactly one rescan
   (GAP-3); (d) stamp-missing self-heal (Change 1); (e) RC-6: forced init
   failure ×2 on a healthy 1M store — no `detachFts5` call (spy), state not
   `detached`, `WikiSearchUnavailableError` thrown per query, next open
   recovers; **the Change-3 call-site map is the single source of truth for
   the outage behaviors and 7(e) pins it as rewritten in rev 9 (delta-4 M4):
   heal pass-level skip (one diagnostic, zero LLM calls, no mutation, no
   stamps), retrieval keyword fallback propagates via the two-hop path, the
   librarian gate takes the PASS-LEVEL availability abort (zero LLM calls,
   zero new rows, watermark untouched) with the bounded SQL exact-text
   `noop` lookup kept as defense in depth INSIDE the pass — NOT a
   per-candidate ambiguous+exact-text degrade and NOT "vector-only
   context"; write during unavailability succeeds, its ledger rows survive,
   and NO full-table read fires while unavailable (`findMiniSearchRows`
   never called — pins the B1 no-op-`drain` fix)** (Opus M-7 + rev 7 plan
   B1/M2 + rev 9 delta-4 plan M1);
   (f) `detached` store semantics: under pinned `indexStrategy: 'minisearch'`
   the store stays detached; under `'auto'` (the default) it re-attaches —
   enters `rebuilding` and converges via CHUNKED WINDOWS (no `rebuildSql`
   single tx — rev 7 plan M6) (per Change 3's transition table);
   (g) marker-loss transition produces the defined re-arm + rebuild sequence,
   **triggers verified present after the transition and after mid-rebuild
   resume** (GAP-5/CRIT-1/Opus B-2) **+ the rev-6 orphan case: triggers
   missing, hard-delete one row (runPrune) + rename another, converge, neither
   searchable** (Opus delta B1 7g′) **+ the rev-7 consistency-check case: an
   externally corrupted store (`entries_fts` surviving rowids beyond
   `max(fts_map.fts_rowid)`) takes the DROP+CREATE re-arm path, not the
   keep-map path** (Opus spec M3); (h) `EXPLAIN QUERY PLAN` asserts the
   partial index serves the legacy probe; (i) budget arbitration order (drain
   before rebuild within a quantum) **+ write-triggered turns stay
   drain-only** (a write during `rebuilding` never runs rebuild chunks);
   (j) watermark resume exactly-once (the leg harness promoted to an
   integration test); (k) **VACUUM guard:** a post-VACUUM open detects the
   invalid rebuild watermark and restarts the rebuild (Opus M-6) **+ rev 8:
   the fingerprint check (delta-3 M7) and the in-process-VACUUM-then-
   `syncSearchIndex()` leg (plan delta-3 M5)**; (l) migration
   normalize **runs to completion regardless of the time budget** (small
   budget, all refs still normalized; budget affects only the post-migration
   sync); (m) **read-your-writes under backlog:** 5k-row ledger backlog + one
   write → the written fact is searchable immediately after `syncEntries`
   returns (ids-first drain, Opus delta M3); (n) **prefilter host outage (rev 9, delta-4 M1 — REVERSES rev 8's
   fall-through):** a `preFilterLimit` read with unavailable keyword scores
   PROPAGATES via the two-hop path (caught at :668, `onRetrievalFallback`
   fires, `:719` throws) — the test pins the two-hop path + the fallback
   event and has NO full-scan leg (the rev-8 full-scan fall-through re-opened
   the unbounded-embedding OOM); memory assertion: no full-candidate
   embedding load occurs;
   (n′) **hybrid blend survives a keyword outage:** `weight < 1` read with
   unavailable keyword scores still returns vector-ranked results
   (`:223` site, delta-3 M1 keep); (o) **heal pass skipped on unavailability:**
   a keyword outage yields ONE diagnostic, no LLM spend, no mutation, and no
   `heal_checked_at` stamps — and a fact that heals to zero anchors (no
   outage) IS stamped (rev 8, delta-3 M3); (p) **VACUUM guard
   extended to the normalize watermark** (Opus delta M4); (q)
   **`normalizeSourceRef` idempotency property test:** `n(n(x)) === n(x)` for
   arbitrary strings (rev 8, delta-3 M5); (r) **`upsertGraph`-then-search
   under backlog:** after `upsertGraph` + `syncSearchIndex(entityId)` with a
   5k-row ledger backlog, the new nodes are searchable (rev 8, delta-3 M4;
   rev 9 M3: via the upsertGraph id stash threaded as `ids` into the
   ids-first ≤500-id chunk, plus at most one ledger chunk per write turn);
   (s) **v14 second-pass `source_ref_index` migration (rev 9, delta-4 M2):**
   a 254-char ref + space + tail is ingested BEFORE the migration, then the
   SAME document is re-ingested AFTER it — the old `source_ref_index` row is
   soft-deleted (exact-ref match now hits the normalized form), with NO
   `WikiSourceRefHashCollision` and NO partial-UNIQUE `(entity_id,
   source_hash)` collision.
8. Existing test suite green. **Note (rev 9 m8):** `createIndexStrategy.test.ts:69,89`
   (which assert `'detached'` after an `auto` fallback) are REWRITTEN by this
   change — the auto fallback no longer detaches — they are not merely kept
   green.

## Out of scope

- Embedding/vector index warm-up costs (separate concern, not in the 693 s).
- Changing the writer-lease fence duration itself (SynapseTree-side).
- A background convergence tick (explicitly cut — host contract instead).
- A strict-recall search mode during `rebuilding` (cut — see Change 3).
- Sharding or partitioning the entries table.
- Multi-process concurrent setup coordination beyond today's tx locking.

## Review log

- **Step 0 converged 2026-10-10:** GLM 5.3 r1 + 8 sandbox legs + Opus pass;
  verdicts in the investigation doc §6. Leg evidence: `minisearch-fallback-cost`
  (demotion commits, then OOM 202 s / 1.83 GB / exit 134) and `fb-crash-resume`
  (exactly-once at 1M) — logs preserved as PR #281 comments.
- **Tier-2 spec review r1 (GLM 5.3 non-flash, fresh context, 2026-10-10,
  session 20261010_071858_5c481e):** verdict **Changes requested** — 1 Critical
  (RC-3 marker-loss unspecified; acceptance collision with the 22.3 s DDL
  floor), 9 Important (false "LIKE path exists" claim → strict mode cut; RC
  numbering inverted vs investigation §3 → realigned; 693 s decomposition
  asserted as measured → marked [C], unsupported ~4M backlog term dropped;
  OQ-2 writer invariant unresolved → audited with belts; stamp lifecycle cases
  → specified; state-machine transitions → table added incl. `detached` and
  the concurrent-writer completion condition; convergence vehicle nonexistent
  → open-driven contract stated; Acceptance-5/fence self-contradiction →
  steady-state fence claim scoped; Change-4 mutation ordering → failure-ordered
  redesign), 11 Minor (all applied: GLOB attribution, tx-envelope phrasing,
  50 MB row labeled as issue-sourced, "40% drained" → "mid-rebuild at 400k/1M",
  exact 1500 default, rowid-window wording, tightened warm-open criterion with
  cache states, CREATE INDEX not chunkable, MiniSearch memory ceiling
  acknowledged, 16–30 s extrapolation range, :72 citation). Full review:
  `.sandbox/glm-spec-review-r1.md`. All Critical/Important/Minor findings
  addressed in this revision; acceptance gaps GAP-1..5 folded into criterion 7.
- **Tier-2 spec review r2** (2026-10-10, GLM 5.3 non-flash, session
  20261010_073802_081b1f, full text `.sandbox/glm-spec-review-r2.md`): verdict
  **Changes requested** ("close to approvable") — all 26 r1 findings verified
  genuinely addressed with exact line-citation re-verification; number audit
  clean except NEW-3: the "~85 s per 1M backlog" RC-4 figure was never directly
  measured (the WAL-leg logs died in harness errors) — corrected to the derived
  ≈123 s in both documents this revision. New findings, 0 Critical: 2 Important
  (NEW-1 `detached`-under-`auto` self-contradiction — one reading
  deterministically re-instantiates the MiniSearch OOM path; NEW-2 the
  `sync()`-convergence claim had no mechanism behind it) + 6 Minor
  (`WikiSearchUnavailableError` API shape, Acceptance-6 target derivation,
  OQ-2 bookkeeping, historical RC-2 slip, two citation nano-drifts). All
  addressed in spec rev 3; `auto` now re-attaches detached stores, and
  `syncSearchIndex()` runs the shared budgeted quantum.
- **Tier-2 spec review r3** (2026-10-10, GLM 5.3 non-flash, session
  20261010_080437_41a693, full text `.sandbox/glm-spec-review-r3.md`): verdict
  **Changes requested** — "the design itself holds; no design work requested;
  all four findings are localized text edits." All 8 r2 findings verified
  resolved at their sites, with the reviewer independently confirming NEW-3's
  premise (read the WAL-leg logs: ENOENT + TransformError) and re-deriving
  122.7–123.5 s, plus a clean number audit (16.5 × 4.2 = 69.3; 71.6 ≤ 120;
  194.6 ≤ 240). Findings, all applied in rev 4: R3-1 (Important) Acceptance
  7(f) still mandated the old detached-stays-detached behavior, contradicting
  auto re-attach — test rewritten to cover both preference semantics; R3-2
  (Minor) "~85 s" remnant in investigation §6 review-log summary; R3-3 (Minor)
  Config surface + transition table said "per open" only — now name the shared
  sync quantum; R3-4 (Minor) the bare "never instantiated by auto" over-claimed
 against Change 4's module-absent path — scoped to the failure path.
 - **Tier-3 Opus spec pass** (2026-10-10, `opus-review --doc` medium effort,
 30 research turns, $1.07, log `~/.hermes/cache/scratch/issue280/opus-spec-review.log`):
 verdict **REQUEST CHANGES** — 1 BLOCKER + 7 MAJOR + 7 Minor. Both converged
 findings with the independent Opus plan pass (below) were design-level and
 real: **B-1** no plain `INSERT ... SELECT` may target `fts_map` on the
 rebuild path (UNIQUE(id) rejects, never skips — conflict-free window inserts
 specified in Change 3); **B-2** transitions into `rebuilding` must
 (re-)create the triggers in the transition tx and verify them on resume
 (table updated; test 7(g) extended). Accepted MAJORs: **M-1** write
 pay-for-rebuild — write-triggered turns are now LEDGER DRAIN ONLY
 (full quantum only in setup() and no-arg `syncSearchIndex()`); **M-3**
 one deadline per open (normalize + post-migration sync share it); **M-4**
 drain ordering must serve the triggering write's own ids first
 (read-your-writes); **M-5** normalize runs to completion, not budget-deferred
 (mixed-refs window breaks `hasChanged`/`forget`); **M-6** VACUUM rowid
 renumbering invalidates watermarks — guard + test 7(k); **M-7**
 `UnavailableIndexStrategy` contract incl. heal degrade / retrieval propagate
 / no-op drain, + no-arg `syncSearchIndex()` retries init. Accepted and
 highlighted: **M-2** the marker-loss DDL floor is unnecessary — the existing
 table is stale-not-corrupt, rebuild delete-then-inserts per window into it
 (DDL floor reserved for tokenizer/DDL mismatch; recall during rebuild starts
 non-empty). MIN-7: `importDump` already normalizes imported refs
 (`ImportExportService.ts:273-282`) — belt (b) needs no new machinery (the
 GLM ladder missed this; dual-tier value proven). Remaining Minors applied:
 watermark cleanup, chunk-boundary edge, doc-comment updates, test-suite
 bookkeeping (`migration13.test.ts` hardcode), empty-table rowid guard,
 `rebuildFromSource()` dead code removal. **Spec rev 5 = this revision.**

 **Rev 7 (cycle #2 adjudication, all verified against source before
 adoption):** Opus spec pass: 0 BLOCKERS / 4 MAJOR / 9 minor — **M1** (map
 truncation during chunked rebuild starves `getKeywordScores` until
 completion → wfh-relevant retrieval regression; kept, weight<1 window is
 bounded and shorter than the 693 s baseline; plan Task 3 documents it),
 **M2** (acceptance harness must not touch DB/index directly — route through
 `wiki.search()`/`getKeywordScores`), **M3** (re-arm consistency check:
 keep-map only if `max(entries_fts.rowid) <= max(fts_map.fts_rowid)`),
 **M4** (orphan sweep cursor-based, snapshot at init). Minors applied: m2
 (flip tx drains residual ledger), m3 (`markHealChecked` runs regardless of
 anchors — degrade must return before stamping, or gate on anchors>0), m7
 (normalize predicate replaced by TS-side per-row comparison —
 trim-before-truncate drift kills any SQL predicate), m9 (stale-not-missing
 recall wording). Opus plan pass: **1 BLOCKER + 6 MAJOR + 7 minor — B1**
 (no-`drain` UnavailableIndexStrategy routes setup()/sync into
 `findMiniSearchRows` full reads: the 1M OOM through the back door →
 `drain` is a PRESENT no-op; corrected in plan rev 4's Task 2 and above),
 **M2** (SIXTH call site: `librarian/ops/gate.ts:143` — found by grep after
 the rev-6 map said "five"; degrades to vector-only gating),
 **M3** (`fts_map` lost + `entries_fts` alive + naive keep-map re-arm ⇒
 `DELETE ... WHERE id IN` misses everything, `INSERT` hits UNIQUE rowid
 collisions, rebuild wedges forever ⇒ covered by M3's consistency check),
 **M4** (`entriesExistedBeforeSetup` flag not plumbed into init ⇒ a truly
 fresh store whose marker row is absent would rebuild ⇒ flag passed down;
 fresh-store `live` stamp keyed on it), **M5** (deferred-detach cleanup
 path can clobber a `rebuilding` store — guard: the pending detach must
 no-op when state is `rebuilding` or re-run the marker checks first),
 **M6** (detached re-attach used `rebuildSql`: a ~125 s single tx that
 reintroduced RC-1 ⇒ `rebuildSql` deleted from init; re-attach enters
 `rebuilding` and converges via windows). Plan minors m2–m7 folded into
 Task text (test-id drift, budget-timeout test edge, clock-monotonicity
 note for `openDeadline`, `source_ref_index` note on NULL writes).
 Cycle-#2 spend: $1.62 (spec) + $1.54 (plan) = $3.16 vs ~$3 announced.
- **Tier-3 Opus delta cycle #3 (2026-10-10, spec 7 MAJOR + 7 minor, plan 0
BLOCKER + 7 MAJOR + 10 minor; logs `opus-{spec,plan}-delta3.log`; all key
source claims independently verified against the worktree before
adoption). Spec findings applied in this rev 8:** **M1** rev-7's
"empty keyword scores" degrade at `RetrievalService.ts:189` silently
empties prefilter reads (the keyword results ARE the candidate set,
:186-229; no vector path afterward) ⇒ fall through to the full-scan branch
+ `onRetrievalFallback`; new test 7(n); **M2** rev-7's gate.ts:143
"neighbours: []" degrade makes every librarian candidate an unconditional
ADD during an outage (`classifyCandidate` returns add when
`neighbours.length === 0`, :76) ⇒ classify `ambiguous`, with a bounded SQL
exact-text lookup first so duplicates still `noop` (7(e) pin); **M3**
rev-7's heal-anchor degrade options were both wrong (anchors>0 gate
starves zero-anchor facts forever at `MaintenanceService.ts:1014-1019`;
return-before-stamping still pays the LLM at :860 and may mutate at
:965-966) ⇒ check availability once at the start of `doRunHeal`, skip the
whole pass, treat candidates as unattempted (:1034); **M4** the m4/m1
sweep-window cost is a real starvation on FTS5 (`rowid > ? LIMIT n` cannot
seek; segment scan = O(remaining rows)) ⇒ the sweep walks `fts_map` by
`fts_rowid` with the exact-index anti-join; consistency-check `max()`
rewritten as an `ORDER BY rowid DESC LIMIT 1` seek; **M5**
`normalizeSourceRef` trim-then-truncate is non-idempotent (`pure.ts:909`)
⇒ `.trim().slice(0, 255).trimEnd()`, `SOURCE_REF_NORMALIZE_ALG = 1`,
property test n(n(x)) === n(x) (7(q)); **m2** "fts_pending empty" flip
clause replaced by the one-final-chunk cap (a live store drains normally;
unbounded flip-tx drain was the RC-1 shape); **m3** both-missing/empty FTS
tables with live entries now take the rebuild re-arm (rev-7 fast path
recreated empty tables → keyword search empty forever), fast-path row
annotated; **m4** consistency check spelled out (maxima only; orphan sweep
detects below-max ghosts); **m5** detached-under-`auto` wording fixed —
`WikiSearchUnavailableError` occurs only on the init-failure path, not on
a completed re-attach open; **m6** `:550` propagation is two-hop via the
:668 catch (mechanism note; the pinned test asserts the two-hop path).
New acceptance pins: 7(n) (prefilter-outage vector-ranked results),
7(o) reworded to the pass-level heal skip, 7(p) unchanged, 7(q)
(normalize idempotency property test). Later rev-8 additions while applying
the plan pass: plan minor 1's count(*) equality check (M4/m4 addendum),
plan minor 2's re-arm-time watermark snapshot, plan minor 3's sync options
parameter, plan minor 4's openDeadline capture point, plan MAJOR 4
(`upsertGraph` sync contract + `fts_pending` indexes + 7(r)), plan MAJOR 5
(in-process VACUUM → reset watermarks; 7(k) leg), plan MAJOR 6
(corruption-class init failure → safe DROP+CREATE re-arm), plan MAJOR 7
(watermark fingerprint mechanism), spec minor m7's degrade-ordering audit
paragraph (arbitration section), m5's budget-bound wording fix (now
"budget + 2 × max chunk" everywhere), and m5's marker-loss recall wording
alignment. **Spec rev 8 = this revision.**
- **Tier-3 Opus delta passes w/ issue-271 takeaways attached** (2026-10-10,
 spec $1.29/26 turns + plan $1.74/37 turns, logs `opus-{spec,plan}-delta.log`;
 Kurt directed the takeaways report be presented to the dual cycle):
 verdicts **REQUEST CHANGES** on both — and the two passes CONVERGED on a
 real self-contradiction in rev 5's marker-loss re-arm (table row said
 "clear entries_fts contents", DDL note said "keep the table") whose
 keep-map-but-clear-map reading hits an `fts_rowid` collision chain that
 wedges the rebuild permanently (plan delta B1 worked the full failure
 chain). **Rev 6 settles it per the reviewers' fix: keep `fts_map` AND
 `entries_fts`, clear only `fts_pending`, windows become drain-shaped
 delete-then-insert per id, orphan sweep before the flip (hard-deletes while
 triggers were down — new test 7(g′)), detached re-attach keeps DROP+CREATE
 (map untrustworthy).** Also applied from the deltas: drain interface
 contract `drain({deadline, mode, ids})` with ids-first read-your-writes
 (the takeaways §3 lesson, which had manifested AGAIN — 5 typed-error call
 sites, 2 were pinned; all 5 now mapped: prefilter/blend degrade to empty,
 keyword-only fallbacks propagate, heal degrades WITHOUT stamping
 heal_checked_at); one-deadline-per-open restored (plan had per-turn
 re-budgeting); forced-chunk bound fixed to budget + 2× max chunk (m1);
 Acceptance-6 240 s figure corrected — the ≈123 s was the DRAIN rate, the
 normalize rate is unmeasured and a required @1M normalize measurement now
 precedes any gate-scale bound (M3); VACUUM guard extended to the normalize
 watermark + mechanism specified (M4); fresh-store transition keyed on
 entries-did-not-exist so pre-FTS stores rebuild (M5); downgrade-of-
 rebuilding note (m2); 255-char predicate gap closed (m3); watermark keys
 named + flip-tx deletion stated (m5). Takeaways §1/§2/§5/§8/§9 verified
 pre-satisfied by design; §4 (orphan sweep incl. tests) and §6 (VACUUM
 guard) incorporated as above; §7 telemetry deferred (no telemetry surface
 in this delivery). **Spec rev 6 = this revision.**
- **Tier-3 Opus delta cycle #4 (2026-10-10, spec 0 BLOCKER/5 MAJOR/9 minor
  + plan 0 BLOCKER/5 MAJOR/10 minor; logs `opus-{spec,plan}-delta4.log`,
  $1.6426 + $2.2189; both reviews REQUEST CHANGES; all key source claims
  independently verified against the worktree before adoption). Spec
  findings applied in this rev 9:** **M1** rev 8's prefilter fall-through
  (`RetrievalService.ts:189`) swapped "empty results" for the unbounded
  full-scan embedding load (`findWithEmbeddingsByEntityIds` has no LIMIT,
  `EntryRepository.ts:1524-1532` — the read-path OOM class) ⇒ REVERSED to
  propagate (today's two-hop path: caught at :668, `onRetrievalFallback`
  fires, :719 throws); 7(n) rewritten (two-hop + fallback event, NO
  full-scan leg); **M2** the v14 normalize left `source_ref_index.source_ref`
  (the second stored copy) un-normalized — re-ingest then breaks C2/ingest
  via `WikiSourceRefHashCollision` or a partial-UNIQUE collision ⇒ SECOND
  watermarked rowid pass over `source_ref_index` (two watermarks
  `normalize_v14_entries_wm`/`normalize_v14_sri_wm`, one stamp written only
  after both passes), write-path audit names both tables, new test 7(s);
  **M3** the entity-targeted drain contract could not satisfy 7(r) under a
  1M single-entity backlog ⇒ `upsertGraph` stashes `params.nodes[].id` and
  threads them as `ids` into the next `syncSearchIndex(entityId)`, and the
  write-turn budget is concrete: own ids + at most ONE ledger chunk (≤500
  rows); **M4** Change 4 + 7(e) still carried rev-7 degrade wording that
  rev 8 overturned ⇒ rewritten to match the call-site map exactly (heal =
  pass-level skip; gate = pass-level abort + exact-text `noop` defense in
  depth); the map is declared the single source of truth; **M5** the
  watermark fingerprint was undefined for gap-bounded windows and
  prune-deleted fingerprint rows (restart = livelock) ⇒ `drainHiSql`-style
  `hi` = max(rowid) over the next ≤500 existing rows, fingerprint at that
  row, RE-LOCATE (not restart) on a missing fingerprint; the
  "VACUUM preserves rowid order" claim withdrawn (SQLite docs: rowids MAY
  change — the design never assumes order). Minors applied: m1 the
  consistency count compares `entries_fts_docsize` vs the `fts_map` count
  as a READ-ONLY probe BEFORE the re-arm tx; m2 the "rowid > ? LIMIT n
  cannot seek" rationale corrected (FTS5 full scans honour rowid bounds,
  `FTS5_STMT_SCAN_ASC`) — the `fts_map` walk kept; m3 the corruption
  classifier scoped to `SQLITE_CORRUPT_VTAB` / FTS-table-only statements
  (generic `SQLITE_CORRUPT` from `entries` pages must not DROP+CREATE); m4
  "live + entries non-empty + empty `fts_map` ⇒ DROP+CREATE" now requires
  `fts_pending` empty too (fresh bulk-write crash must not rebuild); m5 the
  two `fts_pending` CREATE INDEX statements declared and budgeted alongside
  the partial index; m6 partial recall during `rebuilding` feeding internal
  consumers stated as an ACCEPTED risk (bounded by the completion flip); m7
  the 4.82 s baseline labeled COLD; m8 `createIndexStrategy.test.ts:69,89`
  declared REWRITTEN; m9 :223 wording = "add a local catch → empty keyword
  scores map" (no local catch exists today). **Spec rev 9 = this
  revision.**