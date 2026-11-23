# Legacy-control runs for the backfill-cap B1/B2 tests

**Status:** Reviewed (owner-approved as written 2026-11-23)
**Date:** 2026-11-23
**Intent check:** Test-strength hardening only; no runtime behavior changes. Touches INTENT.md rule 11 (no accuracy or cost claims without a benchmark) only by not making any, and the "Spec first" and "Spec status honesty" change rules by carrying a Status line and amending the parent spec's test plan in the same PR. No rule is contradicted. Roadmap step 9 (`docs/ROADMAP.md:253`) owns the feature; this is its deferred follow-up (issue #456).

## Problem

`packages/core/__tests__/contextBudgetBackfill.test.ts` implements spec test 4 of `specs/backfill-cap-context-budget/spec.md` ("under a declared budget, `runBatched` splits a two-fact batch at the derived cap") as B1 and B2. Neither proves its own fixture is discriminating.

- B1 (`contextBudgetBackfill.test.ts:84-98`) seeds two bodies of `40_000 / 2 - 60 = 19_940` chars (line 87) and asserts one call under the declared cap of 100_800. Its premise, that the same pair splits under the legacy 40_000 floor, is stated only in the test title. It holds only because fixed prompt overhead (system prompt, catalog, headers) pushes 2 x 19_940 past 40_000. Nothing in the file runs the pair under legacy, so a future cut to prompt overhead could drop the pair under 40_000, B1 would still pass, and it would no longer discriminate derived from legacy. The issue reports it was RED at commit time (ledger evidence, since deleted), which is not a standing guard.
- B2 (`contextBudgetBackfill.test.ts:100-117`) seeds two bodies of `100_800 / 2 - 60 = 50_340` chars (line 103) and asserts two calls, each holding one fact, each `<= cap` and `> 40_000` (lines 108-115). Under legacy each of those facts is already oversized alone, and the oversized-singleton rule (`BoundedLlmCall.ts` `trim`) ships it by itself, so legacy yields the identical two-call, one-fact-each observable. B2 therefore pins only the upper bracket (a wrongly larger cap would join the pair); it cannot tell the derived cap from the legacy floor.

Both gaps are test-strength only. The feature is correct and shipped (parent spec Implemented, PR #455). Rung-1 adjudicated B2's bracket as ACCEPT and rung-3 concurred, so B2 stays as is.

## Root cause (with evidence)

Both tests build their wiki with `makeWiki(cfg)` where `cfg` is the declared config (lines 81, 86, 102). The file's only legacy evidence is resolver-level (R1, lines 57-63), which checks the number returned by `resolveMaxPromptChars`, not the batching behavior of a wiki run on these fixtures. The fixture-to-behavior claim "this pair splits under legacy" has no executable form.

## Proposed change

Add two tests to the existing `describe('declared backfill boundary (spec test 4)')` block, reusing `makeWiki`, `seedEntry`, `answerWithIdsInPrompt` and the same fixtures. Each builds the wiki with `{}` (no `context` section, the legacy default) in place of the declared `cfg`.

1. `B1-control: the B1 pair splits under legacy (no context section)`. Seed the same two 19_940-char facts (ids `fact_half1`, `fact_half2`, `updatedAt` 100 and 200). Run `runOntologyBackfill('e1')`. Assert `generateText.mock.calls.length` is 2; each call's payload contains exactly one of the two ids; each call's total prompt length is `<= ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS`. This proves the B1 fixture only joins because of the derived cap. If overhead ever shrinks enough to make the pair fit under 40_000, this control goes red and says so, instead of B1 passing vacuously.
2. `B2-control: the B2 pair has the same two-call shape under legacy`. Seed the two 50_340-char facts (derive `half` from the declared `cap` as B2 does, so the fixture stays identical). Run under `{}`. Assert 2 calls, one id per call, each call's length `> ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` (oversized singletons). The test records, in a comment, that the shape equals B2's by design: B2 is an upper-bracket pin and does not discriminate the lower bound; the lower bound is covered by B1 plus B1-control. No attempt is made to make B2 discriminating (ACCEPT stands).

No production code, no existing test, and no fixture changes. Expected suite delta: +2 tests.

## Files touched

- `packages/core/__tests__/contextBudgetBackfill.test.ts` — the two controls.
- `specs/backfill-cap-context-budget/spec.md` — a one-line note appended to test plan item 4: "B1 and B2 each carry a legacy-control run (issue #456, spec `specs/backfill-cap-legacy-control/spec.md`): B1-control proves the B1 pair splits under legacy; B2-control records that B2's shape is identical under legacy (upper-bracket pin only)." The parent spec's Status line is not changed (behavior is unchanged).
- `specs/backfill-cap-legacy-control/spec.md` — this file.

## Test plan

1. `pnpm --filter` core vitest on `contextBudgetBackfill.test.ts`: 2 new tests pass, existing B1/B2/R1-R3/F1 unchanged.
2. Mutation check for B1-control (run once during implementation, not committed): temporarily shrink the B1 bodies so the pair fits under 40_000 and confirm B1-control goes red while B1 stays green, which demonstrates the silent-vacancy gap is now caught.
3. Full core suite green; count is baseline + 2. Root `pnpm test` and typecheck pass.
4. `ontologyBackfill.test.ts` is untouched.

Semver: test-only plus docs. Commits use `test(core): ...` and `docs(specs): ...`; neither triggers a release. No `BREAKING CHANGE` footer; `CHANGELOG.md` and `"version"` fields untouched.
