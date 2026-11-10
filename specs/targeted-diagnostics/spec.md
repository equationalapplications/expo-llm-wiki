# Targeted diagnostics: zero-token replacements for the heavy benchmarks

**Status:** Draft
**Date:** 2026-11-10
**Intent check:** Rule 11 and "How changes are made" item 5. Benchmarks
gate behavior changes, are measured on scratch stores with the harness in
`packages/benchmarks`, and claim no numbers without the run that produced
them. Every suite in this spec lives in `packages/benchmarks`, opens only
in-memory SQLite, and makes no network or LLM calls. It reports prompt
*volume* (characters and calls), never billed tokens or accuracy, so it
makes no claim rule 11 forbids. No INTENT amendment (owner ruling,
2026-11-10).

## Problem

The owner ruled on 2026-11-10 that the heavy benchmarks (LongMemEval,
the live supersession run, scifact/financebench as aggregate gates) are
too slow and expensive for the insight they give. Even ~$20 of Gemini is
not worth it. What is wanted instead: benchmark-style and integration
tests that show *how* the engine behaves, so a failure points at a
specific defect or tuning lever rather than a single score.

This spec is Option 1 of the 2026-11-10 design discussion: three
deterministic, zero-token suites, plus fixes to routing bugs in the
existing harness. Option 2 (tracing the answer-bearing LongMemEval turns
through extract → gate → apply → retrieval, with recorded model
responses) is the next spec. It reuses the determinism harness built
here.

## Root cause (with evidence)

**Where the benchmark cost goes.**
- The 80-question LongMemEval sample is ~9.8M input tokens per config.
- The 150 answer-bearing turns total ~12.5k tokens, and evidence sessions
  are 5.8% of haystack characters. Almost all of the spend is distractor
  ingestion.
- The legacy librarian re-sends the last 50 events and up to 100 full
  fact rows on every pass (`packages/core/src/services/librarian/legacy.ts:35-36`),
  once every 20 writes under `auto`. On the one cached ingest (262
  events), legacy user prompts are an estimated ~6.7x the raw event
  text, against ~1.05x for ops extract.
- Each question ends in one judged boolean, which cannot say which stage
  lost the answer.

**Gaps in the current zero-token tests.**
- `packages/core/__tests__/supersessionReplay.test.ts:13-24` uses a 16-dim
  keyword embedder with `novelThreshold: 0`. The production thresholds
  (0.30 / 0.89, `packages/core/src/services/librarian/ops/gate.ts:43-44`)
  are never exercised against real embeddings in CI.
- `packages/benchmarks/src/calibrate.ts` re-implements the gate's
  arithmetic, needs fastembed at run time, and does not run in CI. Its
  last result (`results/calibration-7.7.7.json`) shows 2 of 36 rows
  misclassified at the defaults.
- The retrieval gates are slack: scifact asserts NDCG@10 ≥ 0.30 against a
  measured 0.72, and financebench asserts MRR@10 ≥ 0.55 against 0.70.
  Both report only an aggregate, so a miss is never attributed to keyword
  search, vector search or fusion.

**Routing bugs in the existing harness.**
1. `packages/benchmarks/src/longmemeval/ingest.ts:177-188`. The config
   forces `maintenance: 'auto'` for `strategy: 'legacy'`, while the cache
   key (`flagsKey`) and the write loop follow `flags.maintenance`. A
   "legacy-deferred" run is legacy-auto writes followed by deferred
   drains, filed under the wrong cache key.
2. `packages/benchmarks/src/supersession/run.ts:224-249`. Heal runs only
   for legacy, so the two strategies do not get the same maintenance
   sequence, and the published 23-vs-19 comparison mixes the strategy
   with the heal pass.
3. `packages/benchmarks/src/cli.ts:134-143` (`estimateIngestTokens`) counts
   each turn once for both strategies and calls that a "deliberate
   overestimate". For legacy it is roughly 6x low, because of the
   re-send window in item 3 of the cost analysis above.
4. `packages/benchmarks/src/report.ts:45` reads the version from core's
   `package.json`, which semantic-release bumps only at release. So
   `results/supersession-7.8.0.json` records `engine.version: "7.7.7"`.

**Determinism blockers for recorded replays (needed by Option 2).**
- Ids come from `crypto.randomUUID` (`packages/core/src/utils/ids.ts:25-26`).
- Core reads the wall clock at 58 sites in 25 files (`Date.now()` /
  `new Date()`), plus `performance.now()` in `utils/monotonicNow.ts`.
- Legacy prompts serialise whole event and fact rows, so ids and
  timestamps land in prompt bytes.
- Gate ties break on fact id (`gate.ts:180`), so random ids can reorder
  neighbour aliases.

## Proposed change

### §1 Determinism harness (`packages/benchmarks/src/determinism.ts`)

`installDeterminism({ seed, startMs, stepMs })` returns a `restore()`
function. While installed:
- **Clock.** `Date.now()`, `new Date()` with no arguments, and
  `performance.now()` return a stepping clock: `startMs` plus `stepMs`
  per read. Time always moves forward, so deadline and timeout loops
  still terminate. Two runs with the same parameters and the same call
  sequence read identical times. `new Date(x)` with an argument is
  unchanged.
- **Ids.** `crypto.randomUUID()` and `crypto.getRandomValues()` draw from
  a seeded PRNG (mulberry32, as in `src/searchParity/buildFixture.ts`).

It is installed only by test code and the replay tools in
`packages/benchmarks`; no core file changes. Acceptance: two in-process
runs of the same scripted ingest produce byte-identical prompt streams
and byte-identical final fact tables.

*My call, open to correction:* patch globals inside the benchmarks
package rather than add a `clock` / `idSource` option to core. Directive
1 keeps this work in `packages/benchmarks`; a core option would touch 25
files and the public `WikiOptions` type for a test-only need. If a
production use for an injected clock appears, it gets its own spec.

### §2 Harness bug fixes

1. **LongMemEval ingest.** The legacy config uses `flags.maintenance`.
   `autoLibrarianThreshold: 20` applies only under `auto`. Legacy-deferred
   then means what its cache key says.
2. **Supersession runner.** Both strategies run the same explicit
   sequence: `runLibrarian`, then `runHeal`, per run segment. The report
   records the sequence (`engine.flags.sequence: 'librarian+heal'`) so it
   cannot be confused with older reports. The 7.8.0 result file is
   history and is not rewritten.
3. **Dry-run estimate.** `estimateIngestTokens` takes the strategy. For
   legacy it models the re-send window: per pass, the last
   `min(50, events so far)` events plus a fact-row allowance. Acceptance:
   on the §3 replay stream the estimate is within ±25% of the ledger's
   measured legacy prompt volume. The docstring stops calling it an
   overestimate.
4. **Report version label.** `engineInfo` also records `gitDescribe`
   (`git describe --tags --always`). `README.md` gains an errata line:
   `supersession-7.8.0.json` was run on the 7.8.0 code and labelled
   7.7.7 because the package version lags until release.

Each fix ships with a unit test that fails on the current code.

### §3 Prompt-volume ledger (`__tests__/promptVolume.test.ts`)

- **Stream.** A fixed, hand-authored event stream of about 60 events
  (`fixtures/promptVolume/stream.json`): mixed topics, a few restatements
  and two relocations, each event with `occurred_at`.
- **Provider.** A scripted provider returns well-formed canned responses
  per call site, classified with `classifyCallSite`
  (`src/instrument.ts:57`):
  - extract and the legacy librarian: facts derived deterministically
    from the batch;
  - resolve: ADD for every candidate;
  - heal: no changes.
  Embeddings come from a deterministic hash embedder.
- **Configs.** The stream is replayed through all four: legacy-auto,
  legacy-deferred, ops-auto and ops-deferred, under §1 determinism.
- **Recorded per config and call site:** calls, system characters, user
  characters, events seen per pass, and the ratio of user characters to
  raw event characters.
- **Output.** A per-config table, written to
  `results/prompt-volume-<gitDescribe>.json` only when
  `BENCH_WRITE_RESULTS=1`.
- **Baseline.** Totals are compared against a committed
  `fixtures/promptVolume/baseline.json`. The test fails if any config's
  total user characters or calls, or any single call site's, rise more
  than 10% above baseline. (Revised 2026-11-10: the first draft also
  capped extract's ratio at 1.25. That figure came from long LongMemEval
  turns. On this stream's short events, the per-line label and ISO
  timestamp alone put ops extract near 1.6, so the per-site baseline check
  replaced the absolute cap.) A deliberate change updates the
  baseline in the same commit, with the reason in the message.
- **Findings check.** An assertion pins the number of distinct events
  each config's librarian actually saw. It exposes whether legacy-deferred
  drops events beyond its 50-event window (`legacy.ts:35`). Whatever it
  shows is recorded as a finding; core behavior is not changed here.

This suite does not measure output tokens, the real resolve rate, or the
behavior of any real model.

### §4 Gate decision log (`__tests__/gateDecisions.test.ts`)

- **What it runs.** The real `gateCandidates`
  (`packages/core/src/services/librarian/ops/gate.ts:121`) with production
  defaults (`resolveGateConfig()`), against every candidate in
  `fixtures/supersession/scenarios.json`.
- **Embeddings.** Real BGE-small vectors from a committed sidecar,
  `fixtures/gate/embeddings.json.gz`, keyed by the exact string
  `embedTextForFact` sends after clamping.
- **Generator.** `src/gate/buildEmbeddings.ts` (`pnpm
  fixture:gate-embeddings`) uses local fastembed: zero tokens, run by
  hand, never in CI.
- **Missing vectors.** A missing key fails with "re-run
  fixture:gate-embeddings".
- **Log.** Per candidate: neighbour ids, cosine, title Jaccard, decision,
  and the margin to the nearest threshold.
- **Expected labels.** The labels come from `expectedClass`
  (`src/calibrate.ts`). The test asserts every row matches, except an
  explicit `KNOWN_MISROUTES` list naming the rows that misroute today
  (expected: the 2 rows in `calibration-7.7.7.json`). A fix that corrects
  a known row must remove it from the list, and a new misroute fails.
- **Margins.** Margins are printed so a threshold change shows its
  headroom.
- **calibrate.ts.** It keeps its CLI role and switches to the same
  sidecar.

### §5 Retrieval miss attribution (`__tests__/retrievalAttribution.test.ts`)

- **Data.** SciFact and FinanceBench, read from
  `packages/integration/fixtures` by relative path, as benchmarks already
  reaches into `../core/src`.
- **Query embeddings.** New committed sidecars,
  `fixtures/retrieval/{scifact,financebench}-query-embeddings.json.gz`,
  built by `src/retrieval/buildQueryEmbeddings.ts` (local fastembed). The
  test then needs no fastembed and no network.
- **Per query:** the rank of each gold document under keyword-only,
  vector-only and the default hybrid blend.
- **Miss classes:**
  - `keyword-miss`: hybrid misses, vector hits;
  - `vector-miss`: hybrid misses, keyword hits;
  - `fusion-demotion`: hybrid ranks gold below both single modes;
  - `both-miss`.
- **Output.** Per-class counts and the worst 10 queries, written as a
  JSON report (same `BENCH_WRITE_RESULTS` rule).
- **Guards.** The aggregate guards are pinned near the measured values
  (NDCG@10 and MRR@10 at measured minus 0.02), and so are the per-class
  counts (measured plus 3).
- **What "keyword-only" and "vector-only" mean.** Before the guards are
  pinned, the plan's first task confirms how `hybridWeight` (see
  `packages/core/src/services/RetrievalService.ts:105`) maps onto these
  two modes. If neither extreme isolates one mode, the suite calls the
  keyword and vector scorers directly instead.

The slack guards in `packages/integration` stay as they are; this suite
is the tight one.

### Out of scope

- Option 2 (answer-turn tracing and recorded model responses): next spec.
- Any core behavior change, including the legacy-deferred window, which
  is reported here and fixed separately if confirmed.
- Running the heavy benchmarks.
- Mining old `benchmark-results` JSON files: they hold aggregates only.

## Files touched

- New: `packages/benchmarks/src/determinism.ts`, `src/scriptedProvider.ts`,
  `src/gate/buildEmbeddings.ts`, `src/retrieval/buildQueryEmbeddings.ts`,
  `src/retrieval/attribution.ts`, and the three `__tests__` suites with
  their fixtures.
- Changed: `src/longmemeval/ingest.ts`, `src/supersession/run.ts`,
  `src/cli.ts`, `src/report.ts`, `src/calibrate.ts`, `README.md`,
  `package.json` (fixture scripts only, no new dependencies).

## Test plan

- `pnpm --filter @equationalapplications/benchmarks-llm-wiki test` and
  `typecheck` pass offline. The network is blocked in the suites by a
  `fetch` stub that throws.
- A determinism self-test: two runs give byte-identical prompt streams.
- Each §2 fix has a test that fails before its fix.
- The §3, §4 and §5 suites each finish in under 60 s locally.
- The root `pnpm test` stays green, and CI wall time grows by under two
  minutes.
