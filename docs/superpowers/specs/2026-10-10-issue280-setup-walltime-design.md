# Spec: `wiki.setup()` wall time — minimal viable open, converging index

**Date:** 2026-10-10
**Status:** Draft
**Branch:** `spec/issue280-setup-walltime`
**Priority:** High — blocks the SynapseTree ARM64 gate (15 s writer-lease fence vs 693 s measured setup)

Fixes #280.

---

## Problem

`wiki.setup()` wall time scales super-linearly with store size because every open
repeats work that is only needed once per data-changing event:

| Store | setup() wall | Context |
|---|---|---|
| 50 MB | 5.1 s | reported in #280 |
| 4.7 GB | **693 s** | SynapseTree ARM64 gate: the writer-lease fence is 15 s, so setup holds/blocks the fence ~46× over |
| 1M entries (measured, NVMe, better-sqlite3) | 108–118 s first-open rebuild; 165–209 s marker-lost rebuild; ~1.7 s warm | investigation harnesses, all legs logged |

Investigation doc: `docs/superpowers/investigations/2026-10-10-issue280-setup-walltime-investigation.md`
(this branch). Root causes, all measured:

- **RC-1 — every-open survival scans.** The legacy `source_type` check
  (`assertNoLegacySourceTypes`, GLOB) and the `source_ref` normalization scan
  (`findRowsForSourceRefMigration` + per-row normalize) run on **every** open:
  0.60 s + 1.13 s @1M rows, exponent ≈1.3, extrapolating past ~30 s at gate
  scale (5.85 s @2M measured). Fence-critical.
- **RC-2 — rebuild paths are one giant transaction.** First open and
  marker-lost open rebuild the FTS index in a single tx (108–209 s @1M). The
  process is uninterruptible for that whole window; the writer lease cannot be
  honored.
- **RC-4/5 — crash backlog drains inside the next open.** After a crash,
  the `fts_pending` ledger survives WAL replay and the next `setup()` drains it
  in one go: ~85 s per 1M undrained rows, inside the open. (WAL replay itself is
  exonerated — pure replay overhead measured at noise level.)
- **RC-6 — FTS init failure silently demotes the store (measured: data-destroying crash path).** In
  `createIndexStrategy` (`packages/core/src/services/search/createIndexStrategy.ts:60-67`),
  an `init()` throw on `indexStrategy: 'auto'` logs a warning, **drops the
  ledger and FTS artifacts** (`detachFts5`), and falls back to MiniSearch.
  Measured (`.sandbox/leg-minisearch-fallback-cost.log`, healthy 2.6 GB / 1M
  store, forced transient failure): `detachFts5` commits the demotion
  (`state='detached'`, ledger/map/FTS table/triggers all dropped) and the
  MiniSearch full sync then **OOM-kills the process at ~202 s, 1.83 GB heap,
  exit 134** on a default Node heap. A transient failure (tx lock, DDL
  permission) permanently destroys the incremental index — recovery is
  RC-2's 108–209 s single-tx rebuild — and kills the host process at pro scale.
- **RC-7 — the normalize loop is itself an unbounded tx.**
  `WikiMemory.ts:302-309` normalizes every row in ONE transaction — same
  fence-critical shape as RC-2 even after RC-1's scans are made skippable.

**Quantified at gate scale:** 693 s measured = marker-lost rebuild path (RC-2
shape, ×~3.8 over 1M) + both survival scans (RC-1) + crash backlog (RC-4/5,
~4M undrained rows from the ARM64 crash farm). No single fix closes the gap;
all five workstreams below are required.

## Approach

Framing (converged with both Step-0 reviewers): **the fence cannot tolerate
block-until-ready at 4.7 GB regardless of chunk size.** The design goal is
therefore a **minimal viable open** — make every open O(state-change) instead
of O(database) — plus a **converging index**: background work that shrinks
incompleteness without ever holding the fence.

Five changes, each mapped to a root cause:

| # | Change | Fixes | Fence impact |
|---|---|---|---|
| 1 | `v14` stamped source_ref normalize (one-shot migration) | RC-1 (source_ref half) | every-open scan → skipped when stamp matches |
| 2 | Partial covering index for the legacy `source_type` check | RC-1 (source_type half) | scan 0.60 s @1M → near-zero; keeps fail-closed throw |
| 3 | Watermark chunked FTS rebuild + crash-backlog drain (state machine `live/rebuilding`) | RC-2, RC-4/5 | bounded per-open contribution; rebuild converges in background |
| 4 | RC-6 guard: transient init failure → retry, never demote | RC-6 | prevents silent demotion to the pro-scale breaker |
| 5 | RC-7: batched normalize inside the v14 migration | RC-7 | migration itself runs in bounded chunks |

### Change 1 — v14 stamped source_ref normalize

- New schema version 14. On open, if the stored schema version < 14: run the
  normalize in **bounded chunked transactions** (Change 5's batching), then
  write a **version-qualified stamp** meta key recording
  `(schema_version=14, code_normalize_version)`.
- Every subsequent open with a matching stamp **skips the scan entirely**
  (no GLOB, no `findRowsForSourceRefMigration`).
- The stamp is version-qualified: if a future code change alters
  `normalizeSourceRef` semantics, it bumps `code_normalize_version` and the
  migration re-runs once. New writes are normalized at the write path, so the
  stamp invariant ("all stored source_refs are normalized as of version N")
  is maintained, not re-derived.
- Migration runs inline during `setup()` when needed (one-time), chunked so
  each tx is fence-tolerable; a partially-applied migration resumes from its
  own watermark (same discipline as Change 3).

### Change 2 — partial covering index for the legacy check

- The legacy `source_type` check must keep its **fail-closed throw** when a
  legacy row exists (explicit converged decision — do not relax semantics).
- A **partial covering index**
  `CREATE INDEX ... ON entries(source_type) WHERE source_type IN (<legacy values>)`
  makes the every-open probe near-free (planner uses it for the violation
  predicate; verified `profile-partial-index.ts`).
- **Why partial index for source_type but not source_ref:** measured write
  overhead of the source_ref violation-predicate index is **13× on writes** —
  disqualified for the hot column; the legacy-source_type predicate is
  near-free because legacy values never occur on the write path post-migration.
- Index creation is part of the v14 migration (one-time, chunk-safe DDL) and
  `CREATE INDEX IF NOT EXISTS` on every open is a no-op guard.

### Change 3 — watermark chunked rebuild + drain (state machine)

- New FTS state machine: `fts5_index_state ∈ {live, rebuilding}` (meta key
  exists today; the `rebuilding` value becomes load-bearing).
- **Rebuild:** instead of one tx (today's `rebuildInTx`), rebuild proceeds in
  rowid-range chunks of `FTS5_DRAIN_CHUNK` (500) rows per transaction. Each
  chunk tx commits **its chunk's inserts and the watermark advance atomically**
  (watermark lives in the same meta table, written inside the chunk tx). Crash
  ⇒ resume from watermark; verified exactly-once by
  `.sandbox/leg-fb-crash-resume.ts` (no dup, no skip; PASS at smoke scale
  2k entries with SIGKILL mid-rebuild; 1M run in flight — result lands in the
  investigation review log).
- **Open path while `rebuilding`:** setup() performs a **bounded quantum**
  (time-boxed, target ≤ ~1–2 s of chunk work per open; config knob) and
  returns. Search during `rebuilding`: FTS results may be partial (recall
  converges); verified mid-drain recall works (`profile-fb-prototype.ts`).
  Hosts needing strict recall can set `searchConsistency: 'strict'` → FTS
  queries during `rebuilding` fall back to the LIKE path (already exists for
  MiniSearch mode). Partial recall is the **chosen default**, documented and
  configurable.
- **Crash backlog (RC-4/5):** the ledger drain already chunks
  (`drainChunkSql`); the change is to **budget it**: setup() drains at most the
  per-open quantum and leaves the rest to subsequent opens/background ticks.
  The ledger is order-preserving (seq), so budgeted draining converges.
- Chunk timing measured: max chunk 733 ms @1M (500-row chunks), 7–8k rows/s —
  per-open quantum stays comfortably inside the 15 s fence.

### Change 4 — RC-6 guard: never demote on transient failure

- Measured stakes (`minisearch-fallback-cost` leg): today's fallback path
  commits `detachFts5` (index artifacts permanently dropped) and then
  OOM-kills at ~202 s / 1.83 GB on the 1M store. The guard below is
  mandatory, not defensive.
- In `createIndexStrategy`, on `init()` failure with `auto`: **retry the init
  once after a short backoff** (transient tx-lock case). If it still fails,
  **do NOT call `detachFts5`** — keep `fts5_index_state` untouched (no
  artifacts dropped, no demotion committed) and surface a typed
  `WikiSearchUnavailableError` (search returns empty / host-visible degraded
  state) instead of MiniSearch full-sync. Keyword search degrades for one
  open; the index and its ledger survive for the next open's retry.
- Detach + MiniSearch fallback remains available **only** via explicit
  `indexStrategy: 'minisearch'` (operator's deliberate choice) — the
  measured fallback cost on the 1M store (`.sandbox/leg-minisearch-fallback-cost.log`)
  is the documented justification.
- `probeFts5` failure (module genuinely absent) still falls back to MiniSearch:
  that case is permanent, not transient, and MiniSearch is correct there at any
  size the host can actually run.

### Change 5 — batched normalize (subsumed by Change 1)

- The v14 migration performs the normalize in rowid-watermarked chunks
  (≤ `FTS5_DRAIN_CHUNK` rows per tx), resuming from its watermark. The
  every-open unbounded tx at `WikiMemory.ts:302-309` is deleted by Change 1's
  stamp skip; the migration path replaces it.

## Config surface

- `searchConsistency?: 'partial' | 'strict'` (default `'partial'`): FTS recall
  contract while `rebuilding` — partial results (default) vs LIKE fallback.
- `setupBudgetMs?: number` (default ~1500): max wall time setup() spends on
  rebuild/drain quanta before returning.
- `indexStrategy` keeps its existing shape; `'auto'` semantics change per
  Change 4 (never silently demotes).

## Acceptance

1. Warm open @1M entries: setup() ≤ 3 s (was 108–118 s first-open / 1.7 s warm
   with scans). Every-open scans eliminated by stamp + partial index
   (measured: 1.73 s scans → 0).
2. Marker-lost / rebuild path: setup() returns in ≤ 5 s @1M while the index
   converges in background chunks (measured full convergence 8.1k rows/s ⇒
   ~2 min @1M spread across opens/ticks, never blocking the fence).
3. Crash-backlog path: 1M undrained ledger rows no longer add ~85 s to
   setup(); drain is budgeted and converges across opens.
4. RC-6: forced init failure on a healthy 1M store does NOT drop the ledger
   and does NOT trigger a MiniSearch full sync; retry succeeds on second open.
5. **Gate-scale re-measure (required):** the ~4.7 GB NVMe store re-measured
   before/after on this machine (harness: `profile-setup.ts`; scale legs
   ~30–45 min each). Target: setup() wall ≤ 60 s worst-case first converging
   open, ≤ 15 s once converged — inside the writer-lease fence.
6. Existing test suite green; new tests for: stamp skip correctness (normalize
   version bump re-runs), watermark resume exactly-once (leg harness promoted
   to an integration test), budgeted drain convergence, RC-6 retry/no-demote,
   partial-index planner usage (`EXPLAIN QUERY PLAN` assertion).

## Out of scope

- Embedding/vector index warm-up costs (separate concern, not in the 693 s).
- Changing the writer-lease fence duration itself (SynapseTree-side).
- Sharding or partitioning the entries table.
- Multi-process concurrent setup coordination beyond today's tx locking.

## Review log (Step 0)

Converged 2026-10-10: GLM 5.3 round 1 (numeric-consistency findings fixed),
8 sandbox legs (all logged under `~/.hermes/cache/scratch/issue280/`, copies
traveling on this branch), Opus pass (RC-6/RC-7 found there; two medium legs
`minisearch-fallback-cost` + `fb-crash-resume` commissioned and executed —
results folded into Changes 3–4 and §Acceptance). Full verdicts: investigation
doc §6.
