# Investigation: `wiki.setup()` wall time at pro scale (issue #280)

**Status:** Investigation (Step 0 of delivery flow) — revision 2 after GLM 5.3 critique round 1
**Date:** 2026-10-09/10
**Issue:** equationalapplications/expo-llm-wiki#280
**Engine version:** 7.11.2 (`ea6e4ff`)
**Method:** source reading + sandbox measurement, better-sqlite3 13.0.3, Node 26, x86-64 NVMe ThinkPad. ARM64/Fargate gate numbers (SynapseTree run 7, engine 7.11.0) are external cross-checks only — always [C] here.
**Revision-2 note:** rev 1's exponent claims and "warm ≈8 s at pro scale" extrapolation were wrong; corrected below per GLM review. Storage backend matters more than expected: tmpfs numbers were 2–3× optimistic vs NVMe; headline numbers below are NVMe.

---

## 1. What `setup()` actually does (verified from source, [V])

`WikiMemory.setup()` (`packages/core/src/WikiMemory.ts:259-321`) runs, in order:

| # | Phase | Source | Measured cost @1M entries (warm) | Measured @1M (first-open) |
|---|-------|--------|----------------------------------|-------------------------------|
| 1 | `tableExists(entries)` | WikiMemory.ts:260 | ~0 | ~0 |
| 2 | `setupDatabase` DDL no-ops + `PRAGMA table_info` shim | db/schema.ts:3 | ~0 (1.4 ms) | 16.5 s on foreign store (CREATE INDEX ×N on 1M rows) [V] |
| 3 | schema-version read/derive | WikiMemory.ts:264-280 | ~0 | ~0 |
| 4 | pending migrations | WikiMemory.ts:282-288 | zero (v13 current) | runs full 1→13 ladder (inside the DDL bucket above) |
| 5 | `assertNoLegacySourceTypes` scan | WikiMemory.ts:298; EntryRepository.ts:1211 | 0.60 s (34.7%) [V] | 0.62 s |
| 6 | `findRowsForSourceRefMigration` GLOB scan + JS normalize | WikiMemory.ts:301-309; EntryRepository.ts:1242 | **1.13 s (65.1%)** [V] | 1.14 s |
| 7 | `createIndexStrategy` → FTS5 `init()` | createIndexStrategy.ts; Fts5IndexStrategy.ts:23-38 | ~0 fast path [V] | **52.6 s** single-INSERT rebuild + (marker-lost only) 22.3 s DROP/CREATE virtual table [V] |
| 8 | `searchService.sync()` → drain | SearchService.ts:102-116 | 0.2 ms | ~0 (ledger empty after rebuild) |

**Warm-open cost is ~100% the two survival scans (phases 5+6).** [V — per-SQL instrumentation, `.sandbox/profile-phases.ts`]

## 2. Measurements ([V] unless marked [C])

### 2.1 Whole-`setup()` scaling

| entries | raw store | V1 first-open | V2 warm | V3 marker-lost | backend |
|---:|---:|---:|---:|---:|---|
| 50,000 | 55.7 MB | 1.86 s | 0.08 s | 1.65 s | tmpfs† |
| 200,000 | 223 MB | 8.34 s | 0.33 s | 7.53 s | tmpfs† |
| 500,000 | 558 MB | 22.50 s | 0.92 s | 24.05 s | tmpfs† |
| 1,000,000 | 1.12 GB | 47.15 s | 2.54 s | — (crashed, /tmp full) | tmpfs |
| 50,000 | 55.7 MB | 6.66 s | 0.09 s | 4.67 s | NVMe |
| 200,000 | 223 MB | 16.71 s | 0.51 s | 12.22 s | NVMe |
| 500,000 | 558 MB | 50.31 s | 1.98 s | 97.65 s | NVMe |
| 1,000,000 | 1.12 GB | 108.3 s | 4.82 s | 165.4 s | NVMe |
| 1,000,000 (phases harness) | 1.12 GB | 117.6 s | 1.74 s | 209.4 s | NVMe |

† tmpfs rows underestimate real-disk cost: at 1M, tmpfs V1 = 47.2 s vs NVMe 108.3 s (2.3×). Capacity planning uses NVMe rows only.

**NVMe warm-open (V2) fits exponent ≈1.3 on entries** (0.09 → 0.51 → 1.98 → ~3 s warm-cache series). The gate's pro store holds ~4.2M entries ⇒ naive extrapolation **~30 s warm-cache, ~50 s+ cold — several times the 15 s fence**, consistent with the per-phase finding that warm open is 100% sequential scans (linear I/O + per-row JS with a growing constant). V1/V3 grow at least as fast (V3: 4.67 → 12.22 → 97.65 → 165 s).

V3 marker-lost @1.1 GB local = 165–209 s; ×~3.8 architecture/storage penalty ≈ **the gate's 693 s @4.7 GB**. Strong hint the gate's pro leg was a rebuild/marker-lost path, not a warm open. [C — gate store state not retrievable]

### 2.2 Phase attribution @1M NVMe (per-SQL buckets) — [V]

- **V2 warm (1.74 s): glob_scan 1.13 s (65%) + legacy_types_scan 0.60 s (35%) = 99.8%.** Everything else ≤1.4 ms.
- V1 first-open (117.6 s): FTS rebuild INSERT 52.6 s (44.8%), migration DDL 16.5 s (14%), tx_overhead 98.4 s (83.7% — rebuild runs in one transaction, commit/fsync included).
- V3 marker-lost (209.4 s): rebuild INSERT 114.7 s + DROP/CREATE virtual table 22.3 s; 99.2% inside one transaction.

### 2.3 Cold-cache caveat [V]

First 1M V2 measured 4.82 s vs 1.74 s on the same store — cold page cache ≈ 2.8× penalty on the scan-heavy path. Fence budgets must use the cold number.

### 2.4 Extrapolation to the gate's pro leg [C]

- Warm open: 1.74 s warm-cache / ~4.8 s cold @1.1 GB ⇒ naive-linear to 4.7 GB: ~7.5 s / ~21 s — **cold warm-open already breaches a 15 s fence before any ARM64 penalty**; scans are pure sequential-read + per-row JS, so a 2–3× architecture penalty is plausible ⇒ 15–60 s.
- Rebuild path: 165–209 s @1.1 GB ⇒ ~3 min @4.7 GB local; ×3.8 ≈ 693 s. Matches the gate if the pro store was marker-lost or foreign.

## 3. Root causes (revised)

**RC-1 [V] — FTS rebuild is a single unbounded transaction.**
`Fts5IndexStrategy.init()` (Fts5IndexStrategy.ts:31-37) rebuilds the whole index in one `withTransactionAsync` when state ≠ live-with-triggers. @1M: 114 s INSERT + up to 22 s DDL in one tx (rollback window = whole rebuild). No resume, no progress, no partial availability.

**RC-2 [V — ELEVATED to fence-critical per GLM r1] — the two survival scans run on every open, forever.**
`findRowsForSourceRefMigration` (GLOB, unindexable) + `assertNoLegacySourceTypes` (unindexed `IN` scan) = 100% of warm-open cost; linear in entries; ×cold-cache and ×architecture penalties. At pro scale this alone plausibly breaches the 15 s fence. Both are pre-version survival checks — on a `schema_version=13` store the writer already guarantees the invariants, so per-open re-verification is redundant work.
**Partial-index discriminator [V — Opus-requested leg, `.sandbox/profile-partial-index.ts`]:** the planner DOES use covering partial indexes for both scans (glob 1181 ms → 11.3 ms, legacy → 0.4 ms @1M), **but** the source_ref violation-predicate index costs 13× on writes (10k inserts: 457 → 6099 ms — TRIM/INSTR/GLOB re-evaluated per insert). Verdict: partial index **disqualified for source_ref** (write-heavy engine), **viable for source_type** (plain string equality, near-free per insert, preserves the fail-closed throw). F-A design settles: legacy check = partial index (detection kept, cost ~0); source_ref normalize = v14 one-shot migration + version-qualified stamp/skip.

**RC-3 [V] — marker semantics are binary and brittle.**
`fts5_index_state ∈ {live, detached}`; any trigger loss or lost meta row demotes a healthy multi-GB index to RC-1's full rebuild. No `rebuilding`/resumable state exists.

**RC-4 [V — WAL legs complete] — crash-recovery ledger backlog drains synchronously inside the next `setup()`.**
A killed process leaves committed-but-undrained rows in `fts_pending`; the next open's drain loop (SearchService.ts:102-116, Fts5IndexStrategy.ts:44-56) replays the whole backlog chunk-by-chunk **inside setup(), before returning** — measured: 1M-row backlog = ~85 s added to open (≈ the F-B prototype's 8.1k rows/s drain throughput). This is a third fence-breaking face beyond RC-1/RC-2: any host that SIGKILLs a process (Fargate eviction, OOM-kill) hands the next open a backlog proportional to crash-time write volume.
**Pure WAL replay is exonerated [V]:** with triggers dropped pre-append (no backlog) and the fast path re-armed, a 1.26 GB orphaned WAL added no measurable cost over the checkpointed twin (5.85 s vs 11.84 s @2M entries — the delta is cold cache, not replay; SQLite replays lazily at first touch). **F-D demoted to docs-level.**

**RC-6 [V code — found in Opus pass] — FTS5-init-failure fallback detonates at pro scale.**
`createIndexStrategy.ts:60-72`: on `auto`, a transient init() failure (tx lock, DDL permission) calls `detachFts5` — **dropping the ledger** — and silently returns MiniSearch, whose global sync (`findMiniSearchRows` + `toIndexDoc`) reads all entry text into JS. At 4.2M entries: memory + wall-time breaker, plus permanent loss of drain state. Spec must scope a guard (bounded fallback, refuse `auto` degradation above a size threshold, or fail pinned-only).

**RC-7 [V code — found in Opus pass] — the normalize loop is its own unbounded transaction.**
WikiMemory.ts:302-309 wraps the per-row `updateSourceRefByRowid` awaits in ONE tx. Masked today (healthy stores have ~0 violating rows) but RC-1-shaped on a foreign store with millions of un-normalized refs — the v14 migration must batch this, or it inherits the same fence problem it's fixing.

**RC-5 [V code] — `fts_pending` drain throughput bounds crash recovery.**
Ledger drain is chunked (500 rows/tx) but not time-budgeted or resumable across opens; drain progress survives restart only implicitly (drained rows are deleted), so a huge backlog makes *every* open until completion fence-breaking.

## 4. Fix directions (revised per GLM r1)

- **F-A (elevated, fence-critical): version-qualified skip of the survival scans.**
  - `source_type` legacy check: pure `schema_version ≥ N` gate may suffice (invariant has a guaranteeing migration) — verify which migration last touched `source_type` semantics.
  - source_ref normalization: no guaranteeing migration exists ⇒ **v14 migration** performs the GLOB scan+normalize one final time, then stamps `source_refs_normalized` (with its schema_version + normalization-algorithm id) in `meta`; setup() skips when stamp version matches current. Idempotent stamp write; version mismatch (downgrade/backup-restore) ⇒ one rescan.
  - Expected warm-open win @1M: **1.74 s → ~0.01 s** (cold 4.8 s → ~0.01 s).
- **F-B: resumable, chunked rebuild via rowid-range watermark (per GLM: never materialize millions of ledger rows).**
  `state='rebuilding'` + `rebuild_watermark` meta; drain by rowid range in 500-row chunks across separate transactions; index partially queryable during drain; **`init()` must recognize `rebuilding` and resume, not restart**. Product decision: partial recall during rebuild vs dual-index window (2× index bytes at pro scale).
  **Prototype-validated [V]** (`.sandbox/profile-fb-prototype.ts`, 1M entries NVMe): 122.9 s total for 1M rows (8.1k rows/s — same ballpark as single-tx rebuild), **max chunk latency 733 ms** (vs one 200 s transaction), mid-drain FTS MATCH returned partial results correctly. Chunked rebuild is viable; the spec's open-time budget should drain N chunks or T milliseconds, not "everything".
  **Also answers RC-4/RC-5:** the same resumable drain applies to crash-recovery ledger backlogs — drain a bounded number of chunks per open, then return; subsequent opens (or a background timer) continue. This turns crash recovery from fence-breaking into converging.
- **F-E (framing choice, GLM-added): setup() as a resumable state machine surfaced to hosts.**
  F-B is one instance. The spec must explicitly choose: "open blocks until index ready" vs "minimal viable open, index converges in background" — same machinery, different host contract.
- **F-C (demoted): clean-shutdown integrity stamp.**
  COUNT(*) is O(N), cannot detect trigger loss (the actual RC-3 mode), and is absent after crashes — the common case. Belt-and-braces drift check at most; never the rebuild-need detector.
- **F-D (pending WAL leg): WAL policy.**
  Unconditional `wal_checkpoint(TRUNCATE)` on close taxes every user for a rare host misconfiguration — likely docs-level; if replay proves pathological, the engine answer is open-time policy, not close-time.

## 5. Open questions

1. ~~NVMe backfill of 50k/200k/500k~~ — done, §2.1; exponent ≈1.3 on warm-open confirmed.
2. Does the writer guarantee no un-normalized source_refs post-migration (writer-side invariant)? Decides F-A's stamp-vs-gate for source_ref.
3. Partial recall during F-B rebuild acceptable for SynapseTree's use, or must the old index stay authoritative until swap? (Prototype shows partial recall works mechanically.)
4. ~~WAL leg~~ — complete: pure WAL replay exonerated (RC-4 note); F-D demoted to docs-level. The WAL legs' real yield was RC-4 (crash backlog) + a free @2M warm-open point (5.85 s).
5. Acceptance gate: re-measure at ~4.7 GB synthetic NVMe, V2 warm cold + V3 rebuild, before/after.
6. Open-time budget for the resumable drain (F-B + crash recovery): how many chunks/ms per open before setup() returns? Needs SynapseTree's fence arithmetic (15 s TTL minus scans minus probe) to set the default.

## 6. Review log

- **GLM 5.3 round 1** (2026-10-10, deleg_af42d1ea): verdict — evidence supports code claims; doc was stale vs its own log; exponent overstated (its own data gave ~1.08 on tmpfs points); **flagged V2 warm-open growth as the dangerous trend → priority inversion (scans are fence-critical)**; demanded per-phase instrumentation (delivered §2.2 — confirms scans = 100% of warm open) and a WAL leg (delivered §3 RC-4 — crash backlog is a third fence-breaking face); corrected F-B (rowid-range enqueue, `rebuilding` resume state); demoted F-C; added F-E. All accepted.
- **Sandbox legs delivered since r1** (2026-10-10): NVMe backfill §2.1 (exponent ≈1.3); F-B prototype §4 (validated, 8.1k rows/s, 733 ms max chunk, partial recall works); WAL legs → RC-4/RC-5 (crash backlog = ~85 s per 1M undrained rows, drains inside setup()), pure WAL replay exonerated (F-D docs-level), bonus @2M warm point 5.85 s.
- **Opus pass** (2026-10-10, deleg_5f9dda95): spec-worthy, conditional on the partial-index leg (run — result above settles F-A's mechanism). Found RC-6 (MiniSearch fallback hazard) + RC-7 (normalize loop = unbounded tx). Requests: minisearch-fallback-cost leg (medium — scopes RC-6 guard) and fb-crash-resume leg (medium — proves F-B's load-bearing watermark-resume claim); both can run during spec drafting and land as scoped items. Recommends F-E framing = "minimal viable open, converging index" (15 s fence cannot tolerate block-until-ready at 4.7 GB regardless of chunking); DROP-vs-upsert on marker-loss must be decided explicitly; open questions 3+6 to be presented as chosen default + config knob, not blockers. **Step 0 CONVERGED — proceeding to spec.**
- **Leg: minisearch-fallback-cost** (2026-10-10, `.sandbox/leg-minisearch-fallback-cost.log`): real 'auto' fallback machinery on a healthy 2.6 GB / 1M store, init() forced to throw. A. baseline warm open **5.91 s**, state stays live. B. fallback: `detachFts5` **committed the demotion before the crash** — post-mortem shows `state='detached'`, `fts_pending`/`fts_map`/`entries_fts` **all dropped, 0 triggers** — then the MiniSearch full sync ran Node out of heap: **OOM at ~202 s, 1.83 GB, exit 134** on default heap. RC-6 upgraded from hazard to **data-destroying crash path**: a transient init error permanently destroys the incremental index (recovery = RC-2's 108–209 s single-tx rebuild) AND kills the process at pro scale. The Change-4 guard (retry, never demote, typed error) is mandatory, not defensive.
- **Leg: fb-crash-resume** (2026-10-10, `.sandbox/leg-fb-crash-resume.log`): SIGKILL mid-rebuild at 40% (400k/1M rows) on the 1M store. Post-crash: `state='rebuilding'`, watermark=400000, fts_map=400000 (≤ watermark holds). Resume from watermark: 600k remaining rows in **78.9 s** (7.6k rows/s, max chunk 1010 ms), then verification: **1,000,000 fts_map rows = 1,000,000 live entries, 0 duplicate ids — exactly-once, no skipped range**. F-B's load-bearing claim is proven: watermark-commit-inside-chunk-tx makes crash recovery exactly-once; Change 3's discipline is confirmed.

---

*Sandbox harnesses (git-excluded; will be copied into the PR branch): `.sandbox/profile-setup.ts`, `.sandbox/profile-phases.ts`, `.sandbox/profile-wal.ts`. Logs: `~/.hermes/cache/scratch/issue280/*.log` (24 h prune — evidence copied into branch before the PR opens).*
