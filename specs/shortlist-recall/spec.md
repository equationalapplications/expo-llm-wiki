# Spec: PR 2a — Shortlist builder + `shortlist-recall` benchmark subcommand

Lane 2, wave 1 (unconditional). Author draft, 2026-11-20. Base: `origin/main` @ `e43095c8` (the only commits after `9790dbbf` are dependency-only; every pin below re-verified live against `e43095c8`).

## Problem

The ontology backfill prompt carries a TITLE CATALOG of typed nodes. The
catalog lists every typed node, sorted, capped at 200 entries and 8000 chars
(`packages/core/src/prompts.ts:75`, `packages/core/src/prompts.ts:98`).
The catalog is prompt context, not a ranked target pool. Dense memories fill
the cap with irrelevant titles. The host model must find the right
`target_title` inside up to 200 lines of text. The owner ruled this data
scope acceptable as temporary on 2026-11-19 (commit 095b564b).

A per-fact shortlist fixes the cap problem: rank the typed nodes against the
fact, keep the top k. But the shortlist is deterministic code. Its recall
caps every host model: if the true target is not in the top k, no model can
name it from the prompt. Before any PR narrows the catalog to shortlist
scope, the recall must be measured. Today no such benchmark exists.

## Root cause

`buildTitleCatalogBlock` sorts typed nodes by title in UTF-16 code-unit order
(`packages/core/src/prompts.ts:91-94`). The order has no relation to the
fact being classified. The caller reads all typed rows in one index pass and
builds one catalog per backfill pass
(`packages/core/src/services/MaintenanceService.ts:2111-2126`, method
`doRunOntologyBackfill`). Nothing scores rows against individual facts.

Evidence: the shipped all-typed-nodes catalog has never been benchmarked.
The 0/28 → 28/28 E1 result measured a seed-only catalog variant through a
runner-level prompt override
(`packages/core/src/services/MaintenanceService.ts:2103-2107`; result file
`packages/benchmarks/results/statement-kinds-e1-title-catalog-2026-11-18.json`).
INTENT Rule 11
says benchmarks back claims. The follow-up PR that swaps the catalog for a
shortlist needs a recall number first, or its claim has no support.

## Proposed change

### 1. Shortlist builder in core (new pure module)

Add `packages/core/src/utils/shortlist.ts`. Export:

- `shortlistScore(factTitle, factBody, rowTitle)` — returns a number.
  Score a typed-node title against a fact using `titleTokens` and
  `jaccardScore` (`packages/core/src/utils/pure.ts:918`,
  `packages/core/src/utils/pure.ts:922`). Lexical only: core has no
  embedding provider of its own, and the module must stay pure.
- `buildShortlist(fact, rows, k, score?)` — returns the top k rows,
  highest score first. Ties break by the same UTF-16 title order the
  catalog uses, so results stay deterministic across runtimes. The optional
  `score` function lets a caller inject an embedding-based scorer. The
  benchmark injects one; core does not.

The module must not import fastembed. `packages/core/package.json` has no
fastembed dependency; keep it that way.

### 2. `shortlist-recall` benchmark subcommand

Add `packages/benchmarks/src/shortlistRecall.ts` and wire a new
`shortlist-recall` subcommand into `packages/benchmarks/src/cli.ts` in the
hand-rolled dispatch chain (`packages/benchmarks/src/cli.ts:950-1010`) plus
the help text (`packages/benchmarks/src/cli.ts:1024`). This PR owns the
`cli.ts` wiring (plan Y8: 2a is the only Lane 2 wave-1 PR allowed to edit
`cli.ts`).

The subcommand:

1. Loads the committed 28-entry fixture
   `packages/benchmarks/fixtures/statement-kinds.json` via
   `loadStatementFixture` (`packages/benchmarks/src/statementKinds/run.ts:69`).
   Each entry carries `expected_target.title` and `expected_target.type`,
   which are the ground truth. The typed-node candidate pool comes from
   `SEED_NODES` (`packages/benchmarks/src/statementKinds/run.ts:42`).
2. Embeds each fact text and each candidate title with the local fastembed
   BGESmallENV15 helper `getEmbedder`
   (`packages/benchmarks/src/embed.ts:26`). Zero LLM token spend.
3. Scores candidates two ways:
   - `lexical`: the core default scorer from step 1.
   - `embedding`: `cosineSimilarity`
     (`packages/core/src/utils/cosine.ts:1`) between fact and title vectors.
   This mirrors the direct core-source-import pattern `calibrate.ts` uses
   (`packages/benchmarks/src/calibrate.ts:23-27`).
4. Computes recall@k for k = 5, 10, 25: a hit means the normalized
   `expected_target.title` equals a shortlisted title under
   `normalizeTitleKey` (`packages/core/src/utils/ontology.ts:13`), the same
   key the catalog dedupes on (`packages/core/src/prompts.ts:82-90`).
5. Prints a summary table and writes a JSON result file to
   `packages/benchmarks/results/shortlist-recall-<stamp>.json` via
   `resolveOutPath` (`packages/benchmarks/src/cli.ts:87-89`). The file
   records engine version, per-k recall per scorer, and per-entry hit/miss,
   so the numbers trace to real runs (INTENT Rule 11).

### 3. What 2a does not do

2a does not touch `MaintenanceService.ts`, `PromptService.ts`, or the live
backfill prompt. Wiring the shortlist into the backfill path, the
`shortlistK` config knob, and the errata that supersedes the #425 ruling
all belong to PR 2b. PR 3 consumes 2a's code, not its score.

## Files touched

- `packages/core/src/utils/shortlist.ts` — new pure shortlist builder.
- `packages/core/src/utils/__tests__/shortlist.test.ts` — new unit tests.
- `packages/benchmarks/src/shortlistRecall.ts` — new recall@k runner.
- `packages/benchmarks/__tests__/shortlistRecall.test.ts` — new runner tests.
- `packages/benchmarks/src/cli.ts` — new `shortlist-recall` dispatch branch
  and help line.
- `packages/benchmarks/results/` — new committed result file from the real
  run.

## Test plan

1. Unit tests for `buildShortlist`: top-k order, tie-break determinism,
   k larger than the pool, injected scorer. Run
   `pnpm --filter @equationalapplications/benchmarks-llm-wiki test` and the
   core package test suite. All must pass.
2. CLI tests: the `--dry-run` guard prints the estimate and spends nothing,
   following the statement-kinds guard pattern
   (`packages/benchmarks/src/cli.ts:583-591`).
3. Real benchmark run (the numbers INTENT Rule 11 requires): run
   `pnpm --filter @equationalapplications/benchmarks-llm-wiki bench shortlist-recall --yes`.
   The first run downloads the ~150 MB ONNX model into the package's
   gitignored `.cache` (`packages/benchmarks/src/embed.ts:17`). The run
   costs zero LLM tokens. Commit the JSON result file and quote the
   recall@k numbers in the PR body.
4. Determinism check: run the subcommand twice. Both result files must
   carry identical recall values.

## Out of scope / rejected alternatives

- Wiring the shortlist into the backfill prompt. Rejected: that is PR 2b;
  folding it here blocks wave 1 on scope the plan assigns to 2b.
- The 2b errata amending the #425 temporary data-scope ruling. Rejected
  here: the plan binds the errata to 2b, which owns the ruling change.
- Embedding-based scoring inside core. Rejected: core must not gain a
  fastembed dependency, and BYOI hosts bring their own embedding providers.
  The scorer injection point keeps core pure and hosts in control.
- Recalling against an embedding-only ranking with no lexical baseline.
  Rejected: the lexical baseline shows whether embeddings earn their cost.
- A new fixture for recall. Rejected: the committed statement-kinds fixture
  already carries per-entry ground truth targets; a second fixture adds
  drift risk with no new signal.

## Open questions for the owner

1. Default k. This spec benchmarks k = 5, 10, 25 and proposes k = 10 as the
   2b default. Confirm or pick another default.
2. Scorer choice for 2b: lexical, embedding, or hybrid. The real run's
   recall numbers should drive this; this spec only measures.
3. Whether the recall fixture must also cover memories larger than the
   seed pool (the 200-entry cap regime). The seed pool is 28 nodes, so the
   cap never binds in this benchmark. If the owner wants cap-regime recall,
   2a adds a synthetic pool generator; say so before implementation.
