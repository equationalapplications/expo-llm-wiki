# Spec: `wiki.setup()` wall time — minimal viable open, converging index

**Date:** 2026-10-10
**Status:** Draft (rev 5 — Tier-3 Opus pass adjudicated; reviews: GLM `.sandbox/glm-spec-review-r{1..4}.md`, Opus `~/.hermes/cache/scratch/issue280/opus-spec-review.log`)
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
| 4 | RC-6 guard: failure-ordered init, retry, never demote, typed error | RC-6 |

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
  `rowid > ? AND rowid <= ?` windows — chunkable, tracked in meta key
  `source_ref_normalize_watermark`. Rows whose ref normalizes to NULL are
  written NULL (today's `updateSourceRefByRowid` behavior, kept deliberately).
- **Stamp lifecycle (atomic):** when a window scan finds watermark ≥
  max(rowid) (checked inside the final chunk's tx), that tx writes the stamp
  AND deletes the normalize watermark — one invariant, never a stale residue.
  Missing watermark ⇒ treated as 0. Stamp meta key:
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
  (with the watermark deletion — see lifecycle above). A partially-applied
  migration (some rows normalized, no stamp) is harmless to an older engine:
  the old every-open scan still runs and simply finds nothing (or finishes the
  job).
- **Downgrade/backup-restore:** an older engine ignores the stamp (it does not
  know the key); a newer engine re-validates via the algorithm id — a bump of
  `normalize_alg` forces exactly one re-scan.
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
deterministic OOM path (Change 4's stakes). While `detached` under `auto` —
before the rebuild's first quantum completes — keyword search is unavailable
(`WikiSearchUnavailableError` per query); on the **failure** path — the one
Change 4 governs — MiniSearch is **never** instantiated by `auto`. (The
unrelated module-absent path — `probeFts5` false — still falls back to
MiniSearch by design; see Change 4.) Switching back from a pinned-detached
store is the operator re-opening with `'fts5'` or `'auto'`.

**Transition table** (all transitions execute in ONE transaction — decide +
mutate + watermark + state together; the `fb-crash-resume` leg's discipline):

| From | Event | To | Actions in the transition tx |
|---|---|---|---|
| (absent) | fresh store, FTS chosen | `live` | create tables + triggers, stamp `live` |
| `live` | triggers all present | `live` | no-op fast path |
| `live` | **any trigger missing** (RC-3) | `rebuilding` | **re-create all triggers**, clear `fts_map`/`fts_pending` + `entries_fts` contents², watermark=0 — **the existing virtual table is kept** (see DDL note) |
| marker row **lost** (RC-3) | any | `rebuilding` | same as above |
| `rebuilding` | resume open | `rebuilding` | **verify `triggersPresent()`** — if any trigger was lost mid-rebuild, writes may have been missed ⇒ restart (watermark=0, same re-arm tx) |
| `rebuilding` | setup() quantum **or** no-arg `syncSearchIndex()` | `rebuilding` | advance watermark by ≤N chunk txs (below) |
| `rebuilding` | watermark ≥ max(entries.rowid) **and** `fts_pending` empty (both re-checked inside the final tx) | `live` | flip state in the final chunk's tx |
| `live`/`rebuilding` | explicit `indexStrategy: 'minisearch'` | `detached` | `detachFts5` (unchanged behavior, operator-chosen) |
| `detached` | open with `indexStrategy: 'fts5'` **or `'auto'`** | `rebuilding` | full rebuild path (incl. ledger-table re-creation — `fts5LedgerDropSql` removed them) — `auto`'s failure path never instantiates MiniSearch (NEW-1/R3-4) |

**DDL note (supersedes the earlier "DROP+CREATE floor"):** on marker-loss or
trigger-loss the existing `entries_fts` is **stale, not corrupt** — the rebuild
delete-then-inserts each rowid window **into the existing table** (the drain's
own shape), so there is **no DROP+CREATE and no 22.3 s @1M DDL floor** on this
path. Side benefit: old rows stay searchable while their windows have not yet
been re-done (recall shrinks instead of emptying). The DROP+CREATE is reserved
for the case where the table is actually wrong: tokenizer/DDL mismatch vs
`fts5TablesDdl` (detected by comparing the stored DDL). That case inherits the
old floor (22.3 s @1M, ~94 s linear at 4.2M — bounded in Acceptance 3/6).

**Rebuild-mechanics note (Opus B-1):** window inserts are **conflict-free by
construction**: the map insert is `INSERT INTO fts_map ... SELECT ... WHERE
rowid > ? AND rowid <= ? AND id NOT IN (SELECT id FROM fts_map)` (equivalently
`INSERT OR IGNORE`), and the `entries_fts` insert covers only the rows this
window actually mapped (keyed above `max(fts_rowid)` recorded before the map
insert). Re-doing a window after a crash is a no-op, not an error. Draining an
id ABOVE the watermark is allowed and normal (that id's later window skips it
via the NOT EXISTS guard). The `UNIQUE(id)` constraint rejects rather than
skips — no plain `INSERT ... SELECT` may target `fts_map` anywhere on the
rebuild path.

**Old-content window note:** windows not yet re-done still hold pre-rebuild
rows for ids that have since been deleted or updated; the ledger drain of those
ids (delete-then-insert per `drainChunkSql`) already corrects them.

² The one remaining DROP+CREATE case (tokenizer/DDL mismatch) is single-statement
DDL and unchunkable: measured 22.3 s @1M (investigation §2.2, V3 bucket) —
declared, bounded in Acceptance 3, excluded from the steady-state fence claim
(Acceptance 4). RC-3's *prevention* half: init writes state+triggers
atomically in one tx; this spec retains that invariant so a *cleanly crashed*
open never loses the marker (crash ⇒ `rebuilding` resumes; only external
corruption/manual deletion reaches marker-loss paths, which no longer pay the
DDL floor).

**Chunked rebuild mechanics:** rowid **windows** of ≤500 entries-rows per
transaction (`SELECT ... WHERE rowid > ? AND rowid <= ?` — rowid windows may
contain fewer rows when deletes left gaps; throughput legs measured row-dense
stores). Each chunk tx commits its inserts + the watermark advance atomically.
Exactly-once under resume verified at 1M (`fb-crash-resume` leg: SIGKILL at
400k/1M mid-rebuild, resume completed 600k in 78.9 s, 1,000,000 map rows,
0 duplicates) — single-writer case; the concurrent-writer shape is covered by
the conflict-free insert construction above plus Acceptance 7(a).

**Concurrent writers during `rebuilding`:** entry triggers (re-created by
every transition into `rebuilding`) keep appending to `fts_pending` while the
watermark advances; a row written mid-rebuild can be present in both the
rebuild range and the ledger. The conflict-free window inserts make that
harmless. Completion condition: **watermark ≥ max(rowid) AND ledger empty,
both re-checked inside the flipping transaction**, with the ledger drained
*before* the `live` flip. **Acceptance 7(a) includes the specific
drain-before-window case:** update a row ABOVE the watermark, drain, then let
that row's window run — no duplicate, no stall.

**Budget semantics (Opus M-1/M-3/M-4 — write path split):** the quantum is
bounded by `setupBudgetMs` (default **1500**), checked **between** chunk
transactions, worst-case wall = budget + max chunk. **One deadline per open**:
the migration normalize (when it runs) and the post-migration `sync()` share
a single deadline measured from open start (no 2× stacking). **Which entry
point does what:**
- `setup()` — full quantum: normalize (migration open), ledger drain, rebuild
  chunks. This is the convergence workhorse.
- no-arg `syncSearchIndex()` (→ `sync()` → `drainTurn`) — full quantum.
- **write-triggered turns (`syncEntries` after ingest/forget/supersede/import,
  and per-entity `sync(id)`) — LEDGER DRAIN ONLY**, bounded: they never run
  rebuild chunks (a write during `rebuilding` must not pay ~2.5 s) and they
  **drain to completion of their own ids first** — the drain ordering within a
  write-triggered turn is the caller's own ids (newest seq window), then the
  remainder if budget allows, so read-your-writes holds for the write that
  triggered the turn (Opus M-4: the ledger drains oldest-first; a fresh write
  behind a 1M backlog must not wait ~80 quanta).
- Arbitration within a rebuild quantum: ledger drain first, then rebuild
  chunks with the remainder — with the drain-before-window case above
  constructively harmless.
- At least one rebuild chunk per rebuild-quantum (forward progress under
  sustained ledger load; starvation risk noted and accepted — the ledger also
  converges, so the rebuild never starves permanently).
- The migration's *unchunkable* pieces (CREATE INDEX build) remain declared
  one-time costs in Acceptance 6. Note (Opus MIN-5): at 4.2M, FTS5 automatic
  segment merges can stretch a single chunk commit; Acceptance 6 records the
  observed max chunk time at gate scale.

**Convergence vehicle — open-driven, with a safe write path.** There is no
background-tick mechanism in the engine today (`drains run inside sync()`,
`SearchService.ts:96-116`), and this spec does not add one. Convergence
happens in `setup()` and in no-arg `syncSearchIndex()`; writes converge only
their own ids and stay fast. **Host contract:** a long-lived process that
neither re-opens nor calls no-arg `syncSearchIndex()` holds a
partially-recalled index indefinitely — SynapseTree must call
`syncSearchIndex()` on a schedule it owns (sign-off recorded in the review log
at implementation). Recall during `rebuilding` is **partial, by design, and
the only mode** — there is no strict-recall alternative (the previously
drafted `searchConsistency: 'strict'` LIKE-fallback is cut: no SQL LIKE path
exists in the engine, and a `%q%` body scan would relocate the fence problem
into every query). Mid-drain recall verified (`profile-fb-prototype.ts`);
with the DDL-note change, recall during marker-loss rebuild starts at
"previous index, possibly stale" instead of empty.

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
  no-op that leaves the ledger intact** (write paths keep working and
  converging later; no warning spam per write). **Internal-caller behavior
  (Opus M-7), decided:** the maintenance heal path
  (`MaintenanceService.ts:1542`) catches `WikiSearchUnavailableError` and
  treats it as "no heal anchors available" (degrade, don't abort); the
  retrieval keyword fallback (`RetrievalService.ts:550`) propagates the error
  to the caller (explicit degraded signal, not silent empty results); both
  pinned by tests. Additionally, **no-arg `syncSearchIndex()` retries
  `init()`** — a long-lived host that never re-opens still recovers.
- Detach + MiniSearch fallback remains available **only** via explicit
  `indexStrategy: 'minisearch'` (operator's deliberate choice). Even that path
  carries the measured memory ceiling: the MiniSearch full sync OOM-killed a
  default Node heap at **1M entries** — operators of pro-scale stores need a
  raised `--max-old-space-size`, documented next to the option.
- `probeFts5` failure (module genuinely absent) still falls back to MiniSearch:
  that case is permanent, not transient. Its memory ceiling is the same
  documented one.

## Write-path invariant audit (precondition for the Change-1 stamp)

The stamp asserts "all stored source_refs are normalized as of algorithm N".
That is sound only if every write surface normalizes. Audited surfaces
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

1. **Warm open @1M:** setup() ≤ 1 s warm / ≤ 3 s cold (today: 1.74 s warm, of
   which 1.73 s is RC-2 scans; post-fix predicted ~0.01 s for the scan pair).
2. **Converged rebuild open @1M** (`rebuilding`, watermark advanced by prior
   opens): setup() returns within budget + max chunk (≤ 2.6 s @1M defaults).
3. **Marker-loss path @1M:** first open completes the re-arm tx + ≥1 quantum
   and returns; the common marker-loss path has **no DDL floor** (existing
   table kept — see the DDL note). The tokenizer-mismatch case keeps the
   measured 22.3 s @1M floor as its accepted bound (explicitly outside the
   steady-state fence claim — see 4). Convergence thereafter per 2. Tests:
   delete the meta row + one trigger on a built store (common path); corrupt
   the stored tokenizer DDL (floor path).
4. **Steady-state fence (the gate claim):** every open of a `live` store —
   warm, cold, and post-crash-resume — completes inside 15 s at 4.7 GB NVMe
   (measured re-run, criterion 6). Marker-loss/first-migration opens are
   excluded from this claim and bounded by 3 and 6 respectively.
5. **Crash backlog @1M:** 1M undrained ledger rows add at most
   budget + max chunk to any single open (measured shape: 7.6k rows/s in
   ≤1.01 s chunks), converging across opens instead of the current
   single-open drain (≈123 s per 1M undrained rows, [C] derived).
6. **Gate-scale re-measure (required):** the ~4.7 GB NVMe store re-measured
   before/after on this machine (`profile-setup.ts`; legs ~30–45 min each).
   Includes the foreign-store first-open shape (`setupDatabase` DDL incl.
   repeated CREATE INDEX + normalize + first quantum). Derived target [C]:
   `setupDatabase` component ≈ 69 s (16.5 s @1M × 4.2, linear) + first
   quantum ≤ 2.6 s ⇒ **≤ 120 s** for a store with normalized refs; a store
   carrying a full un-normalized backlog adds the ≈123 s normalize term
   (chunked, single deadline shared with the post-migration sync) ⇒
   **≤ 240 s**. Per-tx windows stay fence-tolerable throughout; the largest
   observed chunk commit time at gate scale is recorded here (FTS5 automatic
   segment merges can stretch it — Opus MIN-5); steady-state per 4.
7. **New tests:** (a) concurrent-writer rebuild exactly-once — triggers
   appending while the watermark advances, completion condition per Change 3,
   **including the drain-before-window case** (update a row above the
   watermark, drain, then its window runs: no duplicate, no stall);
   (b) fresh-store fast path writes v14 stamp + partial index (GAP-3);
   (c) downgrade/backup-restore stamp invalidation forces exactly one rescan
   (GAP-3); (d) stamp-missing self-heal (Change 1); (e) RC-6: forced init
   failure ×2 on a healthy 1M store — no `detachFts5` call (spy), state not
   `detached`, `WikiSearchUnavailableError` thrown per query, next open
   recovers; **heal degrades, retrieval keyword fallback propagates; write
   during unavailability succeeds and its ledger rows survive** (Opus M-7);
   (f) `detached` store semantics: under pinned `indexStrategy: 'minisearch'`
   the store stays detached; under `'auto'` (the default) it re-attaches —
   enters `rebuilding` and converges (per Change 3's transition table);
   (g) marker-loss transition produces the defined re-arm + rebuild sequence,
   **triggers verified present after the transition and after mid-rebuild
   resume** (GAP-5/CRIT-1/Opus B-2); (h) `EXPLAIN QUERY PLAN` asserts the
   partial index serves the legacy probe; (i) budget arbitration order (drain
   before rebuild within a quantum) **+ write-triggered turns stay
   drain-only** (a write during `rebuilding` never runs rebuild chunks);
   (j) watermark resume exactly-once (the leg harness promoted to an
   integration test); (k) **VACUUM guard:** a post-VACUUM open detects the
   invalid rebuild watermark and restarts the rebuild (Opus M-6); (l) migration
   normalize **runs to completion regardless of the time budget** (small
   budget, all refs still normalized; budget affects only the post-migration
   sync).
8. Existing test suite green.

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
