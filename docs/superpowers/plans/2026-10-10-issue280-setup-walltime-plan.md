# Issue #280 `setup()` Wall Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `wiki.setup()` open O(state-change) instead of O(database): skip the every-open survival scans (v14 stamp + partial index), replace the single-tx FTS rebuild with a watermark-chunked, budget-budgeted converging rebuild, and make FTS init failures recoverable instead of index-destroying.

**Architecture:**
- **Survival scans (RC-2/RC-7):** `WikiMemory.setup()` replaces its two every-open scans with: (a) a fail-closed legacy `source_type` probe served by a new partial covering index, (b) a `source_ref` normalize that runs only when the `source_ref_normalize_stamp` meta key is missing/mismatched, in budgeted rowid-watermarked chunks, stamping on completion inside the final chunk's tx.
- **FTS state machine (RC-1/RC-3/RC-4/RC-5):** `fts5_index_state` gains a load-bearing `rebuilding` value. `Fts5IndexStrategy.init()` never rebuilds in one tx: it either fast-paths (`live` + triggers present), or enters `rebuilding` (marker-loss/trigger-loss: one unchunkable DROP+CREATE DDL tx — accepted 22.3 s @1M floor; resumption: none needed), and `drain()` becomes the shared budgeted quantum: ledger drain first, then rebuild chunks (rowid windows of ≤500, watermark advancing inside each chunk tx) until `setupBudgetMs` (default 1500) is exhausted. Completion condition: watermark ≥ max(entries.rowid) AND ledger empty → flip to `live` in the final chunk's tx.
- **RC-6 guard:** `createIndexStrategy` reorders `init()` failures into read-only-probes-first, one 250 ms retry, and NEVER calls `detachFts5` on the `auto` failure path — it returns an `UnavailableFts5IndexStrategy` whose `search()` throws `WikiSearchUnavailableError` (new exported error class). MiniSearch instantiation by `auto` happens only on the module-absent path (`probeFts5` false). Pinned `'minisearch'` keeps today's detach behavior; `'auto'` re-attaches detached stores (enters `rebuilding`).

**Tech Stack:** TypeScript 5.9 (strict), vitest, pnpm workspace, better-sqlite3 13.0.3 (SQLite FTS5), Node ≥24.

**Spec:** `docs/superpowers/specs/2026-10-10-issue280-setup-walltime-design.md` (rev 4, **Approved** by GLM 5.3 r4). Investigation: `docs/superpowers/investigations/2026-10-10-issue280-setup-walltime-investigation.md`. If plan and spec disagree, the spec wins: stop and report.

## Global Constraints

- **Branch/PR:** everything lands on `spec/issue280-setup-walltime` (PR #281, DRAFT until implementation completes). No new branches, no worktrees.
- **Commands** (from repo root):
  - One core test file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`
  - Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`
  - Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
  - Workspace build: `pnpm -r build`
- **Known local test-runner issue (from the 2026-09-22 plan, still assumed):** the full core suite on this ThinkPad can report vitest `Worker exited unexpectedly` fork-pool errors with zero assertion failures. Record the local baseline before Task 1; judge the full-suite gate as "no assertion failures, completed counts ≥ baseline plus new tests". **CI is the authoritative gate.** Single-file runs are reliable; for a red phase with many failures at once, re-run that file with `--pool=threads`.
- **Commit types:** `feat(core): …` (new capability), `fix(core): …` (behavior fix), `perf(core): …` (scan skip), `test(core): …`, `docs(spec): …`. **Never start a commit body line with `BREAKING CHANGE`** (semantic-release parses it as a footer and cuts a major). None of these changes are breaking: `setupBudgetMs` and the error class are additive; `'auto'` behavior changes are fixes to a measured crash path (documented in the spec, not a semver major).
- **Spec edits are appended as revisions** (rev 5, 6, …); existing revision entries are never rewritten. The Step-8 `**Status:**` flip to Implemented is its own commit ON this branch, only after every task below is done.
- **This plan file is gitignored** (`docs/superpowers/plans/`): commit with `git add -f`.
- **Merge is Kurt's call** (SOP gate); merge commits only, never squash.
- **Fence arithmetic to respect in every design decision:** per-open quantum wall = `setupBudgetMs` + max chunk tx (~1.01 s @1M measured). Never introduce an unbounded loop, a full-table scan, or a non-`IF NOT EXISTS` DDL on the every-open path.
- **Measured constants you may rely on** (investigation §2): partial-index probe 0.4 ms; glob scan 1.13 s @1M; legacy scan 0.60 s @1M; rebuild chunk throughput 7.6–8.1k rows/s; max chunk 733–1010 ms @1M; DDL floor (DROP+CREATE virtual table @1M) 22.3 s; V1 ladder component 16.5 s @1M.

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

### Task 2: Failure-ordered init + retry + never-demote in `createIndexStrategy`

**Objective:** On `auto`, an `init()` failure retries once and never calls `detachFts5`; the caller gets an unavailable strategy whose search throws the typed error.

**Files:**
- Modify: `packages/core/src/services/search/createIndexStrategy.ts:47-74` (the `createIndexStrategy` function)
- Create: `packages/core/src/services/search/UnavailableFts5IndexStrategy.ts`
- Test: `packages/core/__tests__/createIndexStrategy.test.ts`

**Design (fix these semantics now, they ripple):**
- `UnavailableFts5IndexStrategy implements IndexStrategy`: `search()` throws `WikiSearchUnavailableError` (cause = the last init error); `replace`/`replaceEntity`/`replaceAll` are **no-ops** (entries remain the source of truth; the index converges on recovery); `drain` is a no-op resolving normally (keeps `SearchService.drainTurn` healthy).
- Retry = one re-call of the same init after `setTimeout` 250 ms. If the retry succeeds, return the real strategy. If it fails again, return `new UnavailableFts5IndexStrategy(lastError)` — **`detachFts5` is not called anywhere on this path.**
- The existing `probeFts5`-false fallback (module genuinely absent → `detachFts5` + MiniSearch) is UNCHANGED — but only reachable when the probe fails, never from the init-catch path.
- Pinned `'fts5'` failure still throws the raw error (`:65`), unchanged.

- [ ] **Step 1: Write failing tests** (mock a `SQLiteAdapter` + `MetadataRepository` like `fts5IndexStrategy.test.ts` does; force `Fts5IndexStrategy.prototype.init` to throw via `vi.spyOn`):
  1. init throws twice → returned strategy is `UnavailableFts5IndexStrategy`; store state (`fts5_index_state`) is untouched; `fts_map`/`fts_pending` still exist.
  2. `search()` on it throws `WikiSearchUnavailableError` with the init error as `cause`.
  3. init throws once then succeeds → real strategy returned.
  4. `preferred: 'fts5'` + failing init → raw throw propagates.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/createIndexStrategy.test.ts` → FAIL (today's code detaches + returns MiniSearch).
- [ ] **Step 3: Implement** the reordered `createIndexStrategy` per Design above.
- [ ] **Step 4: Run to verify pass** + `createIndexStrategy.test.ts` (its module-absent fallback cases are the actual regression guard here — `miniSearchFallback.test.ts` is the read-path fallback, not strategy selection), `miniSearchFallback.test.ts` still green. **Add test 5: reopen-recovers** — after a double-failure open, a second `new WikiMemory(...)` open on the same store succeeds with a working strategy and keyword search returns results (pins spec 7(e)'s "next open recovers").
- [ ] **Step 5: Commit** — `fix(core): auto init failure retries and never demotes the FTS index (#280 RC-6)`

### Task 2b: `importDump` belt — dump-header stamp + conditional normalize

**Objective:** Spec write-path audit belt (b): a dump from a store whose stamp is missing/older gets its refs re-normalized on import.

**Files:**
- Modify: `packages/core/src/services/ImportExportService.ts` (`MemoryDump` (:30-58) gains an optional header field `sourceRefNormalizeStamp?: { schema_version: number; normalize_alg: number }`; `exportDump` writes the store's stamp; `importDump` compares it to the current `SOURCE_REF_NORMALIZE_ALG` and, on missing/older, runs the same budgeted chunked normalize used by `setup()` — extract that loop from Task 5 into a shared private helper so both call sites are one function)
- Test: `packages/core/__tests__/importDumpNormalizeBelt.test.ts`

- [ ] **Step 1: Failing tests:** (1) dump from stamped store imports with zero normalize passes; (2) dump with `sourceRefNormalizeStamp: undefined` (legacy dump) + planted violating ref → import normalizes it and the store ends stamped; (3) dump stamped at `normalize_alg: 0` → re-normalized on import.
- [ ] **Step 2: Verify failure. Step 3: Implement. Step 4: Verify pass** + `importDump.test.ts` green (dump JSON stays backward-compatible: new field optional on read).
- [ ] **Step 5: Commit** — `feat(core): importDump re-normalizes dumps with missing or older normalize stamps (#280)`

---

### Task 3: `rebuilding` state + chunked rebuild mechanics in `Fts5IndexStrategy`

**Objective:** Marker-loss/trigger-loss no longer rebuilds in one tx; a resumable chunked rebuild exists.

**Files:**
- Modify: `packages/core/src/services/search/Fts5IndexStrategy.ts` (init + new private rebuild machinery)
- Modify: `packages/core/src/services/search/fts5Sql.ts` (new SQL constants: `REBUILD_WATERMARK_KEY = 'fts5_rebuild_watermark'`, windowed rebuild SQL)
- Test: `packages/core/__tests__/fts5Rebuild.test.ts`

**Design:**
- `init()` reads state (read-only) + `triggersPresent()` (read-only) BEFORE any mutation. Cases:
  - `live` + all triggers → `fts5TablesDdl` no-op guard, return (fast path, unchanged).
  - `rebuilding` → return (resume; `drain()` continues the rebuild).
  - marker lost OR any trigger missing → ONE transition tx: `DROP TABLE IF EXISTS entries_fts;` + `fts5TablesDdl` + clear `fts_map`/`fts_pending` + watermark = 0 + state = `rebuilding`. (Unchunkable DDL floor, accepted.)
  - state `detached` → same transition tx as marker-loss (auto re-attach; the caller in `createIndexStrategy` only routes here for `fts5`/`auto` — Task 2 guarantees `auto` never reaches `detachFts5` on failure).
- New `advanceRebuildQuantum(budgetMs): Promise<boolean>` — returns `true` when rebuild is complete. Loop: check elapsed; read watermark; `maxRowid = SELECT max(rowid) FROM entries`; if watermark ≥ maxRowid AND `fts_pending` empty → flip `live` in the same tx that drains the last ledger chunk; else next window tx: `BEGIN` → `INSERT INTO fts_map (id, entity_id) SELECT id, entity_id FROM entries WHERE deleted_at IS NULL AND rowid > ? AND rowid <= ?` (window = watermark+1 .. watermark+500 …but windows advance by rowid bounds, not row counts: use `SELECT max(rowid) FROM (SELECT rowid FROM entries WHERE rowid > ? ORDER BY rowid LIMIT 500)` to get the window's hi) → `INSERT INTO entries_fts ... FROM fts_map m JOIN entries e ... WHERE e.rowid > ? AND e.rowid <= ?` (the exact join shape of `rebuildSql`, windowed) → watermark = hi → `COMMIT`. Ledger drain still runs FIRST inside `drain()` (Task 4).
- `drain()` becomes the shared quantum (Task 4 wires the budget): drain ledger chunks until empty or budget out; then `advanceRebuildQuantum` with the remaining budget.

- [ ] **Step 1: Write failing tests** (real better-sqlite3 adapter, small stores ≤2k rows — reuse the fixture pattern from `.sandbox/leg-smoke-fixture.ts` if helpful):
  1. marker-loss store → init leaves state `rebuilding`, watermark 0, fts tables empty; search returns partial (possibly empty) results without throwing.
  2. `drain(budget)` advances the watermark; repeated drains complete the rebuild; final state `live`; exactly-once (map count = live entries; no dup ids).
  3. resume: set up a `rebuilding` store with watermark=K (simulate crash by constructing state directly) → init does NOT reset the watermark; drain resumes from K; exactly-once.
  4. completion requires drained ledger: with pending ledger rows above the watermark, state stays `rebuilding` until they're drained.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per Design. **Two decisions the review pinned:**
  - **State gate:** rebuild chunks run ONLY when `fts5_index_state === 'rebuilding'`. `drain()` on a `live` store drains the ledger and returns — it never reads the watermark (absent on legacy-live stores; stale as live stores grow). No NaN path, no accidental re-entrancy.
  - **Conflict-free window inserts (drain-first makes collisions normal, not exceptional):** a row written mid-rebuild is ledger-drained (→ already in `fts_map`) before its rebuild window arrives. Window SQL must be idempotent: `INSERT INTO fts_map (fts_rowid, id, entity_id) SELECT ... WHERE rowid > ? AND rowid <= ? AND id NOT IN (SELECT id FROM fts_map WHERE ...)` — or `INSERT OR IGNORE` on the map — and the `entries_fts` insert only for rows this window actually mapped (join through the just-inserted map rows; re-inserting a mapped id hits FTS5 rowid uniqueness). Re-doing a window after crash is a no-op, not an error.
  - **Interim drain budget:** until Task 4 wires config, `drain()` uses the default 1500 ms constant (exported `DEFAULT_SETUP_BUDGET_MS`) — this is what keeps the broad suites green at this task's Step 4.
- [ ] **Step 4: Run to verify pass** + `fts5IndexStrategy.test.ts`, `fts5Integration.test.ts`, `fts5Sql.test.ts`, `SearchService.test.ts` green, **plus the setup()-then-search suites: `WikiMemory.test.ts`, `searchParity.test.ts`, `incrementalSearchIndex.test.ts`, `importDump.test.ts`** (fresh stores must still yield a complete index on first open), then the full core suite with the baseline gate (Global Constraints). Update any test asserting the old single-tx rebuild — note it in the commit body.
- [ ] **Step 5: Commit** — `feat(core): resumable watermark chunked FTS rebuild in rebuilding state (#280 RC-1/RC-3)`

---

### Task 4: `setupBudgetMs` config + budget arbitration (drain before rebuild)

**Objective:** The quantum is time-boxed; recent-write recall drains first.

**Files:**
- Modify: `packages/core/src/types.ts:342` area (add `setupBudgetMs?: number` to the config type with `@default 1500`)
- Modify: `packages/core/src/services/SearchService.ts` (`setIndexStrategy(strategy, opts?: { budgetMs?: number })` — the service stores `drainBudgetMs`; `drainTurn` computes a fresh deadline per turn (`Date.now() + budgetMs` at turn start) and passes it to `drain(deadline)` — this is the decided plumbing: per-call budget semantics per spec Config surface, not a strategy-held clock)
- Modify: `packages/core/src/WikiMemory.ts:311-320` (pass `config.setupBudgetMs ?? DEFAULT_SETUP_BUDGET_MS` through `setIndexStrategy`)
- Test: `packages/core/__tests__/rebuildBudget.test.ts`

- [ ] **Step 1: Failing tests:**
  1. `setupBudgetMs: 1` on a 2k-row rebuilding store → `drain()` returns after ~1 ms of chunk work with watermark advanced but < max; repeated calls converge.
  2. Arbitration: on a store with BOTH pending ledger rows and rebuild windows remaining, one quantum drains the ledger first (assert ledger empty before any rebuild-chunk insert when both fit; when only the ledger fits the budget, ledger drained and watermark untouched).
  3. Default: config absent → budget 1500 (assert via exported default constant or behavior proxy).
- [ ] **Step 2: Verify failure. Step 3: Implement. Step 4: Verify pass** + full search-suite files green.
- [ ] **Step 5: Commit** — `feat(core): setupBudgetMs quantum with drain-first arbitration (#280 RC-5)`

---

### Task 5: v14 migration + stamped source_ref normalize (RC-2 source_ref half, RC-7)

**Objective:** The every-open GLOB scan + unbounded normalize tx become a one-time, budgeted, resumable migration with a version-qualified stamp.

**Files:**
- Modify: `packages/core/src/db/migrations.ts` (append v14 entry; `CURRENT_SCHEMA_VERSION` auto-derives. v14 also defines/creates the partial legacy index — **Task 5 owns creating the shared DDL constant in `schema.ts`; Task 6 consumes it**)
- Modify: `packages/core/src/repositories/EntryRepository.ts` (add `findSourceRefViolationWindow(lo: number, hi: number)`: the `findRowsForSourceRefMigration` predicate (:1242-1255) plus `AND rowid > ? AND rowid <= ?`; delete the old method — it has no other callers after this task)
- Modify: `packages/core/src/WikiMemory.ts:301-309` (replace ONLY the normalize block; **keep :297-299 — the `assertNoLegacySourceTypes()` fail-closed check stays in `setup()` unchanged**, per spec Change 2)
- Test: `packages/core/__tests__/migration14.test.ts`, extend `packages/core/__tests__/wikiMemory*.test.ts` (whatever file covers setup() — locate via `search_files` for `assertNoLegacySourceTypes` in `__tests__`)

**Design:**
- Stamp meta key: `source_ref_normalize_stamp`, JSON `{ schema_version: 14, normalize_alg: 1 }` (`normalize_alg` = id of the current `normalizeSourceRef` semantics; bump on any future change). Constant `SOURCE_REF_NORMALIZE_ALG = 1` exported from `migrations.ts`.
- v14 `run()`: `CREATE INDEX IF NOT EXISTS` partial legacy index (Task 6's DDL — define it once in `schema.ts` as an exported constant and reuse) + init normalize watermark meta (`source_ref_normalize_watermark` = 0). NO normalize loop inside `run()` (a migration must not be an unbounded tx).
- `setup()` (after migrations, replacing :297-309): read stamp. If present AND `normalize_alg` matches current → skip entirely. Else loop quanta (same `setupBudgetMs` budget, drain arbitration does not apply here): window tx = read violation rows in the next rowid window (via the watermark, `LIMIT 500` window like Task 3) → normalize each (`normalizeSourceRef`, skip null returns) → `updateSourceRefByRowid` → advance watermark. When a window finds no more rows → write the stamp INSIDE that final chunk tx. Skip condition keys ONLY on stamp state, never on `schema_version < 14` (self-heals `version=14, stamp missing`).
- Fresh-store fast path (`WikiMemory.ts:266-268`): after setting `schema_version = CURRENT`, also write the stamp + rely on `setupDatabase`'s `IF NOT EXISTS` for the index (Task 6).

- [ ] **Step 1: Failing tests:**
  1. v14 migration on a v13 store: runs, creates the partial index, watermark initialized, `CURRENT_SCHEMA_VERSION === 14`.
  2. Store with 10 violating refs → first setup normalizes ALL of them, writes the stamp; second setup performs ZERO violation scans (assert via sqlite trace or by counting `updateSourceRefByRowid` calls with a spy).
  3. Stamp present but `normalize_alg: 0` → one rescan (finds nothing, re-stamps).
  4. Stamp deleted, version=14 → self-heals: rescans, re-stamps.
  5. >500 violating rows → multiple quanta; a setup() with `setupBudgetMs: 1` resumes across calls; exactly-once final state (all refs normalized).
- [ ] **Step 2: Verify failure. Step 3: Implement. Step 4: Verify pass** + `migrations.test.ts` green (it asserts ascending order + CURRENT — v14 must extend, not break, those).
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

- [ ] **Step 1: Failing test:** brand-new store → first setup() → stamp present with current alg, partial index exists, normalize watermark key absent-or-final, state `live`, schema_version = CURRENT. (If Task 5's implementation already covers this, this test pins it.)
- [ ] **Step 2–4:** red → fix (likely a two-line addition at `WikiMemory.ts:266-268`) → green.
- [ ] **Step 5: Commit** — `fix(core): fresh-store fast path writes the normalize stamp (#280)`

---

### Task 8: Detached-semantics tests (7f) + auto re-attach

**Objective:** Pin both detached behaviors end-to-end.

- [ ] **Step 1: Failing tests:** (a) store detached + open with `indexStrategy: 'minisearch'` → stays detached, MiniSearch active. (b) store detached + open with `'auto'` → `rebuilding` after init, converges to `live` across drains, MiniSearch never constructed (**spy on the `MiniSearchIndexStrategy` constructor** — it has no `init` method; `vi.spyOn(..., 'init')` throws on the undefined property). (c) detached + pinned `'fts5'` → re-attach.
- [ ] **Step 2–4:** red → (expected: mostly already satisfied by Tasks 2–3; fix whatever leaks) → green.
- [ ] **Step 5: Commit** — `test(core): pin detached-state semantics per preference (#280)`

---

### Task 9: Concurrent-writer rebuild exactly-once (7a)

**Objective:** The completion condition holds with writers active mid-rebuild.

- [ ] **Step 1: Failing test:** 2k-row store enters `rebuilding`; a second connection inserts 200 rows while quanta run (interleave: insert after each quantum). After completion: state `live`; every original + inserted live row present exactly once in `fts_map`/`entries_fts`; search finds an inserted-mid-rebuild row.
- [ ] **Step 2–4:** red (if the completion condition races, this catches it) → fix → green.
- [ ] **Step 5: Commit** — `test(core): concurrent-writer rebuild exactly-once via drained-ledger completion (#280)`

---

### Task 10: Marker-loss DDL-floor test (7g) + resume integration (7j)

**Objective:** The corruption path is defined and converges; the leg harness's claim is pinned as a deterministic test.

- [ ] **Step 1: Tests:** (a) delete the `fts5_index_state` row + drop one trigger on a built store → next setup enters `rebuilding` (DDL floor executes), quanta converge, final exactly-once. (b) constructed mid-rebuild state (watermark=K) + forced "crash" (new adapter, same file) → resumes from K, exactly-once (the deterministic version of `.sandbox/leg-fb-crash-resume.ts`; the SIGKILL harness stays in `.sandbox`, not CI).
- [ ] **Step 2–4:** red → green. **Step 5: Commit** — `test(core): marker-loss DDL floor + crash-resume integration (#280)`

---

### Task 11: Downgrade/backup-restore (7c) + full-suite gate

**Objective:** Stamp invalidation semantics pinned; suite green; types + build clean.

- [ ] **Step 1: Test:** store stamped at alg 1 → simulate downgrade by rewriting stamp `{schema_version: 14, normalize_alg: 0}` + corrupting one ref → next setup rescan normalizes it, re-stamps alg 1. 
- [ ] **Step 2–4:** red → green.
- [ ] **Step 5:** Run FULL suite: record baseline first (`git stash`-free: run on the pre-task commit if not yet recorded), gate = no assertion failures + counts ≥ baseline + new tests. `pnpm --filter @equationalapplications/core-llm-wiki typecheck` + `pnpm -r build` clean.
- [ ] **Step 6: Commit** — `test(core): normalize_alg bump forces exactly one rescan (#280)`

---

### Task 12 (controller, not subagent): Acceptance re-measures

**Objective:** Spec §Acceptance 1/2/5 numbers re-measured on this machine; Acceptance 6's 4.7 GB legs scheduled.

- [ ] Re-run `.sandbox/profile-setup.ts` @1M: V1/V2/V3 + crash-backlog shapes on the new engine; fold the before/after table into spec **rev 5** (append-only).
- [ ] Record the **host-contract sign-off** in the spec review log: SynapseTree calls `syncSearchIndex()` on a schedule it owns (spec Change 3 convergence contract — required at implementation).
- [ ] Update the `indexStrategy` doc comment (`types.ts:330-342`) + option docs: MiniSearch paths (module-absent fallback, pinned `'minisearch'`) carry the measured 1M-entry OOM ceiling — operators of pro-scale stores need raised `--max-old-space-size`.
- [ ] Schedule the ~4.7 GB NVMe legs (~30–45 min each, background, `ISSUE280_STORE_DIR=$HOME/issue280-stores`) — steady-state fence (≤15 s) and foreign-store first-open (≤120 s / ≤240 s) are the gate criteria.
- [ ] Post leg summaries to PR #281 as comments (evidence trail, same as the Step-0 legs).

### Task 13 (controller): Step 8 status flip → ready

- [ ] All tasks 1–12 done + CI green (`gh pr checks 281` — never claim green without checking).
- [ ] Commit: `docs(spec): mark issue280 setup wall-time spec Implemented` (flip `**Status:**` to Implemented, rev 5 note).
- [ ] `gh pr ready 281`. Merge = Kurt's call.

---

## Interfaces (cross-task contracts)

- `WikiSearchUnavailableError` (Task 1) — consumed by Task 2's strategy; exported at package root.
- `Fts5IndexStrategy.drain()` (Tasks 3–4) — the ONLY quantum executor; `SearchService.sync/drainTurn` call it unchanged; `setup()`'s post-init `sync()` (WikiMemory.ts:320) is what makes open #1 after a failure/convergence event productive.
- `SOURCE_REF_NORMALIZE_ALG` + stamp JSON shape (Task 5) — consumed by Task 7 (fresh path) and Task 11 (downgrade test).
- Partial-index DDL string (Tasks 5/6) — single exported constant in `schema.ts`, referenced by v14.
- Watermark meta keys: `fts5_rebuild_watermark` (Task 3), `source_ref_normalize_watermark` (Task 5) — both advanced only inside the chunk tx that did the work.
