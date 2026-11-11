# @equationalapplications/benchmarks-llm-wiki

Benchmarks for `@equationalapplications/core-llm-wiki`: a LongMemEval slice
(80 questions) and a 30-scenario supersession suite, run live against a chat
endpoint through the wiki engine.

This package is **private** (`"private": true`) and never published or
versioned. It exists to produce the measured baseline reports committed under
`results/` — **numbers are published as measured**: nothing here is tuned,
cherry-picked, or re-run until a nice number appears. A report is the record
of one run, pinned to the engine version and git SHA it was produced from.

## What is benchmarked

| Suite | Size | What it measures |
|---|---|---|
| LongMemEval slice | 80 questions | End-to-end memory: ingest a haystack of sessions, answer a question from the retrieved memory, judge the answer with an LLM judge |
| Supersession suite | 30 scenarios | Fact updates: seed existing facts, replay events, check the engine supersedes stale facts and keeps current ones current |

### LongMemEval stratification

The slice is a seeded, stratified sample of the LongMemEval_S dataset
(`seed: 20260929`; the committed `fixtures/longmemeval-sample.json` holds the
exact question ids):

| Stratum | Target |
|---|---|
| knowledge-update | 20 |
| temporal-reasoning | 20 |
| multi-session | 15 |
| single-session-user | 9 |
| single-session-assistant | 8 |
| single-session-preference | 8 |
| **Total** | **80** |

The targets are fixed by `STRATA` in `src/longmemeval/sample.ts`; the seeded
sampler fills as many of each as the dataset provides. Abstention questions
(`question_id` ending `_abs`) are excluded entirely. The committed
`fixtures/longmemeval-sample.json` carries the actual question ids picked at
`seed = 20260929`.

**Attribution.** The judge templates are adapted from the public LongMemEval
repository's `evaluate_qa.py` (including the temporal off-by-one and
knowledge-update allowances). LoCoMo is **not** used — its license is
CC BY-NC, which is incompatible with this repo.

## Diagnostics suites (zero tokens)

These three suites run inside `pnpm test`. They make no network calls and
no LLM calls, and they open only in-memory SQLite. Each one points at a
specific stage instead of reporting one score. See
`specs/targeted-diagnostics/spec.md`.

| Suite | What it tells you | Pinned against |
|---|---|---|
| `__tests__/promptVolume.test.ts` | Calls and prompt characters per call site for legacy/ops × auto/deferred on a fixed 60-event stream, plus how many distinct events each config's librarian actually saw. | `fixtures/promptVolume/baseline.json`: fails on a rise of more than 10% in total or per site. |
| `__tests__/gateDecisions.test.ts` | Core's real `gateCandidates` at production thresholds on every supersession scenario: decision, neighbours, cosine, and margin to the nearest threshold. | Calibration labels from `src/calibrate.ts`, with known misroutes listed explicitly. |
| `__tests__/retrievalAttribution.test.ts` | For SciFact and FinanceBench, the gold rank under keyword-only, the shipped default (pure vector) and a 0.5 blend. Every miss is classified (`keyword-miss`, `vector-miss`, `fusion-demotion`, `both-miss`). | `fixtures/retrieval/guards.json`: metric at measured − 0.02, miss classes at measured + 3. |

The scripted provider (`src/scriptedProvider.ts`) and the determinism harness
(`src/determinism.ts`: stepping clock and seeded ids) make replays
byte-stable. These suites measure prompt **volume**, not billed tokens or
answer accuracy. INTENT rule 11 still applies to any accuracy or cost claim.

After a deliberate change, regenerate:

```sh
# baselines and guards (say why in the commit)
BENCH_UPDATE_BASELINE=1 pnpm --filter @equationalapplications/benchmarks-llm-wiki test __tests__/promptVolume.test.ts
BENCH_UPDATE_BASELINE=1 pnpm --filter @equationalapplications/benchmarks-llm-wiki test __tests__/retrievalAttribution.test.ts
# embedding sidecars (local fastembed ONNX, zero tokens, ~1.5 min)
pnpm --filter @equationalapplications/benchmarks-llm-wiki fixture:gate-embeddings
pnpm --filter @equationalapplications/benchmarks-llm-wiki fixture:retrieval-queries
```

Set `BENCH_WRITE_RESULTS=1` to write a report to `results/`, named by `git describe`.

## Commands

All commands run from the repo root (or anywhere — paths are resolved
relative to the repo root):

```sh
# One-time: download the dataset (gitignored cache) and write the sample fixture
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench sample --seed 20260929

# Print the cost estimate without spending anything (exit 0, no API key needed)
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench longmemeval --strategy legacy --maintenance auto --dry-run

# Full LongMemEval run (spends tokens; the estimate is printed first)
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench longmemeval --strategy legacy --maintenance auto --yes --out packages/benchmarks/results/baseline-7.7.7.json

# Supersession suite
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench supersession --strategy legacy --yes --out packages/benchmarks/results/supersession-baseline-7.7.7.json
```

Every live command prints a one-screen estimate (engine, flags, models,
question/scenario count, input-token estimate) and **refuses to run without
`--yes`**. `--dry-run` prints the same estimate and exits before resolving
any credentials. No live API call ever runs under `pnpm test` — the unit
suites use fakes only.

Other flags: `--max-questions <n>` caps the question list (smoke tests),
`--read-budget <n>` sets the read-side token budget, `--out <file>` sets the
report path (default: `results/raw/<suite>-<version>-<flags>-<timestamp>.json`,
which is gitignored).

The dataset is downloaded at run time into
`packages/benchmarks/.cache/longmemeval_s.json` (gitignored; never
committed). Per-question ingest caches live under the same `.cache/` dir, so
an interrupted run resumes cheaply: re-running skips questions whose ingest
cache is already complete (`cached ingests` in the printed estimate).

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `BENCH_PROTOCOL` | `anthropic` | `anthropic` (Messages API) or `openai` (chat completions) |
| `BENCH_BASE_URL` | `https://api.z.ai/api/anthropic` | Base URL for answer + ingestion |
| `BENCH_API_KEY` | falls back to `ZAI_API_KEY` | API key (at least one of the two must be set for live runs) |
| `BENCH_MODEL` | `GLM-5.3-FLASH` | Model id for answer + ingestion |
| `BENCH_JUDGE_PROTOCOL` / `BENCH_JUDGE_BASE_URL` / `BENCH_JUDGE_API_KEY` / `BENCH_JUDGE_MODEL` | fall back to the `BENCH_*` values above | Judge endpoint — configured separately, and named in every report |
| `BENCH_LONGMEMEVAL_URL` | `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json` | Dataset file |
| `BENCH_CONCURRENCY` | `4` | Questions in flight |

Secrets are read only from environment variables and are never written to
reports, logs, or cache keys.

## Cost

~80 questions × ~115k history tokens ≈ 9M+ ingestion input tokens; expect
roughly $10–40 per full run depending on model pricing; re-judging a cached
ingest is cheap.

## How to read a report

A LongMemEval report (`results/*.json`, kind `longmemeval`) contains:

- `engine` — core version, git SHA of the run, and the engine flags
  (`strategy`, `maintenance`, optional `readTokenBudget`), so a number is
  always pinned to the code that produced it.
- `models` — the answer model, the judge model, and the embedding model
  (`fastembed/BGESmallENV15`). The judge is named in every report.
- `sample` — the seed, question count, and dataset tag.
- `accuracy` — `overall` rate and a per-stratum `byType` breakdown
  (`correct` / `total` / `rate`).
- `tokens` — calls and input/output tokens per call site (ingest, answer,
  judge, other) recorded via the usage instrumentation.
- `retrieval` — mean / p50 / p95 context tokens fed to the answer prompt.
- `latencyMs` — ingest and answer p50/p95.
- `cachedIngests` — how many questions reused a complete ingest cache.
- `questions` — per-question `id`, `type`, `correct`, `contextTokens`.

A supersession report (kind `supersession`) contains `strategy`, `passed` /
`total` / `skipped` (the 5 model-misbehaviour scenarios are `liveSkip` in
live mode and run only in PR-B's replay suite), and per-scenario `results`
with the fact titles that were current after the replay plus an `error`
field when a scenario threw. A scenario **passes** when every expected
current title is contained (case-insensitively) in some current fact's title
**and** no `expectSuperseded` id is still current.

**Stale caches (2026-11-10).** Before the spec targeted-diagnostics §2.1
fix, a `legacy-deferred` LongMemEval ingest actually ran legacy-auto writes.
It is still filed under the same cache key, so delete
`.cache/ingest/*/legacy-deferred/` before reusing any such cache.

**Errata (2026-11-10).** `results/supersession-7.8.0.json` ran on the 7.8.0
code but records `engine.version: "7.7.7"`: `engine.version` is core's
`package.json` version, which semantic-release bumps only at release. Use
`gitSha` (and, from 2026-11-10, `gitDescribe`) to identify the code that ran.
Supersession reports written before 2026-11-10 also ran heal for legacy only;
newer reports run `librarian+heal` for both strategies
(`engine.flags.sequence`), so the two are not directly comparable.

To re-read the committed baselines without an API key (the LongMemEval
baseline is not committed yet; see issue #247):

```sh
jq '{passed, total, skipped}' packages/benchmarks/results/supersession-baseline-7.7.7.json
```
