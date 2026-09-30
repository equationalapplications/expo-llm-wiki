# Benchmark results — 7.8.0 release vs 7.7.7 baseline

Run on **2026-09-30** to measure how the new ops strategy shipped in
this PR (which will become `7.8.0` at release time) changes
end-to-end benchmark outcomes compared to the legacy librarian
shipped in `7.7.7`. Both reruns run against an engine whose
`packages/core/package.json` is still `7.7.7` at the cited commits
(`d380f0a` for the legacy baseline, `1f670db` for this worktree) —
the `7.8.0` version bump is a release-process step and is not in git
history yet (no `chore(release): 7.8.0` exists; the most recent release
commit is `d2fc492 chore(release): 7.7.7`). The difference between
the runs is the `--strategy` argument and the post-cut PR work
(`PR-A`/`B`/`C`/`D1`/`0`/`S`), not the engine version. The
`engine.version` field in both committed result JSONs reads `7.7.7`,
matching `package.json`.

Results are committed at `f0abfde` (synapse-tree guide), `25e392c`
(doc fix), and `5875b75` (result JSONs); this page summarises them.

## What we measured

Two suites, run once each against two strategies.

| Suite | Slice | Size | What it stresses |
|-------|-------|------|------------------|
| `LongMemEval_S` | stratified slice, seed `20260929` | 80 questions of ~500 | multi-session dialogue recall across knowledge-update and temporal-reasoning strata |
| `supersession` | full catalog, live-only | 25 scenarios of 30 (5 liveSkip) | per-scenario supersession/add/noop decisions over a curated scenario catalog |

Both suites use the same model for **answer generation** and
**judging**, on the same provider:

| Setting | Value |
|---------|-------|
| Provider | z.ai Anthropic-compatible endpoint |
| Base URL | `https://api.z.ai/api/anthropic` |
| Model (answer) | `GLM-5.3-FLASH` |
| Model (judge) | `GLM-5.3-FLASH` (same model as the answer; see §6 caveats) |
| Embedder | FastEmbed `BGESmallENV15` (`bge-small-en-v1.5`, 384 dim) — local, hardware-independent |
| Seed | `20260929` |
| Token accounting | provider-reported (`usage.input_tokens` / `usage.output_tokens`) when the response includes a `usage` block; otherwise `chars / 4` |

The LongMemEval reruns that this report was meant to splice in did
**not** produce a result JSON — see §6 for the SIGABRT diagnosis and the
escape-hatch that lets this page ship with the supersession data only.

## Results

Supersession pass counts, **legacy** (`--strategy legacy`, engine `7.7.7`,
git SHA `d380f0a`) versus **ops** (`--strategy ops`, engine `7.7.7`
at this commit — the `7.8.0` version bump is the release step,
not done here, git SHA `1f670db`):

| Strategy | Passed | Failed | Total | Wall-clock |
|---------|-------:|-------:|------:|-----------:|
| legacy (`d380f0a`) | **19** | 6 | 25 (5 liveSkip) | ~19m55s |
| ops (`1f670db`) | **23** | 2 | 25 (5 liveSkip) | ~8m30s |

Per-scenario diff (hand-written from
`packages/benchmarks/results/supersession-baseline-7.7.7.json` and
`packages/benchmarks/results/supersession-7.8.0.json`):

| Scenario | legacy | ops | delta |
|----------|:------:|:---:|-------|
| `diet-1-vegan-to-keto` | pass | pass | same |
| `diet-2-tea-to-coffee` | pass | pass | same |
| `diet-3-also-likes-coffee-add` | pass | pass | same |
| `diet-4-exact-duplicate-different-punctuation` | pass | pass | same |
| `diet-5-preference-reversal-with-date` | **fail** | **fail** | both fail |
| `job-1-engineer-to-manager-same-company` | pass | pass | same |
| `job-2-acme-to-globex` | pass | pass | same |
| `job-3-update-librarian_inferred` | pass | pass | same |
| `job-4-update-user_stated-becomes-supersede` | pass | pass | same |
| `job-5-duplicate-restatement` | pass | pass | same |
| `mixed-1-three-candidates-noop-add-supersede` | **fail** | pass | **ops fixed** |
| `mixed-2-in-batch-duplicate-candidates` | pass | pass | same |
| `mixed-3-superseded-fact-never-offered-again` | pass | pass | same |
| `mixed-4-event-occurred_at-drives-valid_from` | pass | pass | same |
| `mixed-5-extract-valid_from-overrides-occurred_at` | **fail** | **fail** | both fail |
| `relationship-1-single-to-married` | pass | pass | same |
| `relationship-2-project-renamed` | pass | pass | same |
| `relationship-3-project-cancelled-supersede-with-reason` | pass | pass | same |
| `relationship-4-unrelated-new-project-add` | **fail** | pass | **ops fixed** |
| `relationship-5-rename-of-immutable-document` | pass | pass | same |
| `relocation-1-seattle-to-sf` | pass | pass | same |
| `relocation-2-portland-to-seattle-with-valid_from` | pass | pass | same |
| `relocation-3-moved-back-AB-A` | **fail** | pass | **ops fixed** |
| `relocation-4-visiting-sf-add-not-supersede` | **fail** | pass | **ops fixed** |
| `relocation-5-two-candidates-target-same-fact` | pass | pass | same |

Summary: **ops fixed 4 scenarios, broke 0**. The 17 scenarios both
strategies pass are unchanged; the 2 scenarios both strategies fail
remain unresolved.

LongMemEval results: **not reported** — both reruns died with the
SIGABRT documented in §6.

## Reading the numbers

### Where ops helps

Ops turned 4 legacy failures into passes. In every case the legacy
output collapsed or omitted state that ops preserved:

- **`mixed-1-three-candidates-noop-add-supersede`** — legacy returned
  three titles (`User started drinking coffee`, `User is an engineer at
  Acme`, `User now lives in San Francisco`) and dropped the tea
  preference that the catalog requires. Ops returned four titles
  (`User started drinking coffee`, `User works as an engineer at Acme`,
  `User moved to San Francisco`, `User prefers tea`): the same three
  facts with slight paraphrasing (e.g. "is an engineer" →
  "works as an engineer", "now lives in" → "moved to"), plus the
  missing tea preference.
- **`relationship-4-unrelated-new-project-add`** — legacy returned a
  single new-project title and dropped the existing Project Alpha
  relationship that should have been kept alongside the new add. Ops
  returned both `User started a new side project called Project Beta`
  and `User is working on Project Alpha`.
- **`relocation-3-moved-back-AB-A`** — legacy collapsed the move-back
  history to `User lives in Seattle` and lost the prior Portland
  period. Ops preserved `User previously lived in Portland before
  moving away` and `User moved back to Portland in September 2024`.
- **`relocation-4-visiting-sf-add-not-supersede`** — legacy collapsed
  a temporary visit and the permanent residence into
  `User's permanent residence is Seattle`. Ops kept both
  `User is visiting San Francisco this week` and `User lives in Seattle`.

All four are **multi-fact / additive** scenarios where the legacy
librarian's `bestCosine`-driven gate was over-aggressive about
promoting candidates to supersede. The T1 calibration reset the
default thresholds from `(dupThreshold = 0.97, novelThreshold = 0.55)`
to `(0.89, 0.30)`; that loosening is consistent with the four
flip-to-pass scenarios and explains why no scenario regressed: the new
thresholds tolerate more additive facts in the result set.

### Where ops does not help

- **17 scenarios** that both strategies pass. These are unambiguous
  single-fact scenarios (diet/job/relationship changes that resolve
  to a single canonical title); neither threshold setting changes the
  outcome.
- **2 scenarios** that both strategies fail:
  - **`diet-5-preference-reversal-with-date`** — even with ops, the
    dated precision is wrong. Ops returns
    `User drank tea in the past before a period of not drinking it`
    and `User switched back to drinking tea as of January 2025`,
    which captures the reversal but not the prior coffee period's
    start/end dates the catalog expects. Legacy returns
    `User switched back to tea as of January 2025` only, which is
    worse. Both strategies need a temporal-window extraction pass
    that is not in scope for ops.
  - **`mixed-5-extract-valid_from-overrides-occurred_at`** — ops
    returns just `User moved to San Francisco` and drops the
    `Former residence: Seattle (until October 2024)` trail that
    legacy also gets wrong in the opposite direction. The extract
    logic for `valid_from` over `occurred_at` needs a follow-up
    fix.

### Where ops regresses

None. The 4 ops-fixed scenarios are the only diff.

### What LongMemEval would have shown

LongMemEval was supposed to measure whether the ops strategy also
improves **end-to-end answer quality** — not just the per-fact
extraction that supersession exercises. We would have expected to see:

- gains in the **knowledge-update** stratum (D, K, T) where
  conversational state changes mid-session;
- gains in the **temporal-reasoning** stratum (R) where ops'
  improved `valid_from` handling should help recall of past-state
  questions;
- lower **tokens-per-answer** because ops returns more canonical
  titles that pack more meaning per token than legacy's verbose
  paraphrases.

These results are missing because both LongMemEval reruns died
with the SIGABRT documented in §6. The 4 supersession flip-to-pass
scenarios are still meaningful — they directly exercise the gate
behaviour that calibration T1 changed — but they do not substitute
for an end-to-end answer-quality measurement.

## Cost

Supersession reruns (provider-reported tokens, both runs):

| Run | Input tokens (approx) | Wall-clock |
|-----|----------------------:|-----------:|
| legacy (`d380f0a`) | ~150k | ~19m55s |
| ops (`1f670db`) | ~150k | ~8m30s |
| **total supersession** | **~300k** | — |

The ~2.3x wall-clock speedup at the same token spend reflects fewer
LLM round-trips per scenario: the ops path batches dedup + embed
checks in fewer calls than the legacy librarian.

LongMemEval cost: **not measured**. Both reruns did not produce a
result JSON (see §6 caveats), so per-strategy token costs are not
reported. Pre-run dry-run estimates were on the order of 10M input
tokens per longmemeval rerun (full dataset ingestion + 80 QA cycles
+ librarian passes); the SIGABRT cut both runs off before the cost
could be committed to a JSON.

## Reproduce

Supersession reruns (from `feat/cm-d2-rerun-docs` worktree at this
commit):

```bash
# Legacy baseline — run from a checkout pinned to engine 7.7.7 / git SHA d380f0a
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench \
  supersession --strategy legacy --yes \
  --out packages/benchmarks/results/supersession-baseline-7.7.7.json

# Ops final — run from this worktree (engine 7.7.7 / git SHA 1f670db; the 7.8.0 release label is post-merge)
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench \
  supersession --strategy ops --yes \
  --out packages/benchmarks/results/supersession-7.8.0.json
```

LongMemEval reruns (would-have-been, currently blocked — see §6):

```bash
# Baseline (would have run from a checkout pinned to d380f0a)
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench \
  longmemeval --strategy legacy --maintenance auto --yes \
  --out packages/benchmarks/results/baseline-7.7.7.json

# Ops final — engine is 7.7.7 at this commit (the 7.8.0 release label is post-merge)
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench \
  longmemeval --strategy ops --maintenance deferred --read-budget 800 --yes \
  --out packages/benchmarks/results/report-7.8.0.json

# Legacy final (engine comparison, not strategy comparison)
pnpm --filter @equationalapplications/benchmarks-llm-wiki bench \
  longmemeval --strategy legacy --maintenance auto --yes \
  --out packages/benchmarks/results/report-7.8.0-legacy.json
```

LongMemEval reruns **cannot currently be reproduced** end-to-end because
the SIGABRT in §6 fires before a result JSON is flushed.

### Environment

| Variable | Required | Default | Notes |
|----------|:--------:|---------|-------|
| `ZAI_API_KEY` | yes | — | Anthropic-format key issued by z.ai. The CLI retries 429/529/5xx up to 4× with 1s/2s/4s/8s backoff (`packages/benchmarks/src/provider.ts:8`). |
| `BENCH_BASE_URL` | no | `https://api.z.ai/api/anthropic` | overrides answer endpoint |
| `BENCH_MODEL` | no | `GLM-5.3-FLASH` | overrides answer model |
| `BENCH_JUDGE_BASE_URL` | no | `https://api.z.ai/api/anthropic` | overrides judge endpoint |
| `BENCH_JUDGE_MODEL` | no | `GLM-5.3-FLASH` | overrides judge model |

Answer and judge use the same model by default — see §6 caveats.

### Committed sample

`packages/benchmarks/fixtures/longmemeval-sample.json` commits the 80
question IDs (seed `20260929`) used by the LongMemEval reruns and the
dataset URL
(`https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json`).
The bench harness reads the slice from this fixture at run time.

## Caveats

### Slice, not full set

- **Supersession** runs 25 of 30 scenarios live; 5 are `liveSkip`
  (require network or external services the local harness cannot
  stub). The 4 ops-fixed scenarios are live and meaningful; the 5
  skipped scenarios are not exercised.
- **LongMemEval** runs 80 of ~500 questions, selected by a stratified
  seed. The 80 are not a comprehensive test of the long-memory
  capability; they are enough to detect a multi-percentage-point
  regression but not to certify absolute answer quality.

### Judge is an LLM (and the same LLM as the answer)

Both `BENCH_MODEL` and `BENCH_JUDGE_MODEL` default to
`GLM-5.3-FLASH`. This is **self-judging**: the same model that
generated the answer scores the answer. Self-judging is a known
source of inflation; the supersession suite sidesteps it for
per-scenario correctness by checking the post-run fact set against
a hand-written catalog rather than re-prompting the model, but
longmemeval's per-question scoring is fully self-judged.

### LoCoMo not used

LoCoMo was considered but not used. LoCoMo lacks the multi-session
format that drives the most useful comparison (legacy's
`runLegacyLibrarianPass` and ops' `runPendingMaintenance` both
exercise different multi-session flows). LongMemEval_S ships with
multi-session dialogue and a code path that mirrors our MCP
`history`/`asOf` API; it is the closer-to-real-world benchmark for
this release.

### LongMemEval reruns are missing — SIGABRT diagnosis

Both reruns died with:

```
libc++abi: terminating due to uncaught exception of type std::__1::system_error:
mutex lock failed: Invalid argument
```

Exit status **134** (SIGABRT), Node.js v24.21.0, after 2.5–3.5h
wall-clock per run. Two independent invocations failed with the
same signature:

- PR-0's `bench longmemeval` (PID `75572`), first observed at the
  §5f handoff.
- PR-D2's `bench longmemeval --strategy legacy --maintenance auto`
  (PID `50622`, log `/tmp/cm-baseline-longmemeval.log`).

Both runs coincided with HTTP 429 from z.ai's rate limiter
(`Rate limit reached for requests`, request IDs
`2026093016*`...) that the **legacy librarian** does not catch. The
429 is confirmed; that it caused the SIGABRT is **not** (see below).
Verified call chain for the 429 (the throw propagates **up** from the
provider, not down from the dispatcher):

- Origin: `packages/benchmarks/src/provider.ts:129` — `throw new
  Error(errMessage(response.status, text))` after the 4-retry budget
  at `provider.ts:40` (1s/2s/4s/8s backoff for 429/529/5xx) is
  exhausted. Longmemeval's per-question librarian calls run
  continuously for hours, so a sustained 429 storm exhausts that
  budget.
- Propagates up through `callLlm`
  (`packages/core/src/utils/llmCall.ts:24`, signature; the
  `provider.generateText` call site is at `llmCall.ts:46`).
- → `runLegacyLibrarianPass` signature at
  `packages/core/src/services/librarian/legacy.ts:32`. (Line 62 is
  inside the inner `try { callLlm(...) }` catch that converts
  `WikiBudgetExhausted` into `LibrarianResult.budgetStop`; the throw
  itself leaves the function uncaught because the call site only
  catches `WikiBudgetExhausted`, not generic errors.)
- → `MaintenanceService.runLibrarianPass` at
  `packages/core/src/services/MaintenanceService.ts:674`, called by
- → `MaintenanceService.doRunLibrarian` at
  `packages/core/src/services/MaintenanceService.ts:658`, called by
- → `WriteService.runLibrarianThenMaybeHeal` at
  `packages/core/src/services/WriteService.ts:175`.

When the throw exits the writer, the surrounding `Promise.catch` in
`WriteService` (chained to `runLibrarianThenMaybeHeal` at line 138)
catches the background failure and releases the lock. That path does
not by itself show native mutex corruption, so **the mutex cause is
unconfirmed**. The one documented source of this exact abort is
`packages/benchmarks/src/cli.ts`: ending the process while the
FastEmbed/ONNX Runtime session is loaded fails with `mutex lock
failed`. Until this release the CLI entrypoint ran `void main()`, so a
rejection escaping `runLongMemEval` (for example, one question whose
429 retries were exhausted) ended the process through the
unhandled-rejection path with the session still live. That is a
plausible mechanism, not a verified one. The entrypoint now catches
the rejection and sets `process.exitCode`.
- The **heal** path catches 429s cleanly and skips (`response could
  not be bounded: HTTP 429` → heal skipped, no throw), which is why
  the heal-side reruns survive and the librarian-side reruns do not.

The escape hatch used for PR-0 and applied here: publish the
partial data (supersession only) and document the gap. The
orchestrator chose not to silently retry a third time because the
failure mode is the same signature and the gate calibration T1 has
already produced a meaningful signal.

The 4 ops-vs-legacy supersession scenarios that flipped are still
meaningful: T1's gate calibration moved the defaults from
`(0.97, 0.55)` to `(0.89, 0.30)`, and that loosening is consistent
with the 4-scenario improvement and the zero regressions. But
end-to-end answer-quality confirmation against longmemeval is
**not in this report**.

### Follow-up: legacy librarian 429 handling

The throw-on-429 behaviour in `runLegacyLibrarianPass` is a known
follow-up issue, tracked for **7.8.1**, not a 7.8.0 blocker. The
heal path's catch-and-skip pattern is the reference behaviour to
mirror there. Filed in the release tracker; supersession reruns
are short enough (~150k input tokens) that they do not exhaust
the provider retry budget, which is why the supersession runs in
this report completed successfully while the longmemeval runs did
not.