# Targeted diagnostics — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three deterministic, zero-token diagnostic suites (prompt volume, gate decisions, retrieval miss attribution) plus fixes to four harness bugs, all in `packages/benchmarks`.

**Architecture:** A determinism harness patches the clock and random globals during test runs. A scripted provider stands in for the LLM. Committed embedding sidecars stand in for fastembed. The suites drive real core code: `WikiMemory`, `gateCandidates` and `RetrievalService`.

**Tech Stack:** TypeScript, vitest 5, better-sqlite3 (via `src/db.ts`), fastembed 3 (fixture generators only), pnpm 10.33.2.

**Spec:** `specs/targeted-diagnostics/spec.md`

## Global Constraints

- All new code lives in `packages/benchmarks`. No file under `packages/core` changes.
- No new dependencies. `package.json` gains scripts only.
- Suites make no network and no LLM calls. Each new suite does `vi.stubGlobal('fetch', () => { throw new Error('network blocked in diagnostics suite') })` in `beforeAll`.
- SQLite is in-memory only: `openDb()` with no path.
- Results files are written only when `BENCH_WRITE_RESULTS=1`.
- Each suite finishes in under 60 s locally.
- Never edit `CHANGELOG.md` or any `"version"`.
- Commit types: `test(benchmarks)`, `fix(benchmarks)` (benchmarks is private, so no release is cut), `chore(spec)`.
- Commands run from the repo root: `pnpm --filter @equationalapplications/benchmarks-llm-wiki test <file>`, written below as `bt <file>`.

## Review Focus

1. A determinism leak: `restore()` is not called after a test throws, so later suites see a frozen fake clock. Pin with a test that throws inside an installed block and then asserts the real `Date.now()` is back (Task 1).
2. A scenario whose candidate text hits `embed` with a string missing from the sidecar. It must fail with the re-run message, not with a cosine of 0 that silently gates to ADD (Task 6).
3. A stream event with no `occurred_at` leaks the clock into ops extract prompts (`ops/text.ts:12`). The stream-fixture validator rejects such events (Task 4).
4. Baseline drift. A run that legitimately lowers volume must not fail; only a rise of more than 10% fails. Pin both directions (Task 4).
5. Gold documents missing from the corpus import (bad qrels id). Count them as `unscorable`, not as `both-miss` (Task 7).

---

### Task 1: Determinism harness

**Files:**
- Create: `packages/benchmarks/src/determinism.ts`
- Test: `packages/benchmarks/__tests__/determinism.test.ts`

**Interfaces:**
- Produces: `installDeterminism(opts?: { seed?: number; startMs?: number; stepMs?: number }): () => void`. Defaults: seed 1, startMs `Date.UTC(2026,0,1)`, stepMs 1. Also `withDeterminism<T>(opts, fn: () => Promise<T>): Promise<T>`, which installs, runs, and restores in a `finally`.

- [ ] **Step 1: Write failing tests**
  - `clock steps forward`: two `Date.now()` reads give `startMs` then `startMs+stepMs`. `new Date().getTime()` and `performance.now()` also advance. `new Date(0).getTime() === 0`.
  - `seeded ids are reproducible`: run a sequence of 5 `crypto.randomUUID()` calls twice under seed 7 and get equal arrays. Seed 8 gives a different array. Every value matches the UUID v4 regex. `getRandomValues` fills deterministically.
  - `restore puts globals back`: after `restore()`, `Date.now()` is within 1000 ms of a real reading taken before install.
  - `withDeterminism restores after a throw` (Review Focus 1).
  - `core generateId is deterministic`: import `generateId` from `../../core/src/utils/ids` and get equal outputs across two seeded runs.
- [ ] **Step 2: Run** `bt __tests__/determinism.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - Replace `globalThis.Date` with a subclass whose zero-argument constructor and static `now()` use the stepping counter. `performance.now` returns `counter - startMs`.
  - Node's `globalThis.crypto` is a getter, so override `randomUUID` and `getRandomValues` on the existing object with `Object.defineProperty` and keep the originals for `restore`.
  - Use mulberry32, copied from `src/searchParity/buildFixture.ts:17-20`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `test(benchmarks): deterministic clock and seeded id harness (spec §1)`.

### Task 2: LongMemEval ingest honours the maintenance flag

**Files:**
- Modify: `packages/benchmarks/src/longmemeval/ingest.ts:177-188`
- Test: `packages/benchmarks/__tests__/ingest.test.ts` (extend)

- [ ] **Step 1: Failing test** `legacy-deferred builds the engine with maintenance deferred`. Spy on the `WikiMemory` constructor options through the existing test's provider/embedding fakes. Assert that `config.maintenance === 'deferred'` and that `autoLibrarianThreshold` is undefined for `{strategy:'legacy', maintenance:'deferred'}`. For `{legacy, auto}`, assert `maintenance === 'auto'` and `autoLibrarianThreshold === 20`.
- [ ] **Step 2: Run** `bt __tests__/ingest.test.ts`. Expected: the new test FAILs.
- [ ] **Step 3: Implement.** The legacy branch uses `opts.flags.maintenance`, and the threshold is added only under `'auto'`. Update the comment.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(benchmarks): legacy-deferred ingest no longer runs as auto (spec §2.1)`.

### Task 3: Supersession runner parity and version label

**Files:**
- Modify: `packages/benchmarks/src/supersession/run.ts:224-249` and `:300-320`; `packages/benchmarks/src/report.ts:45-55`; `packages/benchmarks/README.md`
- Test: `__tests__/run.test.ts` / `__tests__/supersession.test.ts` (whichever drives `runSupersession`; extend it); `__tests__/cli.test.ts` or a new `report.test.ts` for `engineInfo`

**Interfaces:**
- Produces: `engineInfo()` returns `{ version: string; gitSha: string; gitDescribe: string }`, with `'unknown'` on git failure. Report `engine.flags` gains `sequence: 'librarian+heal'`.

- [ ] **Step 1: Failing tests.**
  - `ops runs heal too`: with a fake endpoint, count calls classified `heal` per strategy for a scenario with no `secondRunFrom`. Both strategies get 1 `runHeal` invocation; spy on `WikiMemory.prototype.runHeal`.
  - `report records the sequence`: `report.engine.flags.sequence === 'librarian+heal'`.
  - `engineInfo has gitDescribe`: it is a non-empty string.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Drop the two `if (flags.strategy === 'legacy')` guards.
  - Add `sequence`.
  - Add `gitDescribe` via `execFileSync('git', ['describe','--tags','--always'])`.
  - Add a README errata line under results: "`supersession-7.8.0.json` ran on 7.8.0 code; `engine.version` reads 7.7.7 because core's package.json version lags until release. Use `gitSha`/`gitDescribe`. Reports before 2026-11-10 ran heal for legacy only."
- [ ] **Step 4: Run** `bt`. Expected: whole package PASS.
- [ ] **Step 5: Commit** `fix(benchmarks): same maintenance sequence for both strategies; record gitDescribe (spec §2.2, §2.4)`.

### Task 4: Scripted provider, stream fixture, prompt-volume ledger

**Files:**
- Create: `packages/benchmarks/src/scriptedProvider.ts`, `src/promptVolume.ts`, `fixtures/promptVolume/stream.json`, `fixtures/promptVolume/baseline.json`
- Test: `packages/benchmarks/__tests__/promptVolume.test.ts`

**Interfaces:**
- Consumes: `withDeterminism` (Task 1), `classifyCallSite` (`src/instrument.ts:57`), `openDb` (`src/db.ts`).
- Produces:
  - `createScriptedProvider(): { provider: LLMProvider; log: ScriptedCall[] }`, where `ScriptedCall = { site: CallSite; systemChars: number; userChars: number; userPrompt: string }`. Per site, extract and librarian answer with one fact per event in the user prompt; the title is the event's first 8 words, and the JSON shapes match what `ops/extract.ts` and `legacy.ts` parse. Resolve answers ADD for each candidate alias. Heal answers its empty/no-change shape. `embed` is a deterministic 64-dim hash embedder.
  - `runPromptVolume(config: { strategy: 'legacy'|'ops'; maintenance: 'auto'|'deferred' }, stream: StreamEvent[]): Promise<VolumeRow>`, where `VolumeRow = { config: string; bySite: Record<CallSite,{calls:number;systemChars:number;userChars:number}>; rawEventChars: number; eventsSeen: number; promptLog: string }`. `eventsSeen` counts distinct stream-event summaries that appear in any librarian/extract user prompt. `promptLog` is the concatenated user prompts, used by the determinism check.
  - `compareToBaseline(rows: VolumeRow[], baseline: BaselineFile): string[]` returns violation messages: user chars or calls more than 10% over baseline, or extract `userChars/rawEventChars > 1.25`.

- [ ] **Step 1: Write `stream.json`.** 60 events: `{ summary, occurred_at }`, with mixed topics, 4 restatements and 2 relocations. Every event has a numeric `occurred_at`.
- [ ] **Step 2: Failing tests.**
  - `stream fixture is valid`: 60 events, all with a finite `occurred_at` (Review Focus 3).
  - `replay is byte-stable`: two `runPromptVolume({ops,deferred})` runs give equal `promptLog`. Same for `{legacy,auto}`.
  - `all four configs run and see events`: each `eventsSeen > 0`. Print the table.
  - `volume within baseline`: `compareToBaseline(rows, baseline)` equals `[]`.
  - `compareToBaseline flags rises, ignores drops`: a synthetic row at +11% gives 1 violation, and one at −30% gives 0 (Review Focus 4).
  - `eventsSeen pinned`: assert each config's `eventsSeen` equals the value recorded in the baseline. Record the legacy-deferred value as a finding in the LEDGER whatever it is.
  - When `BENCH_WRITE_RESULTS=1`, write `results/prompt-volume-<gitDescribe>.json`.
- [ ] **Step 3: Run** `bt __tests__/promptVolume.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the provider and runner. Use `WikiMemory` with explicit `librarian.strategy` and `maintenance`. Under deferred, drain by looping `runPendingMaintenance` until `getPendingMaintenance()` is empty (cap 50). Under auto, `await` an idle wait after each write, as `ingest.ts:112` does.
- [ ] **Step 5: Generate the baseline.** Run once with `BENCH_UPDATE_BASELINE=1`, which writes `baseline.json` from the current rows. Inspect it, then commit it.
- [ ] **Step 6: Run.** Expected: PASS, under 60 s.
- [ ] **Step 7: Commit** `test(benchmarks): prompt-volume ledger across four configs (spec §3)`.

### Task 5: Strategy-aware dry-run estimate

**Files:**
- Modify: `packages/benchmarks/src/cli.ts:126-150` (`estimateIngestTokens` and its callers)
- Test: `__tests__/cli.test.ts` (extend)

**Interfaces:**
- Produces: `estimateIngestTokens(questions: LmeQuestion[], strategy: 'legacy'|'ops'): number`. For legacy, per question simulate passes every 20 turns. Each pass adds the chars of the last `min(50, n)` turns plus `min(100, factsSoFar) * 200` chars, with `factsSoFar = n` turns. Divide by 4 and add the flat 2 000. Ops keeps the current formula.

- [ ] **Step 1: Failing tests.**
  - `legacy estimate exceeds ops`: the legacy estimate is more than 3x ops on the sample fixture.
  - `legacy estimate tracks the ledger`: convert the Task 4 stream into one synthetic `LmeQuestion`. The estimate × 4 is within ±25% of `runPromptVolume({legacy,auto}).bySite.librarian.userChars`. If ±25% fails, tune the 200-char fact allowance, never the tolerance.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Thread `strategy` through the dry-run caller and rewrite the docstring: no "deliberate overestimate".
- [ ] **Step 4: Run** `bt`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(benchmarks): dry-run estimate models the legacy re-send window (spec §2.3)`.

### Task 6: Gate decision log with real embeddings

**Files:**
- Create: `packages/benchmarks/src/gate/collectEmbedTexts.ts`, `src/gate/buildEmbeddings.ts`, `src/gate/decisionLog.ts`, `fixtures/gate/embeddings.json.gz`
- Modify: `packages/benchmarks/src/calibrate.ts` (read vectors from the sidecar), `package.json` (script `fixture:gate-embeddings`)
- Test: `packages/benchmarks/__tests__/gateDecisions.test.ts`

**Interfaces:**
- Produces:
  - `collectEmbedTexts(scenarios): Promise<string[]>` runs the gate path below with a recording `embed` that returns zero vectors, and returns every distinct string `embed` received. This avoids guessing `embedTextForFact`'s clamping.
  - `sidecarEmbed(map: Map<string, number[]>): (text: string) => Promise<number[]>` throws `Error('no sidecar vector for text; re-run pnpm fixture:gate-embeddings')` on a miss (Review Focus 2).
  - `decisionLog(scenario, embed): Promise<DecisionRow[]>` returns `DecisionRow = { scenario: string; candidate: string; decision: 'noop'|'add'|'ambiguous'; bestCosine: number|null; neighbours: Array<{title:string; score:number|null}>; margin: number|null }`.
    - Build a `WikiMemory` (ops strategy), insert `scenario.existing` the way `supersession/run.ts` `insertExistingFacts` does, and call `runReembed`.
    - Get deps via `(wiki.__testAccess.maintenanceService as any).librarianDeps()`.
    - Build `Candidate`s from `scenario.extract.facts` in the shape `ops/extract.ts:15` defines.
    - Call `gateCandidates(deps, {entityId, trigger:'call'}, candidates, resolveGateConfig())`.
    - `margin` is the distance from `bestCosine` to the nearer of `novelThreshold` and `dupThreshold`.

- [ ] **Step 1: Build the sidecar.** Write `collectEmbedTexts` and `buildEmbeddings.ts`, which collects the texts, embeds them with fastembed BGESmallENV15 (as `src/embed.ts` does) and writes gzip JSON `{ model, texts: {[text]: number[]} }`. Run `pnpm --filter @equationalapplications/benchmarks-llm-wiki fixture:gate-embeddings`. Expected: a file under 1 MB.
- [ ] **Step 2: Failing tests.**
  - `every scenario gates with production thresholds`: for every row, `decision === expectedClass(...)` from `src/calibrate.ts`, unless `${scenario}::${candidate}` is in `KNOWN_MISROUTES`. Start the list empty, run, and fill it with the observed misroutes; expect the 2 from `calibration-7.7.7.json`. Record any difference in the LEDGER.
  - `known misroutes still misroute`: each listed row still disagrees. A fix must then remove it from the list.
  - `missing vector fails loudly`: `sidecarEmbed(new Map())('x')` rejects with the re-run message.
  - `gate is deterministic`: two runs under `withDeterminism` give equal rows.
  - Print the table sorted by `|margin|` ascending.
- [ ] **Step 3: Run** `bt __tests__/gateDecisions.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `decisionLog` and `sidecarEmbed`. Point `calibrate.ts` at the sidecar and keep its CLI output unchanged. The existing `calibrate.test.ts` must still pass.
- [ ] **Step 5: Run** `bt`. Expected: PASS.
- [ ] **Step 6: Commit** `test(benchmarks): gate decision log on recorded BGE vectors (spec §4)`.

### Task 7: Retrieval miss attribution

**Files:**
- Create: `packages/benchmarks/src/retrieval/buildQueryEmbeddings.ts`, `src/retrieval/attribution.ts`, `fixtures/retrieval/scifact-query-embeddings.json.gz`, `fixtures/retrieval/financebench-query-embeddings.json.gz`, `fixtures/retrieval/guards.json`
- Modify: `package.json` (script `fixture:retrieval-queries`)
- Test: `packages/benchmarks/__tests__/retrievalAttribution.test.ts`

**Interfaces:**
- Consumes: the corpus dumps and qrels in `packages/integration/fixtures/`. Loading follows `packages/integration/__tests__/scifact.test.ts:35-80` and `financebench.test.ts` (importDump plus the sidecar restore into `embedding_blob`).
- Produces:
  - `attribute(dataset: 'scifact'|'financebench'): Promise<AttributionReport>`, where `AttributionReport = { dataset; metric: 'ndcg@10'|'mrr@10'; hybrid: number; keywordOnly: number; vectorOnly: number; classes: Record<'hit'|'keyword-miss'|'vector-miss'|'fusion-demotion'|'both-miss'|'unscorable', number>; worst: Array<{query:string; goldRanks:{hybrid:number|null;keyword:number|null;vector:number|null}}> }`.
  - "Miss" means gold is not in the top 10. `fusion-demotion` means hybrid rank > min(keyword, vector) and both single modes hit. `unscorable` means the gold id is absent from the imported corpus (Review Focus 5).

- [ ] **Step 1: Confirm the modes.** Read `RetrievalService.ts:95-200`. `hybridWeight: 0` sets `skipEmbed`, which is keyword-only. Confirm that `1` is vector-only. If it is not, use the direct scorer path and note it in the LEDGER.
- [ ] **Step 2: Build the sidecars** with `fixture:retrieval-queries` (fastembed, query texts only). Expected: each file under 1 MB.
- [ ] **Step 3: Failing tests.**
  - `scifact attribution`: `hybrid >= guards.scifact.hybrid`, and each class count `<= guards.scifact.classes[c]`.
  - The same test for `financebench`.
  - `classes sum to query count`.
  - `query embedding is never computed`: the embed stub throws on any text not in the sidecar.
  - The guards are generated with `BENCH_UPDATE_BASELINE=1` as measured − 0.02 for metrics and measured + 3 for counts, inspected and committed.
- [ ] **Step 4: Run** `bt __tests__/retrievalAttribution.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement** `attribute`. Print the per-class table and the worst 10.
- [ ] **Step 6: Run** it. Expected: PASS, under 60 s. If scifact's 5k-doc import exceeds the limit, record the time in the LEDGER and raise the test timeout for this file only.
- [ ] **Step 7: Commit** `test(benchmarks): retrieval miss attribution for scifact and financebench (spec §5)`.

### Task 8: Docs and full verification

**Files:**
- Modify: `packages/benchmarks/README.md` (a "Diagnostics suites" section: what each suite tells you, how to regenerate the sidecars and baselines, and that they spend zero tokens).

- [ ] **Step 1: Write the README section.**
- [ ] **Step 2: Verify.** Run `pnpm --filter @equationalapplications/benchmarks-llm-wiki typecheck && pnpm --filter @equationalapplications/benchmarks-llm-wiki test`, then root `pnpm test`. Expected: all green. Record the wall-time delta in the LEDGER.
- [ ] **Step 3: Commit** `docs(benchmarks): diagnostics suites`.
