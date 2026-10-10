# Issue #280 `setup()` Wall Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** rev 4 — mirrors spec **rev 6** (`c8cac5d`: keep map+table re-arm, drain-shaped windows, orphan sweep, `drain({deadline, mode, ids})` contract, one-deadline-per-open). Supersedes rev 3 (which mirrored spec rev 5 — its Task 3 window SQL, DDL-note framing, and per-turn re-budgeting are retired).

**Goal:** Make every `wiki.setup()` open O(state-change) instead of O(database): skip the every-open survival scans (v14 stamp + partial index), replace the single-tx FTS rebuild with a watermark-chunked, budget-bounded converging rebuild, and make FTS init failures recoverable instead of index-destroying.

**Architecture:**
- **Survival scans (RC-2/RC-7):** `WikiMemory.setup()` replaces its two every-open scans with: (a) a fail-closed legacy `source_type` probe served by a new partial covering index, (b) a `source_ref` normalize that runs only when the `source_ref_normalize_stamp` meta key is missing/mismatched, in rowid-watermarked chunks **run to completion** in the migration open (NOT budget-deferred), stamping inside the final chunk's tx (stamp write + watermark deletion in one tx).
- **FTS state machine (RC-1/RC-3/RC-4/RC-5, spec rev 6):** `fts5_index_state` gains a load-bearing `rebuilding` value. `Fts5IndexStrategy.init()` never rebuilds in one tx. **Marker-loss/trigger-loss re-arm keeps BOTH `fts_map` AND `entries_fts` intact** (stale ≠ corrupt) — only `fts_pending` is cleared and the three triggers are re-created (`fts5TriggersDdl`) in the transition tx; watermark=0, state=`rebuilding`. Rebuild windows are **drain-shaped** (the `drainChunkSql` statement shape, keyed by rowid-window ids): delete FTS rows via the map → delete the map rows → insert map rows for live ids → insert FTS rows — **conflict-free by construction**; no DROP+CREATE, no 22.3 s DDL floor (that is reserved for tokenizer/DDL mismatch and the detached re-attach path). **Orphan sweep** (walk `fts_map` by `fts_rowid`, purge rows whose entry no longer exists) runs chunked BEFORE the `live` flip. Completion: **watermark ≥ max(entries.rowid) AND `fts_pending` empty AND orphan sweep complete**, all re-checked inside the flipping tx. The resume path **verifies `triggersPresent()`** — missing trigger ⇒ restart (writes may have been missed). **`drain(opts?: { deadline?, mode?: 'ledger'|'full', ids? })` is the specified interface**: full quanta (rebuild chunks allowed) run only in `setup()` and no-arg `syncSearchIndex()` → `syncStale()` → `drainTurn`; write-triggered turns (`syncEntries`, per-entity `sync(id)`) are **LEDGER DRAIN ONLY** with the caller's own `ids` drained FIRST (id-targeted chunk via `json_each` — read-your-writes under backlog). **One deadline per open**: `setup()` captures `openDeadline = start + budget` and threads it through the migration and the post-migration `sync({ deadline })` — no per-turn re-budgeting. Worst-case full-quantum wall = budget + 2 × max chunk (forced-final-chunk rule: at least one rebuild chunk per full quantum unless the drain overran the deadline).
- **RC-6 guard:** `createIndexStrategy` reorders `init()` failures into read-only-probes-first, one 250 ms retry, and NEVER calls `detachFts5` on the `auto` failure path — it returns an `UnavailableIndexStrategy` whose `search()` throws `WikiSearchUnavailableError` (new exported error class; `drain()` is a no-op that leaves the ledger intact). **All five `WikiSearchUnavailableError` call sites pinned** (rev 6, issue-271 takeaways §3 rule): `RetrievalService.ts:189` (prefilter) and `:223` (hybrid keyword boost) **caught → treated as empty keyword scores** (the vector path proceeds); `RetrievalService.ts:719` and `:550` **propagate**; `MaintenanceService.ts:1542` (heal anchors) **caught → "no heal anchors available" WITHOUT stamping `heal_checked_at`**. MiniSearch instantiation by `auto` happens only on the module-absent path (`probeFts5` false). Pinned `'minisearch'` keeps today's detach behavior; `'auto'` re-attaches detached stores (enters `rebuilding`).

**Tech Stack:** TypeScript 5.9 (strict), vitest, pnpm workspace, better-sqlite3 13.0.3 (SQLite FTS5), Node ≥24.

**Spec:** `docs/superpowers/specs/2026-10-10-issue280-setup-walltime-design.md` (**rev 6** — GLM r4 Approved, Opus full REQUEST-CHANGES adjudicated, Opus delta ×2 adjudicated incl. issue-271 takeaways; the spec is authoritative). Investigation: `docs/superpowers/investigations/2026-10-10-issue280-setup-walltime-investigation.md`. If plan and spec disagree, the spec wins: stop and report.

## Global Constraints

- **Branch/PR:** everything lands on `spec/issue280-setup-walltime` (PR #281, DRAFT until implementation completes). No new branches, no worktrees.
- **Commands** (from repo root):
  - One core test file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`
  - Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`
  - Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
  - Workspace build: `pnpm -r build`
- **Known local test-runner issue (from the 2026-09-22 plan, still assumed):** the full core suite on this ThinkPad can report vitest `Worker exited unexpectedly` fork-pool errors with zero assertion failures. Record the local baseline before Task 1; judge the full-suite gate as "no assertion failures, completed counts ≥ baseline plus new tests". **CI is the authoritative gate.** Single-file runs are reliable; for a red phase with many failures at once, re-run that file with `--pool=threads`.
- **Commit types:** `feat(core): …` (new capability), `fix(core): …` (behavior fix), `perf(core): …` (scan skip), `test(core): …`, `docs(spec): …`. **Never start a commit body line with `BREAKING CHANGE`** (semantic-release parses it as a footer and cuts a major). None of these changes are breaking: `setupBudgetMs` and the error class are additive; `'auto'` behavior changes are fixes to a measured crash path (documented in the spec, not a semver major).
- **Spec edits are appended as revisions** (rev 6, 7, …); existing revision entries are never rewritten. The Step-8 `**Status:**` flip to Implemented is its own commit ON this branch, only after every task below is done.
- **This plan file is gitignored** (`docs/superpowers/plans/`): commit with `git add -f`.
- **Merge is Kurt's call** (SOP gate); merge commits only, never squash.
- **Fence arithmetic to respect in every design decision:** per-open quantum wall = `setupBudgetMs` + max chunk tx (~1.01 s @1M measured); full quanta worst case = budget + 2 × max chunk ≈ 3.5 s @1M defaults (forced-final-chunk rule). Never introduce an unbounded loop, a full-table scan, or a non-`IF NOT EXISTS` DDL on the every-open path.
- **Measured constants you may rely on** (investigation §2): partial-index probe 0.4 ms; glob scan 1.13 s @1M; legacy scan 0.60 s @1M; rebuild chunk throughput 7.6–8.1k rows/s; max chunk 733–1010 ms @1M; DDL floor (DROP+CREATE virtual table @1M) 22.3 s; V1 ladder component 16.5 s @1M; crash-backlog drain ≈123 s per 1M undrained rows [C — derived]. **The normalize rate is UNMEASURED** — the @1M normalize measurement (Task 12) is a PREREQUISITE for any 4.7 GB first-migration bound (Opus delta M3).
- **MiniSearch must NOT implement `drain`** — `SearchService.syncStale()`/`drainTurn` guard on `if (this.indexStrategy.drain)`, so a drain-less MiniSearch makes full-quantum calls no-ops by construction. No task adds `drain` to `MiniSearchIndexStrategy`; Task 2 pins this with an assertion.

---

### Task 1: `WikiSearchUnavailableError` — the typed degraded-search signal

**Objective:** Hosts can catch a stable error class when keyword search is unavailable.

**Files:**
- Create: `packages/core/src/errors/WikiSearchUnavailableError.ts`
- Modify: `packages/core/src/index.ts` (add export)
- Test: `packages/core/__tests__/wikiSearchUnavailableError.test.ts`

- [ ] **Step 0 (before Task 1's first run): record the full-suite baseline** on the pre-task commit — files completed, tests completed, fork-error count — into this file (append under Global Constraints). The Task 11 gate compares against this number.
- [ ] **Step 1: Write failing test**

```typescript
import { WikiSearchUnavailableError } from '../src/errors/WikiSearchUnavailableError';
import * as pkg from '../src/index';

describe('WikiSearchUnavailableError', () => {
  it('is an Error with a stable name and cause chain', () => {
    const cause = new Error('lock timeout');
    const err = new WikiSearchUnavailableError('keyword search unavailable', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WikiSearchUnavailableError');
    expect(err.cause).toBe(cause);
  });
  it('is exported from the package root', () => {
    expect(pkg.WikiSearchUnavailableError).toBe(WikiSearchUnavailableError);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/wikiSearchUnavailableError.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement**

```typescript
// packages/core/src/errors/WikiSearchUnavailableError.ts
export class WikiSearchUnavailableError extends Error {
  constructor(message = 'Keyword search is temporarily unavailable', cause?: unknown) {
    super(message);
    this.name = 'WikiSearchUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
```

Add `export { WikiSearchUnavailableError } from './errors/WikiSearchUnavailableError';` to `packages/core/src/index.ts` (match the file's existing export style).
- [ ] **Step 4: Run to verify pass** (same command) → PASS. Then `pnpm --filter @equationalapplications/core-llm-wiki typecheck` → clean.
- [ ] **Step 5: Commit** — `feat(core): add WikiSearchUnavailableError for degraded keyword search`

---

### Task 2: Failure-ordered init + retry + never-demote + the five call sites

**Objective:** On `auto`, an `init()` failure retries once and never calls `detachFts5`; the caller gets an unavailable strategy whose search throws the typed error; **all five error call sites behave per the rev-6 map**.

**Files:**
- Modify: `packages/core/src/services/search/createIndexStrategy.ts:47-74` (the `createIndexStrategy` function)
- Create: `packages/core/src/services/search/UnavailableIndexStrategy.ts`
- Modify: `packages/core/src/services/RetrievalService.ts` (:189 prefilter + :223 `getKeywordScores` — **catch → empty keyword scores, vector path proceeds**; :550 and :719 — **propagate**, no change beyond pinned tests)
- Modify: `packages/core/src/services/MaintenanceService.ts` (:1542 area — heal catches `WikiSearchUnavailableError` → "no heal anchors available", and the degrade path must **NOT stamp `heal_checked_at`** for unchecked facts)
- Modify: `packages/core/src/WikiMemory.ts:685` (`syncSearchIndex()` — the **no-arg path retries `init()`** when the installed strategy is unavailable; the retry lives HERE, not in `SearchService`, which has no db/prefix/metadataRepo)
- Test: `packages/core/__tests__/createIndexStrategy.test.ts`, extend `packages/core/__tests__/searchParity.test.ts` (call-site behaviors)

**Design (fix these semantics now, they ripple):**
- `UnavailableIndexStrategy implements IndexStrategy`: `search()` throws `WikiSearchUnavailableError` (cause = the last init error); `replace`/`replaceEntity`/`replaceAll` are **no-ops** (entries remain the source of truth; the index converges on recovery); **`drain` is ABSENT** (a no-`drain` strategy makes `SearchService`'s `drainTurn` guard skip — the ledger stays intact and write paths keep working, with no warning spam per write). Naming: the class is `UnavailableIndexStrategy` (strategy-level, not FTS-specific).
- Retry = one re-call of the same init after `setTimeout` 250 ms. If the retry succeeds, return the real strategy. If it fails again, return `new UnavailableIndexStrategy(lastError)` — **`detachFts5` is not called anywhere on this path.** If state was already mutated to `rebuilding`, it stays `rebuilding` (recoverable, converging — the next open resumes from the watermark).
- **Call-site map (spec rev 6 — pin ALL FIVE with tests):**
  1. `RetrievalService.ts:189` (prefilter `searchKeyword`): catch `WikiSearchUnavailableError` → **empty prefilter results** (`candidateRows = null` path) — semantic reads proceed vector-only.
  2. `RetrievalService.ts:223` (`getKeywordScores` hybrid blend): catch → **empty/absent keyword scores**; vector ranking proceeds (weight < 1 must not take down semantic reads — Opus delta M1).
  3. `RetrievalService.ts:719` (keyword-only fallback): **propagates** (keyword-only reads genuinely have nothing to fall back to).
  4. `RetrievalService.ts:550` (embed-absent keyword fallback): **propagates** (unchanged rev-5 decision).
  5. `MaintenanceService.ts:1542` (heal anchors): catch → **"no heal anchors available"**, and `heal_checked_at` is **NOT written** for facts never checked (Opus delta m7).
- The no-arg `WikiMemory.syncSearchIndex()` retry: when the installed strategy is an `UnavailableIndexStrategy`, re-run `createIndexStrategy` (or `init()` on a fresh strategy instance); a long-lived host recovers without re-opening.
- The existing `probeFts5`-false fallback (module genuinely absent → `detachFts5` + MiniSearch) is UNCHANGED — but only reachable when the probe fails, never from the init-catch path.
- Pinned `'fts5'` failure still throws the raw error (`:65`), unchanged.

- [ ] **Step 1: Write failing tests** (**real better-sqlite3 adapter** — same fixture pattern as `fts5IndexStrategy.test.ts`; force `Fts5IndexStrategy.prototype.init` to throw via `vi.spyOn`):
  1. init throws twice → returned strategy is `UnavailableIndexStrategy`; store state (`fts5_index_state`) is untouched; `fts_map`/`fts_pending` still exist.
  2. `search()` on it throws `WikiSearchUnavailableError` with the init error as `cause`.
  3. init throws once then succeeds → real strategy returned.
  4. `preferred: 'fts5'` + failing init → raw throw propagates.
  5. **Hybrid outage (7n):** `weight < 1` read with a failing keyword strategy still returns vector-ranked results (pins :189/:223 degrade-to-empty).
  6. **Heal degrade does not stamp (7o):** heal with unavailable keyword search → returns no anchors AND `heal_checked_at` absent for unchecked facts.
  7. Keyword-only fallback (:719) propagates the error to the caller.
  8. **MiniSearch has no `drain`:** `expect((new MiniSearchIndexStrategy() as unknown as { drain?: unknown }).drain).toBeUndefined()` — pins the Global Constraint.
  9. No-arg `syncSearchIndex()` on an unavailable strategy retries init and recovers.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/createIndexStrategy.test.ts` → FAIL (today's code detaches + returns MiniSearch).
- [ ] **Step 3: Implement** the reordered `createIndexStrategy` per Design above.
- [ ] **Step 4: Run to verify pass** + `createIndexStrategy.test.ts` (its module-absent fallback cases are the actual regression guard here — `miniSearchFallback.test.ts` is the read-path fallback, not strategy selection), `miniSearchFallback.test.ts` still green. **Add test 10: reopen-recovers** — after a double-failure open, a second `new WikiMemory(...)` open on the same store succeeds with a working strategy and keyword search returns results (pins spec 7(e)'s "next open recovers").
- [ ] **Step 5: Commit** — `fix(core): auto init failure retries, never demotes, pins all five search-unavailable call sites (#280 RC-6)`

### Task 2b (folded into Task 5): `importDump` belt — already satisfied by existing code

Opus M3 (converging with spec MIN-7): `ImportExportService.ts:273-282` **already
normalizes every imported `source_ref`** (throwing on normalize-to-null), so an
imported dump can never violate the stamp invariant — spec rev 5 records belt
(b) as met by existing code. **No dump-header machinery. Task 5 instead adds
one regression test** pinning that normalization: plant a violating ref in a
dump JSON, import, assert the stored ref is normalized. (The earlier Task 2b
was redundant, based on the wrong signal — the dump's stamp describes its
SOURCE store, not the destination — and its red phase could not fail.)

---

### Task 3: `rebuilding` state + drain-shaped chunked rebuild + orphan sweep in `Fts5IndexStrategy`

**Objective:** Marker-loss/trigger-loss no longer rebuilds in one tx and pays **no DDL floor**; a resumable, conflict-free, drain-shaped chunked rebuild exists with an orphan sweep before the flip; the `drain({deadline, mode, ids})` contract is live.

**Files:**
- Modify: `packages/core/src/services/search/Fts5IndexStrategy.ts` (init state machine + rebuild/drain machinery; **delete `rebuildFromSource()`** — :40-42, no callers, and it contradicts "never rebuilds in one tx" — Opus m8)
- Modify: `packages/core/src/services/search/fts5Sql.ts` (new constants: `REBUILD_WATERMARK_KEY = 'fts5_rebuild_watermark'`, `rebuildWindowSql(p)` — the drain-shaped window statements below — and the orphan-sweep SQL; `drainChunkSql` gains the id-targeted `json_each` variant)
- Modify: `packages/core/src/services/search/IndexStrategy.ts` (:120-128 — rewrite the `drain` doc for `drain(opts?: { deadline?, mode?, ids? })`; both other strategies stay drain-less)
- Test: `packages/core/__tests__/fts5Rebuild.test.ts`

**Design (spec rev 6 is authoritative):**
- `init()` reads state (read-only) + `triggersPresent()` (read-only) + entries-table existence BEFORE any mutation. Cases:
  - `live` + all triggers → `fts5TablesDdl` no-op guard, return (fast path, unchanged).
  - `rebuilding` → **verify `triggersPresent()`**; any missing ⇒ restart (re-arm tx, watermark=0); else return (resume; `drain()` continues the rebuild).
  - marker lost OR any trigger missing (from `live`) → ONE re-arm tx: **run `fts5TriggersDdl`** (writes during rebuild MUST feed the ledger — Opus B-2), **KEEP `fts_map` AND `entries_fts` contents** (stale, not corrupt), **clear ONLY `fts_pending`** (`DELETE FROM fts_pending`), watermark = 0, state = `rebuilding`. **No DROP+CREATE, no 22.3 s DDL floor on this path** (spec rev 6 DDL note — settles the rev-5 self-contradiction; the keep-map reading is safe precisely because windows are drain-shaped delete-then-insert per id, so `fts_rowid` never re-collides with surviving `entries_fts` rows).
  - state `detached` → re-create ledger tables (`fts5LedgerDropSql` dropped `fts_map`/`fts_pending`) AND **`DROP TABLE IF EXISTS entries_fts` + CREATE** (detach's best-effort `entries_fts` drop may have failed ⇒ map untrustworthy ⇒ DROP+CREATE), full rebuild via `rebuildSql`, triggers, state=`rebuilding` (`auto` re-attach per NEW-1).
  - state absent AND `entries` table exists (pre-FTS store) → full re-arm + rebuild (the Acceptance-6 foreign-store shape — keyed on entries-did-not-exist, Opus delta M5); state absent AND no `entries` table (truly fresh) → create + stamp `live`.
  - **tokenizer/DDL mismatch** (detect by regexing the `tokenize=` clause of the stored `sqlite_master` DDL vs current `fts5TablesDdl` — raw comparison ALWAYS mismatches because `sqlite_master` drops `IF NOT EXISTS`, mirroring `WikiMemory.ts:277`): `DROP TABLE IF EXISTS entries_fts` + CREATE, clear `fts_map`/`fts_pending`, watermark=0, `rebuilding` (the ONLY marker-loss-era DROP+CREATE cases are this and detached re-attach; both keep the 22.3 s @1M floor as their accepted bound).
- **`drain(opts?: { deadline?: number; mode?: 'ledger' | 'full'; ids?: readonly string[] }): Promise<void>`** — deadline = absolute ms timestamp. Sequence:
  1. **ids-first (read-your-writes, Opus delta M3):** if `ids` non-empty, one id-targeted chunk tx — `chunkIds = SELECT id FROM fts_pending WHERE id IN (SELECT value FROM json_each(?))` — running the same drainChunkSql statement shape bound to those ids. (The "newest seq window" phrasing is RETIRED — it can miss the caller's rows under >500 concurrent writes.)
  2. **Ledger drain:** chunk txs from `drainChunkSql` until ledger empty or deadline.
  3. **Rebuild chunks ONLY when `mode: 'full'` AND `fts5_index_state === 'rebuilding'`** (state gate: a `live` store never reads the watermark; `mode: 'ledger'` never runs rebuild chunks). Arbitration: ledger first, then rebuild chunks with the remainder; **at least one rebuild chunk per full quantum unless the drain overran the deadline** (bounds worst case at budget + 2 × max chunk — Opus delta m1).
- **Rebuild window = drain-shaped, per rowid window** (new `rebuildWindowSql(p)`; every statement binds lo/hi; run in ONE tx with the watermark advance):
  - `chunkIds = SELECT id FROM entries WHERE rowid > ? AND rowid <= ?`
  - `DELETE FROM entries_fts WHERE rowid IN (SELECT m.fts_rowid FROM fts_map m WHERE m.id IN (chunkIds))`
  - `DELETE FROM fts_map WHERE id IN (chunkIds)`
  - `INSERT INTO fts_map (id, entity_id) SELECT e.id, e.entity_id FROM entries e WHERE e.id IN (chunkIds) AND e.deleted_at IS NULL`
  - `INSERT INTO entries_fts (rowid, id, entity_id, title, body, tags) SELECT m.fts_rowid, e.id, … FROM fts_map m JOIN entries e ON e.id = m.id WHERE e.id IN (chunkIds)`
  - watermark = hi.
  **Conflict-free by construction (rev 6):** a row ledger-drained ahead of its window has no ledger row at window time, and its map/FTS rows are deleted+re-inserted by its window anyway; `fts_rowid` (INTEGER PRIMARY KEY, no AUTOINCREMENT) never collides with surviving rows because each window deletes its own ids' FTS rows before inserting. No `INSERT OR IGNORE`, no `max(fts_rowid)` bookkeeping (the rev-3 approach is superseded). Re-doing a window after crash is a no-op.
- **Window bounds:** hi = `SELECT max(rowid) FROM (SELECT rowid FROM entries WHERE rowid > ? ORDER BY rowid LIMIT 500)`; **empty-table guard:** `max(rowid)` NULL ⇒ complete (m5).
- **Orphan sweep (rev 6, REQUIRED before the `live` flip):** windows walk `entries.rowid`, so rows whose entry was hard-deleted (`runPrune`) or id-changed while triggers were down are never visited. Final rebuild quantum runs FIRST a chunked sweep walking `fts_map` by `fts_rowid`: for each `[lo, hi)` window, `DELETE FROM entries_fts WHERE rowid IN (SELECT fts_rowid FROM fts_map WHERE fts_rowid > ? AND fts_rowid <= ? AND id NOT IN (SELECT id FROM entries))` then `DELETE FROM fts_map WHERE fts_rowid > ? AND fts_rowid <= ? AND id NOT IN (SELECT id FROM entries)` — until the map is exhausted. **Completion condition (three clauses, all re-checked inside the flipping tx): watermark ≥ max(entries.rowid) AND `fts_pending` empty AND orphan sweep complete.**
- **Entry-point plumbing (corrected paths, Opus delta m1):** `setup()` → full quantum (normalize in the migration open, then ledger drain + rebuild chunks); **no-arg `syncSearchIndex()` → `syncStale()` → `drainTurn`** → full quantum; `syncEntries`/per-entity `sync(id)` (write-triggered) → **`mode: 'ledger'`** with the write's own `ids` first (a write must not pay ~2.5 s, and never runs rebuild chunks — Opus M-1). (`SearchService.drainTurn` currently calls `this.indexStrategy.drain!()` at :105/:127/:177/:255 — rethread to pass `{ deadline, mode, ids }`.)
- **Interim budget:** until Task 4 wires config, full quanta use the default 1500 ms constant (exported `DEFAULT_SETUP_BUDGET_MS`) — this keeps the broad suites green at this task's Step 4.
- **VACUUM guard (Opus M-6, extended per delta M4):** `MetadataRepository.vacuum()` (:160-162) records `fts_rebuild_post_vacuum = 1` in meta when run while state is `rebuilding` OR the `source_ref_normalize_watermark` key exists; the next `init()`/migration-open sees the flag, resets BOTH watermarks to 0, clears the flag (windows are idempotent), and the rebuild/migration restarts. (Renumbered rowids would otherwise silently skip ranges.)

- [ ] **Step 1: Write failing tests** (real better-sqlite3 adapter, small stores ≤2k rows — reuse the fixture pattern from `.sandbox/leg-smoke-fixture.ts` if helpful):
  1. marker-loss store → init leaves state `rebuilding`, **all three triggers present** (Opus B-2), watermark 0, **`fts_pending` empty; `fts_map` AND `entries_fts` contents INTACT** — search returns stale-but-nonempty results; search does not throw; **no DROP+CREATE occurred** (assert `sqlite_master` DDL/sql rows unchanged).
  2. `drain({ mode: 'full' })` advances the watermark; repeated drains complete the rebuild; final state `live`; exactly-once (map count = live entries; no dup ids); stale rows for soft-deleted entries are gone from their windows.
  3. resume: `rebuilding` store with watermark=K (constructed directly) → init does NOT reset the watermark; drain resumes from K; exactly-once. **Resume with a dropped trigger ⇒ restart from 0** (Opus B-2).
  4. completion requires drained ledger AND completed orphan sweep: pending ledger rows keep state `rebuilding` until drained; an orphaned map row (entry hard-deleted) keeps it until the sweep purges it; **all three clauses re-checked inside the flip tx**.
  5. **conflict-free / drain-before-window (7a):** update a row ABOVE the watermark, drain (its id reaches the map via the ledger), then let its window run → no UNIQUE throw, no duplicate.
  6. **read-your-writes under backlog (7m):** 5k-row ledger backlog + one write → `syncEntries` returns → the written fact is searchable immediately (ids-first `json_each` chunk).
  7. tokenizer-mismatch store (corrupt stored DDL `tokenize=` clause) → init takes the DROP+CREATE floor path; marker-loss does NOT.
  8. detached re-attach (`auto`) → ledger tables re-created + `entries_fts` DROP+CREATE + full rebuild; converges to `live`.
  9. pre-FTS store (state absent, `entries` exists) → enters `rebuilding` with full rebuild; truly fresh store → `live` directly.
  10. **orphan sweep (7g′ unit half):** with triggers down, hard-delete one entry (`runPrune`) and rename another's id-shape; re-arm + converge → the deleted row is NOT searchable, the renamed row IS (under its new id), `fts_map` has no orphan rows.
  11. **write during `rebuilding` returns quickly** (wall < 300 ms for a write against a 2k rebuilding store) and runs `mode: 'ledger'` only — **rebuild chunks never run in a write-triggered turn** (7i half).
  12. `drain({ mode: 'full' })` on a `live` store: ledger drains, watermark never consulted (state gate).
  13. VACUUM guard: set `fts_rebuild_post_vacuum`, reopen → watermark reset, rebuild restarts (Opus M-6).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per Design. **Decisions the reviews pinned:** state gate (`rebuilding` only); drain-shaped windows (no OR IGNORE/max-fts_rowid); orphan sweep before the flip; ids-first via `json_each`; `DEFAULT_SETUP_BUDGET_MS` interim constant.
- [ ] **Step 4: Run to verify pass** + `fts5IndexStrategy.test.ts`, `fts5Integration.test.ts`, `fts5Sql.test.ts`, `SearchService.test.ts` green, **plus the setup()-then-search suites: `WikiMemory.test.ts`, `searchParity.test.ts`, `incrementalSearchIndex.test.ts`, `importDump.test.ts`** (fresh stores must still yield a complete index on first open), then the full core suite with the baseline gate (Global Constraints). Update any test asserting the old single-tx rebuild — note it in the commit body.
- [ ] **Step 5: Commit** — `feat(core): resumable drain-shaped FTS rebuild with orphan sweep in rebuilding state (#280 RC-1/RC-3)`

---

### Task 4: `setupBudgetMs` config + one-deadline-per-open + arbitration

**Objective:** The quantum is time-boxed; the deadline is captured ONCE per open and threaded through; write turns stay drain-only.

**Files:**
- Modify: `packages/core/src/types.ts:342` area (add `setupBudgetMs?: number` to the config type with `@default 1500`)
- Modify: `packages/core/src/services/SearchService.ts` (`setIndexStrategy(strategy, opts?: { budgetMs?: number })` stores `drainBudgetMs`; `sync/drainTurn/syncStale` accept `opts?: { deadline?: number; ids?: readonly string[] }` and forward `{ deadline, mode, ids }` to `drain` — a call WITHOUT an explicit deadline computes `Date.now() + drainBudgetMs` at turn start; per-turn re-budgeting of an open-supplied deadline is forbidden, M-3 holds)
- Modify: `packages/core/src/WikiMemory.ts` (setup(): capture `openDeadline = Date.now() + (config.setupBudgetMs ?? DEFAULT_SETUP_BUDGET_MS)` ONCE after migrations start; pass it to the migration runner and to the post-migration `sync({ deadline: openDeadline })` at :311-320)
- Test: `packages/core/__tests__/rebuildBudget.test.ts`

- [ ] **Step 1: Failing tests:**
  1. `setupBudgetMs: 1` on a 2k-row rebuilding store → a full-quantum `drain()` returns after ~1 ms of chunk work with watermark advanced but < max; repeated calls converge.
  2. Arbitration (7i): on a store with BOTH pending ledger rows and rebuild windows remaining, one quantum drains the ledger first (assert ledger empty before any rebuild-window insert when both fit; when only the ledger fits, ledger drained and watermark untouched); **at least one rebuild chunk still runs when the drain did not overrun the deadline** (forced-final-chunk rule).
  3. Default: config absent → budget 1500 (assert via exported default constant or behavior proxy).
  4. One-deadline-per-open: setup() with a tiny budget on a store with normalize work → the post-migration sync honors the SAME deadline captured at open start (no fresh per-turn budget) — observable via total open wall ≤ normalize + one budget + 2 × max chunk, not normalize + 2 × budget per turn.
- [ ] **Step 2: Verify failure. Step 3: Implement. Step 4: Verify pass** + full search-suite files green.
- [ ] **Step 5: Commit** — `feat(core): setupBudgetMs quantum with one-deadline-per-open and drain-first arbitration (#280 RC-5)`

---

### Task 5: v14 migration + stamped source_ref normalize (RC-2 source_ref half, RC-7)

**Objective:** The every-open GLOB scan + unbounded normalize tx become a one-time, resumable, run-to-completion migration with a version-qualified stamp.

**Files:**
- Modify: `packages/core/src/db/migrations.ts` (append v14 entry; `CURRENT_SCHEMA_VERSION` auto-derives. v14 also defines/creates the partial legacy index — **Task 5 owns creating the shared DDL constant in `schema.ts`; Task 6 consumes it**)
- Modify: `packages/core/src/repositories/EntryRepository.ts` (add `findSourceRefViolationWindow(lo: number, hi: number)`: the `findRowsForSourceRefMigration` predicate (:1242-1255) **narrowed per rev 6 with `OR length(source_ref) > 255` added** (refs longer than 255 are truncated by `normalizeSourceRef` — the old predicate missed them, Opus delta m3) plus `AND rowid > ? AND rowid <= ?`; delete the old method — it has no other callers after this task)
- Modify: `packages/core/src/WikiMemory.ts:301-309` (replace ONLY the normalize block; **keep :297-299 — the `assertNoLegacySourceTypes()` fail-closed check stays in `setup()` unchanged**, per spec Change 2)
- Test: `packages/core/__tests__/migration14.test.ts`, `packages/core/__tests__/migration13.test.ts` (**existing file asserts current version = 13 at :39-40,:63 — update to 14**, Opus m4), extend `packages/core/__tests__/wikiMemory*.test.ts` (whatever file covers setup() — locate via `search_files` for `assertNoLegacySourceTypes` in `__tests__`)

**Design:**
- Stamp meta key: `source_ref_normalize_stamp`, JSON `{ schema_version: 14, normalize_alg: 1 }` (`normalize_alg` = id of the current `normalizeSourceRef` semantics; bump on any future change). Constant `SOURCE_REF_NORMALIZE_ALG = 1` exported from `migrations.ts`. Watermark meta key: `source_ref_normalize_watermark` (named per rev 6 m5).
- v14 `run()`: `CREATE INDEX IF NOT EXISTS` partial legacy index (Task 6's DDL — define it once in `schema.ts` as an exported constant and reuse) + init normalize watermark meta (`source_ref_normalize_watermark` = 0). NO normalize loop inside `run()` (a migration must not be an unbounded tx).
- **Completion + watermark lifecycle (Opus M2, spec rev 6 m5):** "done" = **watermark ≥ `SELECT max(rowid)`**, checked inside the final chunk's tx; that tx writes the stamp **AND deletes `source_ref_normalize_watermark`** — one invariant, never a stale residue (a stale final watermark + later alg bump would "resume" past everything and stamp without scanning; the flip-tx deletion is stated here ONCE). Missing watermark ⇒ 0.
- **Runs to completion, not budget-deferred (Opus M7 / delta M3, spec rev 6):** the normalize loop executes all windows in the migration open — chunked txs, but NOT bounded by `setupBudgetMs` (a mixed normalized/raw window breaks `hasChanged` (false "changed") and `forget({sourceRef})`, and can trip `source_ref_index`'s unique constraint). It shares the openDeadline only in the bookkeeping sense that both finish within the same open (Task 4); the budget governs the post-migration sync quantum after normalize completes.
- Rows whose ref normalizes to NULL are **written NULL** (today's `updateSourceRefByRowid` behavior — keep it; Opus m3).
- **Empty-table guard:** `max(rowid)` NULL (empty entries) ⇒ complete immediately, stamp, delete watermark (Opus m5).
- **VACUUM guard covers the normalize watermark (7p, Opus delta M4):** the Task 3 flag mechanism applies mid-migration too — a post-VACUUM migration open resets the normalize watermark and restarts the scan.
- `setup()` (after migrations, replacing :301-309): read stamp. If present AND `normalize_alg` matches current → skip entirely. Else run the completion loop above. Skip condition keys ONLY on stamp state, never on `schema_version < 14` (self-heals `version=14, stamp missing`).
- Fresh-store fast path (`WikiMemory.ts:266-268`): after setting `schema_version = CURRENT`, also write the stamp + rely on `setupDatabase`'s `IF NOT EXISTS` for the index (Task 6).

- [ ] **Step 1: Failing tests:**
  1. v14 migration on a v13 store: runs, creates the partial index, watermark initialized, `CURRENT_SCHEMA_VERSION === 14`.
  2. Store with 10 violating refs → first setup normalizes ALL of them, writes the stamp; second setup performs ZERO violation scans (assert via sqlite trace or by counting `updateSourceRefByRowid` calls with a spy).
  3. **255-char predicate gap closed:** a row with `length(source_ref) > 255` is found and normalized by the window scan (the old GLOB predicate missed it).
  4. Stamp present but `normalize_alg: 0` → one full rescan to completion (finds nothing, re-stamps, **watermark deleted**).
  5. Stamp deleted, version=14 → self-heals: rescans, re-stamps, watermark deleted.
  6. >500 violating rows → multiple chunk txs, **all within one open regardless of `setupBudgetMs`** (completion test: `setupBudgetMs: 1`, all refs still normalized); exactly-once final state; watermark key **absent** after stamping (Opus M2).
  7. Empty entries table → completes immediately, stamped, no error (NULL rowid guard, m5).
  8. `importDump` regression (Task 2b): dump JSON with a violating ref → imported store's ref is normalized.
- [ ] **Step 2: Verify failure. Step 3: Implement. Step 4: Verify pass** + `migrations.test.ts` + `migration13.test.ts` green (both assert ascending order + CURRENT — v14 must extend, not break, those).
- [ ] **Step 5: Commit** — `feat(core): v14 stamped source_ref normalize migration (#280 RC-2/RC-7)`

---

### Task 6: Partial covering index for the legacy probe (RC-2 source_type half)

**Objective:** The legacy `source_type` check hits a near-free partial index; fail-closed throw unchanged.

**Files:**
- Modify: `packages/core/src/db/schema.ts` (add to `setupDatabase` DDL: `CREATE INDEX IF NOT EXISTS ${prefix}entries_legacy_source_type_idx ON ${prefix}entries(source_type) WHERE source_type IN ('user_document', 'agent_inferred');`)
- Modify: `packages/core/src/repositories/EntryRepository.ts:1211-1218` — no query change needed (verify the planner uses the index; the predicate matches the index's WHERE)
- Test: `packages/core/__tests__/legacyProbeIndex.test.ts`

- [ ] **Step 1: Failing test:** build a store ≥1k rows with none legacy → `EXPLAIN QUERY PLAN` for the `hasLegacySourceTypes` query mentions `entries_legacy_source_type_idx`; `hasLegacySourceTypes()` returns false in O(index) (assert plan, not timing). Insert one `'user_document'` row → returns true (probe correctness).
- [ ] **Step 2: Verify failure** (plan shows full scan). **Step 3: Implement** (schema DDL + confirm v14/task-5 reuse the same DDL constant). **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `perf(core): partial covering index for the legacy source_type probe (#280 RC-2)`

---

### Task 7: Fresh-store fast path completeness (stamp + index)

**Objective:** A fresh store never enters any migration or normalize.

- [ ] **Step 1: Failing test:** brand-new store → first setup() → stamp present with current alg, partial index exists, **normalize watermark key absent** (not "absent-or-final" — M2's invariant), state `live`, schema_version = CURRENT. (If Task 5's implementation already covers this, this test pins it.)
- [ ] **Step 2–4:** red → fix (likely a two-line addition at `WikiMemory.ts:266-268`) → green.
- [ ] **Step 5: Commit** — `fix(core): fresh-store fast path writes the normalize stamp (#280)`

---

### Task 8: Detached-semantics tests (7f) + auto re-attach

**Objective:** Pin both detached behaviors end-to-end.

- [ ] **Step 1: Failing tests:** (a) store detached + open with `indexStrategy: 'minisearch'` → stays detached, MiniSearch active. (b) store detached + open with `'auto'` → `rebuilding` after init, converges to `live` across drains, **assert the installed strategy is an `Fts5IndexStrategy` instance** (via `__testAccess.searchService`; do NOT spy on the MiniSearch constructor — `WikiMemory.ts:144` always constructs the placeholder before setup(), so a construction-spy fails even on correct code — Opus M6); **assert the re-attach took the DROP+CREATE path** (ledger tables re-created — `fts5LedgerDropSql` had dropped them). (c) detached + pinned `'fts5'` → re-attach.
- [ ] **Step 2–4:** red → (expected: mostly already satisfied by Tasks 2–3; fix whatever leaks) → green.
- [ ] **Step 5: Commit** — `test(core): pin detached-state semantics per preference (#280)`

---

### Task 9: Concurrent-writer rebuild exactly-once (7a)

**Objective:** The completion condition holds with writers active mid-rebuild.

- [ ] **Step 1: Failing test:** 2k-row store enters `rebuilding`; a second connection inserts 200 rows while quanta run (interleave: insert after each quantum). After completion: state `live`; every original + inserted live row present exactly once in `fts_map`/`entries_fts`; search finds an inserted-mid-rebuild row. **Include the drain-before-window case explicitly:** update a row above the watermark, drain, then let its window run — no duplicate, no stall.
- [ ] **Step 2–4:** red (if the completion condition races, this catches it) → fix → green.
- [ ] **Step 5: Commit** — `test(core): concurrent-writer rebuild exactly-once via drained-ledger completion (#280)`

---

### Task 10: Marker-loss re-arm test (7g) + orphan sweep integration (7g′) + resume integration (7j)

**Objective:** The corruption path is defined and converges with **no DDL floor** (spec rev 6); orphans converge away; the leg harness's claim is pinned as a deterministic test.

- [ ] **Step 1: Tests:** (a) delete the `fts5_index_state` row + drop one trigger on a built store → next setup enters `rebuilding` via the re-arm tx (**no DROP+CREATE** — old contents stay searchable until their windows re-run; **triggers verified present after the transition and after mid-rebuild resume**, spec 7(g)), quanta converge, final exactly-once. (b) **orphan case (7g′):** with triggers missing, hard-delete one row (`runPrune`) and rename another → converge → **neither is searchable under its stale identity** (the deleted row absent; the renamed row found only under its new id) — the integration half of Task 3 test 10. (c) constructed mid-rebuild state (watermark=K) + forced "crash" (new adapter, same file) → resumes from K, exactly-once (the deterministic version of `.sandbox/leg-fb-crash-resume.ts`; the SIGKILL harness stays in `.sandbox`, not CI). (d) tokenizer-mismatch store → the DROP+CREATE floor path runs (with detached re-attach, the only DDL-floor cases).
- [ ] **Step 2–4:** red → green. **Step 5: Commit** — `test(core): marker-loss re-arm, orphan sweep, crash-resume integration (#280)`

---

### Task 11: Downgrade/backup-restore (7c) + VACUUM guards (7k/7p) + full-suite gate

**Objective:** Stamp invalidation + both VACUUM watermark invalidations pinned; suite green; types + build clean.

- [ ] **Step 1: Tests:** (a) store stamped at alg 1 → simulate downgrade by rewriting stamp `{schema_version: 14, normalize_alg: 0}` + corrupting one ref → next setup rescan normalizes it, re-stamps alg 1. (b) **VACUUM guard rebuild side (7k, Opus M-6):** enter `rebuilding` (watermark > 0) → run the maintenance VACUUM path (`MetadataRepository.ts:160-162`) → reopen → watermark reset to 0, rebuild restarts from scratch, completes exactly-once (windows idempotent). (c) **VACUUM guard normalize side (7p, delta M4):** normalize watermark present mid-migration + VACUUM → next open resets the normalize watermark and rescans.
- [ ] **Step 2–4:** red → green.
- [ ] **Step 5:** Run FULL suite: record baseline first (Task 1 Step 0), gate = no assertion failures + counts ≥ baseline + new tests. `pnpm --filter @equationalapplications/core-llm-wiki typecheck` + `pnpm -r build` clean.
- [ ] **Step 6: Commit** — `test(core): normalize_alg bump forces exactly one rescan; VACUUM guards both watermarks (#280)`

---

### Task 12 (controller, not subagent): Acceptance re-measures

**Objective:** Spec §Acceptance 1/2/5 numbers re-measured on this machine; the Acceptance-6 target **derived from a required @1M normalize measurement BEFORE any 4.7 GB bound** (Opus delta M3: ≈123 s was the DRAIN rate; normalize is unmeasured).

- [ ] **Measure chunked normalize @1M FIRST** (`ISSUE280_STORE_DIR=$HOME/issue280-stores` — never `/tmp`, 3.6 GB tmpfs): rows/s and max chunk commit time for the v14 window scan+normalize. **Derive the Acceptance-6 target**: normalize@1M × 4.2 + `setupDatabase` component (≈ 69 s) + first quantum; record it in spec **rev 7** with the explicit statement that a first migration open on a foreign store exceeds the 15 s fence by design (one-time, chunked, crash-resumable).
- [ ] Re-run `.sandbox/profile-setup.ts` @1M: V1/V2/V3 + crash-backlog shapes on the new engine; fold the before/after table into the same spec revision (append-only).
- [ ] Record the **host-contract sign-off** in the spec review log: SynapseTree calls `syncSearchIndex()` on a schedule it owns (spec Change 3 convergence contract — required at implementation).
- [ ] Update the `indexStrategy` doc comment (`types.ts:330-342`) + option docs: MiniSearch paths (module-absent fallback, pinned `'minisearch'`) carry the measured 1M-entry OOM ceiling — operators of pro-scale stores need raised `--max-old-space-size`.
- [ ] Schedule the ~4.7 GB NVMe legs (~30–45 min each, background, `ISSUE280_STORE_DIR=$HOME/issue280-stores`) — steady-state fence (every `live` open ≤ 15 s incl. post-crash-resume) is the gate criterion; record the largest observed chunk commit time at gate scale (FTS5 auto-merges can stretch it).
- [ ] Post leg summaries to PR #281 as comments (evidence trail, same as the Step-0 legs).

### Task 13 (controller): Step 8 status flip → ready

- [ ] All tasks 1–12 done + CI green (`gh pr checks 281` — never claim green without checking).
- [ ] Commit: `docs(spec): mark issue280 setup wall-time spec Implemented` (flip `**Status:**` to Implemented, rev 7 note).
- [ ] `gh pr ready 281`. Merge = Kurt's call.

---

## Interfaces (cross-task contracts)

- `WikiSearchUnavailableError` (Task 1) — consumed by Task 2's strategy and all five pinned call sites; exported at package root.
- `UnavailableIndexStrategy` (Task 2) — `search()` throws; no `drain` property (the `drainTurn` guard makes write turns silent no-ops; MiniSearch likewise must never grow one).
- `Fts5IndexStrategy.drain(opts?: { deadline?: number; mode?: 'ledger' | 'full'; ids?: readonly string[] })` (Tasks 3–4) — the ONLY quantum executor; `SearchService.sync/drainTurn/syncStale` forward `{ deadline, mode, ids }`; `setup()` supplies the open-captured deadline; write turns supply `mode: 'ledger'` + their ids; full quanta only from `setup()` and no-arg `syncSearchIndex()`.
- `rebuildWindowSql(p)` + `REBUILD_WATERMARK_KEY` (Task 3) — drain-shaped window statements keyed by `SELECT id FROM entries WHERE rowid > ? AND rowid <= ?`; the id-targeted `json_each` drain-chunk variant shares `drainChunkSql`'s statement shape.
- Orphan sweep (Task 3) — chunked walk of `fts_map` by `fts_rowid`; third completion clause alongside watermark ≥ max(rowid) and ledger empty.
- `SOURCE_REF_NORMALIZE_ALG` + stamp JSON shape (Task 5) — consumed by Task 7 (fresh path) and Task 11 (downgrade test); watermark key `source_ref_normalize_watermark` deleted inside the stamping tx.
- Partial-index DDL string (Tasks 5/6) — single exported constant in `schema.ts`, referenced by v14.
- Watermark meta keys: `fts5_rebuild_watermark` (Task 3), `source_ref_normalize_watermark` (Task 5) — both advanced only inside the chunk tx that did the work; both reset by the `fts_rebuild_post_vacuum` flag.
