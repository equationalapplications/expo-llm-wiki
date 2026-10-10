# Spec: `wiki.setup()` wall time — minimal viable open, converging index

**Date:** 2026-10-10
**Status:** Draft (rev 2 — GLM 5.3 r1 triage applied; review: `.sandbox/glm-spec-review-r1.md`)
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
| 1M entries, first open | 108.3–117.6 s (V1 rebuild) | investigation §2.2 (NVMe legs) |
| 1M entries, marker-lost | 165.4–209.4 s (V3) | investigation §2.2 |
| 1M entries, warm | 1.74 s (of which survival scans 1.73 s) | investigation §2.2/§2.3 |

Root causes use the **investigation §3 canonical numbering**:

- **RC-1 — rebuild paths are one giant transaction.** First open and marker-lost
  open rebuild the FTS index inside a single transaction (V1: the rebuild INSERT
  is 52.6 s of a 117.6 s open; V3: 99.2% of the open is one tx). The process is
  uninterruptible for that window; the writer lease cannot be honored.
- **RC-2 — every-open survival scans.** The legacy `source_type` check
  (`assertNoLegacySourceTypes` — an unindexed `IN` scan, `EntryRepository.ts:1215-1219`)
  and the `source_ref` normalization scan (`findRowsForSourceRefMigration` — GLOB,
  `EntryRepository.ts:1250`) run on **every** open: 0.60 s + 1.13 s @1M rows,
  exponent ≈1.3 on warm open; interpolating the measured 1M/2M points gives
  **16–30 s at 4.2M** (the spread reflects the 2M point sitting below the pure
  1.3 curve). Fence-critical either way.
- **RC-3 — brittle binary marker semantics.** FTS index health is a single meta
  row (`fts5_index_state`) plus three triggers; any marker loss or trigger loss
  demotes a healthy multi-GB index to a full RC-1 rebuild on the next open.
- **RC-4 — crash backlog drains inside the next open.** After a crash, the
  `fts_pending` ledger survives WAL replay and the next `setup()` drains it in
  one go: ~85 s per 1M undrained rows, inside the open. (Pure WAL replay is
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
16.5 s @1M migration DDL ladder) fits equally well. No additive breakdown is
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

- New schema version 14. The normalize runs once, in **rowid-watermarked
  chunks** (≤500 entries-rows per tx, same watermark discipline as Change 3),
  resuming from its watermark after a crash.
- **Skip condition is defined purely on stamp state**, never on
  `schema_version < 14`: if the stamp meta key
  `(source_ref_normalize_stamp = {schema_version: 14, normalize_alg: N})` is
  present and matches the current algorithm id, the scan is skipped. Missing or
  mismatched stamp ⇒ idempotent, chunked, budgeted re-normalize, then stamp.
  This makes `version=14, stamp missing` (crash between completion and stamp,
  or a fresh-store path bug) self-healing rather than a permanent rescan.
- **Fresh stores** (no `entries` table at first open) take the existing
  fast path that sets `schema_version = CURRENT` directly
  (`WikiMemory.ts:263-267`); that path MUST also write the v14 stamp and create
  the Change-2 partial index, so a fresh store never enters the migration.
- **Atomicity:** the stamp is written inside the final chunk's transaction
  (same discipline as Change 3's watermark). A partially-applied migration
  (some rows normalized, no stamp) is harmless to an older engine: the old
  every-open scan still runs and simply finds nothing (or finishes the job).
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
existing stores in the wild. A v14 open on a `detached` store stays detached
(the operator or a prior fallback chose it); switching back is an explicit
operator action (re-open with `indexStrategy: 'fts5'`, which re-runs init and
enters `rebuilding`). No automatic un-detach.

**Transition table** (all transitions execute in ONE transaction — decide +
mutate + watermark + state together; the `fb-crash-resume` leg's discipline):

| From | Event | To | Actions in the transition tx |
|---|---|---|---|
| (absent) | fresh store, FTS chosen | `live` | create tables + triggers, stamp `live` |
| `live` | triggers all present | `live` | no-op fast path |
| `live` | **any trigger missing** (RC-3) | `rebuilding` | DROP+CREATE `entries_fts`¹, clear `fts_map`/`fts_pending`, watermark=0 |
| marker row **lost** (RC-3) | any | `rebuilding` | same as above |
| `rebuilding` | open/setup quantum | `rebuilding` | advance watermark by ≤N chunk txs (below) |
| `rebuilding` | watermark ≥ max(entries.rowid) **and** `fts_pending` empty | `live` | flip state in the final chunk's tx |
| `live`/`rebuilding` | explicit `indexStrategy: 'minisearch'` | `detached` | `detachFts5` (unchanged behavior, operator-chosen) |
| `detached` | open with FTS chosen | `rebuilding` | full rebuild path |

¹ The DROP+CREATE of the virtual table is **single-statement DDL and
unchunkable**: measured 22.3 s @1M (investigation §2.2, V3 bucket). This is the
declared, accepted hard floor of the marker-loss path. Marker-loss is a
rare corruption-recovery event, not a steady state — the fence guarantee
(Acceptance 4) applies to steady-state opens, and Acceptance 3 bounds this path
separately. RC-3's *prevention* half: init already writes state+triggers
atomically in one tx; this spec retains that invariant so a *cleanly crashed*
open never loses the marker (crash ⇒ `rebuilding` resumes; only external
corruption/manual deletion reaches the DDL floor).

**Chunked rebuild mechanics:** rowid **windows** of ≤500 entries-rows per
transaction (`SELECT ... WHERE rowid > ? AND rowid <= ?` — rowid windows may
contain fewer rows when deletes left gaps; throughput legs measured row-dense
stores). Each chunk tx commits its inserts + the watermark advance atomically.
Exactly-once under resume verified at 1M (`fb-crash-resume` leg: SIGKILL at
400k/1M mid-rebuild, resume completed 600k in 78.9 s, 1,000,000 map rows,
0 duplicates).

**Concurrent writers during `rebuilding`:** entry triggers keep appending to
`fts_pending` while the watermark advances; a row written mid-rebuild can be
present in both the rebuild range and the ledger. Exactly-once therefore
requires the completion condition **watermark ≥ max(rowid) AND ledger
drained**, with the ledger drained (dedup via `fts_map UNIQUE(id)` insert
semantics) *before* the `live` flip. The resume leg validated the
single-writer case; **Acceptance 7(a) adds a concurrent-writer test** for this
condition.

**Budget semantics:** per open, `setupBudgetMs` (default **1500**, exact)
governs quantum work, checked **between** chunk transactions (mid-chunk abort
is impossible — a chunk is one tx), so worst-case quantum wall = budget + max
chunk (1500 + ~1010 ms @1M measured). **Arbitration order within a quantum:
(1) ledger drain first** (keeps recall of recent writes freshest), **(2)
rebuild chunks with the remainder.** The same budget governs the v14
migration's chunks; the migration's *unchunkable* pieces (CREATE INDEX build,
and the GLOB scan that feeds chunk boundaries) are declared one-time costs in
Acceptance 6.

**Convergence vehicle — open-driven only.** There is no background-tick
mechanism in the engine today (drains run inside `sync()`,
`SearchService.ts:96-116`), and this spec does not add one. Convergence
therefore happens on open and on `sync()` calls. **Host contract:** a
long-lived process that never re-opens and never calls `syncSearchIndex()`
holds a partially-recalled index indefinitely — SynapseTree must re-open or
call `syncSearchIndex()` on a schedule it owns (sign-off to be recorded in the
review log at implementation). Recall during `rebuilding` is **partial, by
design, and the only mode** — there is no strict-recall alternative (the
previously drafted `searchConsistency: 'strict'` LIKE-fallback is cut: no SQL
LIKE path exists in the engine, and a `%q%` body scan would relocate the fence
problem into every query). Mid-drain recall verified (`profile-fb-prototype.ts`).

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
  completes with keyword search **unavailable**, surfaced as a **thrown
  `WikiSearchUnavailableError` on each search call** — never a silent empty
  result; hosts see the degraded state explicitly and the next open retries.
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
  behavior); (b) `importDump` re-runs the chunked normalize when the dump
  originated from a store whose stamp is missing or older (dump header carries
  the stamp). Host-side raw SQL bypassing these surfaces is outside the
  engine's contract and documented as such.

## Config surface

- `setupBudgetMs?: number` (default **1500**): max wall time setup() spends on
  rebuild/drain/migration chunk work per open, checked between chunk txs.
- `indexStrategy` keeps its existing shape; `'auto'` semantics change per
  Change 4 (never silently demotes). No `searchConsistency` option ships.

## Acceptance

Cache state is stated per criterion (warm = page cache retained; the
investigation measured a 2.8× warm/cold swing, §2.3).

1. **Warm open @1M:** setup() ≤ 1 s warm / ≤ 3 s cold (today: 1.74 s warm, of
   which 1.73 s is RC-2 scans; post-fix predicted ~0.01 s for the scan pair).
2. **Converged rebuild open @1M** (`rebuilding`, watermark advanced by prior
   opens): setup() returns within budget + max chunk (≤ 2.6 s @1M defaults).
3. **Marker-loss path @1M:** first open completes the unchunkable DDL floor +
   ≥1 quantum and returns; the measured DDL floor 22.3 s @1M is the accepted
   bound (explicitly outside the steady-state fence claim — see 4).
   Convergence thereafter per 2. Test: delete the meta row + one trigger on a
   built store.
4. **Steady-state fence (the gate claim):** every open of a `live` store —
   warm, cold, and post-crash-resume — completes inside 15 s at 4.7 GB NVMe
   (measured re-run, criterion 6). Marker-loss and first-migration opens are
   excluded from this claim and bounded by 3 and 6 respectively.
5. **Crash backlog @1M:** 1M undrained ledger rows add at most
   budget + max chunk to any single open (measured shape: 7.6k rows/s in
   ≤1.01 s chunks), converging across opens instead of the current ~85 s.
6. **Gate-scale re-measure (required):** the ~4.7 GB NVMe store re-measured
   before/after on this machine (`profile-setup.ts`; legs ~30–45 min each).
   Includes the foreign-store first-open shape (migration DDL ladder + normalize
   + index build; 16.5 s @1M for the ladder component) — target: total
   first-open ≤ 120 s @4.7 GB with per-tx windows fence-tolerable; steady-state
   per 4.
7. **New tests:** (a) concurrent-writer rebuild exactly-once (GAP-2: triggers
   appending while the watermark advances, completion condition per Change 3);
   (b) fresh-store fast path writes v14 stamp + partial index (GAP-3);
   (c) downgrade/backup-restore stamp invalidation forces exactly one rescan
   (GAP-3); (d) stamp-missing self-heal (Change 1); (e) RC-6: forced init
   failure ×2 on a healthy 1M store — no `detachFts5` call (spy), state not
   `detached`, `WikiSearchUnavailableError` thrown per query, next open
   recovers; (f) `detached` store under v14 open stays detached (GAP-5);
   (g) marker-loss transition produces the defined DDL + rebuild sequence
   (GAP-5/CRIT-1); (h) `EXPLAIN QUERY PLAN` asserts the partial index serves
   the legacy probe; (i) budget arbitration order (drain before rebuild within
   a quantum); (j) watermark resume exactly-once (the leg harness promoted to
   an integration test).
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
