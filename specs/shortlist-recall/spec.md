# Spec: PR 2a — Shortlist builder + `shortlist-recall` benchmark subcommand

Status: Draft

Lane 2, wave 1 (unconditional). Author draft, 2026-11-20. Base: `origin/main` @ `e43095c8` (the only commits after `9790dbbf` are dependency-only; every pin below re-verified live against `e43095c8`). Review history: a T1.5 self-review (2026-11-20, haiku) and one T3 Opus review (2026-11-20) converged on the pool-size defect fixed below.

## Problem

The ontology backfill prompt carries a TITLE CATALOG of typed nodes. The
catalog lists every typed node, sorted, capped at 200 entries and 8000 chars
(`packages/core/src/prompts.ts:75`, `packages/core/src/prompts.ts:98`).
The catalog is prompt context, not a ranked target pool. Dense memories fill
the cap with irrelevant titles. The host model must find the right
`target_title` inside up to 200 lines of text.

The owner ruled this data scope acceptable as temporary. The ruling is the
#425 ruling, recorded 2026-11-19 in commit `095b564b`. PR 2b owns the
errata that supersedes it.

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

Pool-size fact (drives the design below): `SEED_NODES`
(`packages/benchmarks/src/statementKinds/run.ts:42`) holds 3 nodes. The
committed fixture holds 28 entries, and its loader
(`parseStatementFixture`, `run.ts:57-64`) forces every `expected_target`
to name one of those 3 nodes. Recall@k with k above 3 is vacuous on the
seed pool alone. The benchmark therefore measures against synthetic
distractor pools of realistic size, not the seed pool alone.

## Proposed change

### 1. Shortlist builder in core (new pure module)

Add `packages/core/src/utils/shortlist.ts`. Export:

- `shortlistScore(factTitle, factBody, row)` — returns a number. `factTitle`
  and `factBody` are strings. `row` has the catalog row shape
  `{ title: string; okf_type: string; body?: string }`
  (`packages/core/src/prompts.ts:78`). The score is the Jaccard score
  (`packages/core/src/utils/pure.ts:922`) between the fact token set
  (tokens of `factTitle` plus tokens of `factBody`, each through
  `titleTokens` at `packages/core/src/utils/pure.ts:918`) and the row
  token set (tokens of `row.title` plus tokens of `row.body`, same
  token rule). Lexical only: core has no embedding provider of its own,
  and the module must stay pure.
- `buildShortlist(fact, rows, k, score?)` — returns the top k rows,
  highest score first. `fact` is `{ title: string; body: string }`.
  The builder dedupes `rows` by `normalizeTitleKey`
  (`packages/core/src/utils/ontology.ts:13`) before sorting, keeping
  the last row per key; this matches the catalog's dedupe
  (`packages/core/src/prompts.ts:85-90`). Ties break by title in the
  same UTF-16 order the catalog uses. The optional `score` function has
  the signature `score(fact, row) => number`; it lets a caller inject
  an embedding-based scorer. The benchmark injects one; core does not.

The module must not import fastembed. `packages/core/package.json` has no
fastembed dependency; keep it that way.

### 2. `shortlist-recall` benchmark subcommand

Add `packages/benchmarks/src/shortlistRecall.ts` and wire a new
`shortlist-recall` subcommand into `packages/benchmarks/src/cli.ts` in the
hand-rolled dispatch chain (`packages/benchmarks/src/cli.ts:950-1010`) plus
the help text (`packages/benchmarks/src/cli.ts:1024`). This PR owns the
`cli.ts` wiring (plan Y8: 2a is the only Lane 2 wave-1 PR allowed to edit
`cli.ts`).

Input shapes. A fixture entry carries only `text`. The benchmark maps each
entry to `fact = { title: '', body: entry.text }`. Both scorers score the
same fact against the same rows: the embedding scorer embeds the fact body
and each row's `title + ' ' + body` string, so the lexical and embedding
comparisons see identical inputs.

Candidate pools. The subcommand runs against three deterministic pools and
reports each pool separately:

- `seed` — the 3 `SEED_NODES` rows. Reported for continuity with E1, not
  as evidence; every k at or above 3 is vacuous here.
- `distractor-50` — the 3 seed rows plus 47 deterministic synthetic
  distractor rows.
- `distractor-200` — the 3 seed rows plus 197 distractors. This pool
  exercises the cap regime, since the live catalog caps at 200 entries
  (`packages/core/src/prompts.ts:98`).

The distractor generator is pure and seeded: row i gets title
`Distractor Node <i>` with two trailing hash words derived from a fixed
seed constant, a fixed `okf_type` cycled through `TARGET_TYPES`
(`packages/benchmarks/src/statementKinds/run.ts` exports it), and a
one-sentence body containing those words. Ground truth stays the fixture:
each distractor pool must contain every fixture `expected_target.title`
under `normalizeTitleKey`; the runner asserts this before scoring and
fails loudly on a mismatch.

The subcommand:

1. Loads the committed 28-entry fixture
   `packages/benchmarks/fixtures/statement-kinds.json` via
   `loadStatementFixture` (`packages/benchmarks/src/statementKinds/run.ts:69`).
   Each entry carries `expected_target.title` and `expected_target.type`,
   which are the ground truth.
2. Builds the three pools above.
3. Scores each pool two ways:
   - `lexical`: the core default scorer from section 1.
   - `embedding`: `cosineSimilarity`
     (`packages/core/src/utils/cosine.ts:1`) between the fact vector and
     the row text vector.
   This mirrors the direct core-source-import pattern `calibrate.ts` uses
   (`packages/benchmarks/src/calibrate.ts:23-27`). Zero LLM token spend.
4. Computes recall@k per pool per scorer, for k = 1, 3, 5, 10, 25, with
   one k row per k value below the pool size (k = 5, 10, 25 for the
   distractor pools; k = 1 for the seed pool). A hit means the normalized
   `expected_target.title` equals a shortlisted title under
   `normalizeTitleKey` (`packages/core/src/utils/ontology.ts:13`), the
   same key the catalog dedupes on (`packages/core/src/prompts.ts:82-90`).
   Type equality is not part of the hit rule; the result file records
   expected and actual types per entry for inspection.
5. Prints a random baseline per pool per k: `min(1, k / N)` where N is
   the pool size. This is the recall a random ranker achieves, so the
   reader can judge whether a scorer beats chance.
6. Prints a summary table and writes a JSON result file to
   `packages/benchmarks/results/`, named
   `shortlist-recall-<engineVersion>-<stamp>.json` (sibling commands put
   the engine version in the file name; the default directory comes from
   `defaultResultsDir()` and `nowStamp()` in
   `packages/benchmarks/src/cli.ts`; a user `--out` overrides via
   `resolveOutPath`, `cli.ts:87-89`). The file records engine version,
   fastembed model id and package version, pool sizes, per-pool per-k
   recall per scorer, the random baselines, and per-entry hit/miss, so
   the numbers trace to real runs (INTENT Rule 11).
7. Prints the slice caveat in the summary output and the result file:
   distractor rows are synthetic, so these numbers measure the rankers
   on synthetic pools of realistic size; they are not recall on real
   memories.

Guard semantics. The subcommand accepts `--yes`, `--dry-run`, and `--out`.
The embedder is built lazily: the CLI branch passes an embed factory into
the runner, and the runner calls it only after the guard passes. Without
`--yes`, the command prints the estimate and exits 0; the estimate lists
the pool sizes, the entry count, the scorer list, and the model download
size. `--dry-run` prints the same estimate and exits 0, and the embed
factory is never called, so no model download and no embedding happen.
This differs from the `supersession` branch, which builds its embedder
before parsing flags (`packages/benchmarks/src/cli.ts:962-963`,
`:983-985`); 2a must not copy that order.

### 3. What 2a does not do

2a does not touch `MaintenanceService.ts`, `PromptService.ts`, or the live
backfill prompt. Wiring the shortlist into the backfill path, the
`shortlistK` config knob, and the errata that supersedes the #425 ruling
all belong to PR 2b. PR 3 consumes 2a's code, not its score.

## Files touched

- `packages/core/src/utils/shortlist.ts` — new pure shortlist builder.
- `packages/core/__tests__/shortlist.test.ts` — new unit tests. Core's
  vitest config includes only `__tests__/**/*.test.ts` under the package
  root (`packages/core/vitest.config.ts:5`), so the tests sit there, not
  under `src/utils/__tests__/`.
- `packages/benchmarks/src/shortlistRecall.ts` — new recall@k runner.
- `packages/benchmarks/__tests__/shortlistRecall.test.ts` — new runner
  tests.
- `packages/benchmarks/src/cli.ts` — new `shortlist-recall` dispatch branch
  and help line.
- `packages/benchmarks/results/` — new committed result file from the real
  run.
- `specs/shortlist-recall/plan.md` and `LEDGER.md` — added in this PR once
  the spec reaches Reviewed (INTENT "How changes are made" step 1).
- The spec Status line flips to Implemented in this PR's cleanup commit
  (INTENT rule 10). A `docs/ROADMAP.md` done mark is out of scope until
  the L2-0 roadmap amendment PR adds a 2a step.

Public API note: 2a does not export `shortlist.ts` from the core package
entry point. The benchmark imports the core source directly (the
`calibrate.ts` pattern), and PR 2b exports the module when it wires the
shortlist into the backfill path. 2a adds no new published API.

Gate posture: this PR reports numbers and gates nothing. It sets no
pass/fail threshold on any engine path, and INTENT Rule 11's
native-engine gate is untouched.

## Test plan

1. Core unit tests for `shortlistScore`: empty token sets on both sides
   return 0 (the 0/0 case at `pure.ts:923`), tokens shorter than 3
   characters are dropped, and the fact set is the union of title and
   body tokens. Unit tests for `buildShortlist`: top-k order, dedupe by
   `normalizeTitleKey` keeping the last row, tie-break determinism on
   distinct titles, k larger than the pool returns the whole pool,
   injected scorer is used.
2. Runner unit tests with a deterministic stub embed function (no model
   download, no fastembed call — the root `pnpm test` runs these offline):
   recall@1 and recall@k = pool size arithmetic on a hand-built 4-row
   pool with known hits, the `normalizeTitleKey` hit comparison, the
   ground-truth validation failure path, the random baseline value and
   its `min(1, k/N)` clamp, the distractor generator's determinism
   (same seed, same rows), and the result-file schema. Run
   `pnpm --filter @equationalapplications/benchmarks-llm-wiki test` and
   the core package test suite. All must pass.
3. CLI tests: the dispatch branch passes a lazy embed factory (never a
   built embedder). One test asserts the factory is never called under
   `--dry-run`. One test asserts a run without `--yes` prints the
   estimate (pool sizes, entry count, scorers, download size) and exits
   without scoring. The new help line lists the subcommand.
4. Real benchmark run (the numbers INTENT Rule 11 requires): run
   `pnpm --filter @equationalapplications/benchmarks-llm-wiki bench shortlist-recall --yes`.
   The first run downloads the ~150 MB ONNX model into the package's
   gitignored `.cache` (`packages/benchmarks/src/embed.ts:17`). The run
   costs zero LLM tokens. Commit the JSON result file and quote the
   recall@k numbers per pool in the PR body, with the synthetic-pool
   caveat from step 7 of the subcommand list.
5. Determinism check: run the subcommand twice. The two result files
   must carry identical recall values, baselines, and per-entry hit/miss
   lists. The stamp and the recorded model/version fields may differ in
   stamp only. fastembed output is treated as deterministic on one
   machine; if the two runs disagree, the run fails the check and the
   implementer records the discrepancy in the ledger instead of quoting
   the numbers.

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
  drift risk with no new signal. The distractor pools are generated in
  code, not stored, so they cannot drift from a fixture.
- Recall measurement on the seed pool alone. Rejected by review: the seed
  pool holds 3 nodes, so recall@5 and above is vacuous. The distractor
  pools give the numbers content.
- Downloading the model inside `--dry-run`. Rejected: the guard must gate
  the download, so the embedder is built lazily.

## Open questions for the owner

1. Default k. This spec benchmarks k = 1, 3, 5, 10, 25 and proposes k = 10
   as the 2b default, judged on the `distractor-200` pool because that
   pool matches the live cap. Confirm or pick another default.
2. Scorer choice for 2b: lexical, embedding, or hybrid. The real run's
   recall numbers on the distractor pools should drive this; this spec
   only measures.
3. Distractor realism. The synthetic distractors are keyword-bearing
   titles; real node titles may cluster more tightly. If the owner wants
   harder distractors (title variants of the seed nodes), 2a extends the
   generator before implementation.
