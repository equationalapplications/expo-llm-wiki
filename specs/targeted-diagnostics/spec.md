# Targeted diagnostics: zero-token replacements for the heavy benchmarks

**Status:** Implemented (PR #357)
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

**Where the benchmark cost goes.** These figures are estimates, not
measurements. They come from offline arithmetic during the 2026-11-10
design consultation:
- character counts over the committed 80-question sample
  (`fixtures/longmemeval-sample.json`), applied to the downloaded
  LongMemEval-S file;
- the one partial ingest cache at
  `.cache/ingest/8.0.0/legacy-auto/6a27ffc2.sqlite`, which is local and not
  committed.

No run produced them. Per INTENT rule 11 they are for sizing this work,
and are not to be quoted as results.
- The 80-question LongMemEval sample is ~9.8M input tokens per config, by
  the dry-run estimate.
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
  (0.30 / 0.89, `packages/core/src/services/librarian/ops/gate.ts:44-45`)
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
- Gate ties break on fact id (`gate.ts:168`), so random ids can reorder
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
  (`src/instrument.ts:56`):
  - extract and the legacy librarian: facts derived deterministically
    from the batch;
  - resolve: ADD for every candidate;
  - heal: no changes.
  Embeddings come from a deterministic hash embedder.
- **Configs.** The stream is replayed through all four: legacy-auto,
  legacy-deferred, ops-auto and ops-deferred, under §1 determinism.
- **Recorded:**
  - per config and call site: calls, system characters and user
    characters;
  - per config: the total distinct stream events any librarian prompt
    showed (`eventsSeen`), the live fact entries after the run (`entries`),
    and the ratio of user characters to raw event characters.
- **Output.** A per-config table, written to
  `results/prompt-volume-<gitDescribe>.json` only when
  `BENCH_WRITE_RESULTS=1`.
- **Baseline.** Totals are compared against a committed
  `fixtures/promptVolume/baseline.json`. The test fails if any config's
  total user characters, system characters or calls, or any single call
  site's, rise more than 10% above baseline. Drops pass. To stop a run
  that silently stopped producing facts from passing as a drop, `entries`
  and the set of call sites are pinned exactly, along with `eventsSeen`.
  (Revised 2026-11-10 after the PR #357 review.) (Revised 2026-11-10: the first draft also
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
- **Log.** Per candidate: neighbour ids, titles and cosines; the title
  Jaccard against the best neighbour; the decision;
  and the margin to the nearest threshold.
- **Expected labels.** The labels come from `expectedClass`
  (`src/calibrate.ts`). The test asserts every row matches, except an
  explicit `KNOWN_MISROUTES` list naming the rows that misroute today
  (expected: the 2 rows in `calibration-7.7.7.json`). A fix that corrects
  a known row must remove it from the list, and a new misroute fails.
- **Margins.** Margins are printed so a threshold change shows its
  headroom.
- **`bench calibrate`.** It keeps its CLI role and reads the same sidecar.
  The switch is wired in `src/cli.ts`; `src/calibrate.ts` itself is
  unchanged.

### §5 Retrieval miss attribution (`__tests__/retrievalAttribution.test.ts`)

- **Data.** SciFact and FinanceBench, read from
  `packages/integration/fixtures` by relative path, as benchmarks already
  reaches into `../core/src`.
- **Query embeddings.** New committed sidecars,
  `fixtures/retrieval/{scifact,financebench}-query-embeddings.json.gz`,
  built by `src/retrieval/buildQueryEmbeddings.ts` (local fastembed). The
  test then needs no fastembed and no network.
- **Modes, as built.** The suite ranks each query three ways:
  - **keyword-only**: `hybridWeight: 0`, which skips embedding;
  - **the shipped default**: `hybridWeight` unset, which is pure vector
    search (core `types.ts` WikiConfig.hybridWeight). Weight 1 is the same
    mode, so no separate "vector-only" run is needed;
  - **a 0.5 blend**: `hybridWeight: 0.5`, the hybrid point.
- **Miss classes.** These are defined against the 0.5 blend, so any blend
  hit counts as `hit`:
  - `keyword-miss`: the blend and keyword-only both miss, the default hits;
  - `vector-miss`: the blend and the default both miss, keyword-only hits;
  - `fusion-demotion`: the blend misses while both single modes hit;
  - `both-miss`: all three miss;
  - `unscorable`: no gold id exists in the corpus.
- **`rescuedByKeyword`.** A separate count of queries where the default
  misses and keyword-only hits. The classes cannot show these.
- **Output.** Per-class counts, `rescuedByKeyword`, and `worst`, written as
  a JSON report (same `BENCH_WRITE_RESULTS` rule). `worst` is the first 10
  scorable queries the shipped default misses, in fixture order. It is a
  sample for inspection, not a ranking.
- **Guards.** These live in `fixtures/retrieval/guards.json`:
  - the default-mode metric is pinned at measured minus 0.02;
  - each miss-class count, and `rescuedByKeyword`, is pinned at measured
    plus 3 as an upper bound. `hit` is not pinned, because more hits is an
    improvement;
  - `corpusEmbeddingsSha256` pins the integration corpus embeddings the
    query sidecars were built against, so a re-embedded corpus fails
    loudly.

  `BENCH_UPDATE_BASELINE=1` regenerates each dataset's guard before its
  guard tests run, so an update needs only one pass.
- **Sidecar misses fail loudly.** Both `attribute()` and the generator
  record embed failures and throw, because core's `read()` would otherwise
  fall back to keyword search silently.

(Revised 2026-11-10, after the CodeRabbit review on PR #357. The first
draft listed a separate vector-only mode and a "default hybrid blend",
which `RetrievalService` does not have.)

The slack guards in `packages/integration` stay as they are; this suite
is the tight one.

### Out of scope

- Option 2 (answer-turn tracing and recorded model responses): next spec.
- Any core behavior change, including the legacy-deferred window, which
  is reported here and fixed separately if confirmed.
- Running the heavy benchmarks.
- Mining old `benchmark-results` JSON files: they hold aggregates only.

## Findings from the first runs (2026-11-10)

These came from the suites in this spec, at zero tokens. They are
recorded here because the ledger is deleted at merge. Fixes to core are
out of scope for this spec.

1. **ops + `maintenance: 'auto'` permanently skips the first auto batch on
   a fresh entity.** This is a core bug, confirmed by the whole-branch
   review.
   - `WriteService.write` sets `memory_checkpoint` to the write count inside
     the trigger transaction (`WriteService.ts:115` on the count path,
     `:126` on the token path), before the pass runs.
   - `runOpsLibrarianPass` then calls `seedWatermark`. That call goes to
     `seedLibrarianWatermark` (`MaintenanceService.ts:760-768`), which is
     meant for migrating legacy databases. It finds no watermark and
     anchors at event 20.
   - The first `autoLibrarianThreshold` events are never extracted, and a
     later `runLibrarian` does not recover them.
   - Reproduced with the real clock. The 8.0.0 default (ops + deferred) is
     not affected.
   - The prompt-volume baseline pins ops-auto `eventsSeen` at 40, so a fix
     will flip that test.
2. **legacy + deferred reads only the newest 50 events** (`legacy.ts:35`).
   On the 60-event stream it saw 50 of 56 distinct summaries: 6 were never
   read, and 4 others survived only as later restatements. After the §2.1
   fix, the LongMemEval legacy-deferred cell reproduces this loss
   faithfully.
3. **Legacy prompt volume (engineering signal, not a cost claim).**
   - With the scripted provider, legacy-auto sent 75,857 user characters
     in 3 calls, about 20x the raw event text. ops-deferred sent 8,175 in
     3 calls.
   - The one-fact-per-event script inflates legacy's fact-row context, so
     treat 20x as an upper figure.
   - These are characters sent under a scripted model, not billed tokens.
     They say nothing about cost or accuracy under a real model.
   - INTENT rule 11 still bars publishing any cost comparison of the 8.0.0
     defaults from these figures. Use them only to find where prompt
     volume goes and to catch regressions.
   - Do not quote the ops-auto figure at all, because finding 1 depresses
     it.
4. **The gate's duplicate threshold has almost no headroom.**
   - At production thresholds the real gate misroutes the same 2 rows that
     calibration found (`mixed-1::1`, `mixed-1::2`). Both are safe-direction
     errors: one extra resolve item each.
   - `job-1` sits 0.0015 below `dupThreshold` (cosine 0.8885 against 0.89).
   - Three true duplicates clear it by only 0.009 to 0.028.
   - The novel side has no data. The lowest best cosine across all 36
     rows is 0.658, against `novelThreshold` 0.30, so no row is gated to
     ADD at production thresholds. The only ADD-labelled rows are the two
     known misroutes. The 0.30 value is untested by this fixture; adding
     clearly novel candidates to the scenarios would cover it.
5. **Retrieval.**
   - With `hybridWeight` unset, the shipped default is pure vector search.
     The integration reports call it "hybrid".
   - Default NDCG@10 is 0.7200 on SciFact and MRR@10 is 0.7017 on
     FinanceBench, reproducing the integration figures.
   - Keyword-only gives 0.6917 and 0.4367. A 0.5 blend gives 0.7170 and
     0.5135.
   - Keyword rescues: keyword-only finds the gold document that the
     default misses on 18 SciFact queries and 1 FinanceBench query
     (`rescuedByKeyword`). The blend keeps all of those rescues.
   - Blend losses: the blend also pushes gold documents that the default
     found out of the top 10, on 18 SciFact and 24 FinanceBench queries
     (`keyword-miss`).
   - Net effect: on SciFact the blend loses 18 and rescues 18, a wash
     (-0.003 NDCG). Only FinanceBench gets clearly worse (MRR 0.70 to
     0.51).
   - (Corrected 2026-11-10 after the PR #357 review. The first draft said
     keyword never rescues a vector miss. The miss classes cannot show
     that, because any blend hit counts as `hit`.)
   - Hard misses: 25 on SciFact and 2 on FinanceBench.

## Known limitations (deferred review minors)

These were found in review and deliberately left for later:
- **`eventsSeen` counts distinct summaries.** The stream's 4 restatements
  are byte-identical, so the denominator is 56, not 60.
- **Some retrieval guards are slack.** Miss classes measured at 0 get +3
  slack, and `unscorable` only fires when every gold id is missing.
- **Only the default-mode retrieval metric is guarded.** Keyword-only and
  the blend are reported but not guarded.
- **`SteppingDate` has gaps.** While it is installed, a `Date` created
  before installation is not `instanceof Date`, and `Date()` without `new`
  throws. Core uses neither today.
- **Core time budgets count clock reads.** Under the stepping clock,
  `monotonicNow()` budgets expire after N clock reads, not N ms. Revisit
  this before Option 2's replays.
- **One determinism test can leak the fake clock.** `restore puts globals
  back` has no try/finally. File isolation keeps the leak inside that file.
- **One test writes into `.cache/`.** The `promptVolume` bad-stream
  fixture goes into the gitignored `.cache/`, not a temp directory.
- **The legacy estimate is calibrated on one stream.** The 700-char fact
  row is about 560 chars of row metadata plus a title and body of about
  65 chars. Real fact bodies are longer, so the estimate's fact-row cost
  runs low. Assuming one fact per turn runs high, which roughly offsets
  it. The ±25% test is a regression pin, not independent validation.
- **The retrieval modes share access counts.** The three reads per query
  each call `trackAccess`, and `access_count` is a ranking tie-break. The
  results are deterministic, but the modes are not fully independent.

## Files touched

- New: `packages/benchmarks/src/determinism.ts`, `src/scriptedProvider.ts`,
  `src/gate/buildEmbeddings.ts`, `src/retrieval/buildQueryEmbeddings.ts`,
  `src/retrieval/attribution.ts`, and the three `__tests__` suites with
  their fixtures.
- Changed: `src/longmemeval/ingest.ts`, `src/supersession/run.ts`,
  `src/cli.ts` (including the `bench calibrate` switch to the gate sidecar), `src/report.ts`, `README.md`,
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
