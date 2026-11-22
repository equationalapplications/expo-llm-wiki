# Step 9: The ontology-backfill prompt cap joins the context budget — plan

Spec: `specs/backfill-cap-context-budget/spec.md`

Author: tier-3 reviewer (Opus), per the owner directive of 2026-11-22
(Discord msg `1574024786680746015`). The authority order is INTENT, then
the spec, then this plan. If this plan contradicts the spec, the spec wins.

## Baseline

The base is `2b69852a` (PR #454 merge, release v9.10.0). At that base, the
core suite passes 253 test files and 2963 tests. The controller measured
these counts on 2026-11-22.

The expected end state is the baseline plus the net new tests only. This
plan adds one test file with six tests. The end state is therefore 254
test files and 2969 tests, all passing. If the implementer adds or drops a
test, the implementer must restate the expected count in the ledger.

## Commands

The implementer runs every command from the repository root.

- Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`
- One file: `pnpm --filter @equationalapplications/core-llm-wiki test __tests__/<file>.test.ts`
- Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
- Build: `pnpm --filter @equationalapplications/core-llm-wiki build`

## Invariants

The PR must keep each invariant below. Task 6 verifies all of them.

- I1. `packages/core/src/services/BoundedLlmCall.ts` is untouched. This
  covers `runBatched`, `trim`, the split ladder, escalation, and skip.
- I2. The public export surface is unchanged. `packages/core/src/index.ts`
  is untouched. It still exports `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` from
  `./services/MaintenanceService`.
- I3. Three existing test files are untouched, imports included:
  `__tests__/configContext.test.ts`, `__tests__/contextBudgetIngest.test.ts`,
  and `__tests__/ontologyBackfill.test.ts`.
- I4. Legacy-mode prompts are byte-identical. Under no `context` section,
  and under `context.budget: 'legacy'`, `runBatched` receives 40_000.
- I5. No prompt builder changes. `PromptService.ts` and `src/prompts` are
  untouched.

## Tasks

Each task that changes code writes its test first. The implementer runs
the new test, sees it fail, then writes the code. The leaf moves first.

1. **Reconcile the baseline.** The implementer confirms that the branch
   `lane/9-backfill-cap-join` sits on `2b69852a` plus the spec commit. The
   implementer runs the full core suite and records the file and test
   counts in the ledger.
   - Files: none.
   - Test: none new.
   - Verification: the full core suite reports 253 files and 2963 tests
     passing. A different count blocks the lane until the controller
     re-measures.

2. **Verify the existing pins before any change (spec test items 1, 2).**
   These pins are verification tasks, not rewrite tasks. The implementer
   must not edit them, now or later.
   - Files: none.
   - Tests to run, unchanged:
     - `__tests__/ontologyBackfill.test.ts`: the tests "candidate
       sections: runBatched still splits an oversized batch with sections
       present", "payload guard: truncates below batchSize; documented
       exception — a single oversized fact is still sent alone", and
       "payload guard measures the full serialized prompt, not just
       title+body". These tests form the legacy byte-identity guard.
     - `__tests__/configContext.test.ts`: the `describe` block "backfill
       exclusion (spec test 6)". After this PR, this test pins the floor.
     - `__tests__/contextBudgetIngest.test.ts`: the test
       "ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS stays 40_000". After this PR,
       this test also pins the floor.
   - Verification: run the three files with the one-file command. All
     tests pass. The implementer repeats this run in tasks 3, 5, and 6.

3. **Move the constant to the leaf caps module (spec change 1).**
   - Files:
     - `packages/core/src/utils/contextCaps.ts`: add
       `export const ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS = 40_000;` with a
       doc comment that says "(was `MaintenanceService.ts`)". The name and
       the value stay identical. Update the header comment from "four cap
       values" to "five cap values".
     - `packages/core/src/services/MaintenanceService.ts`: delete the
       local `export const ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS = 40_000;`
       (next to `ONTOLOGY_BACKFILL_BATCH_SIZE`). Add
       `export { ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS } from '../utils/contextCaps';`
       in the same place. The `HEAL_MAX_PROMPT_CHARS` re-export is the
       precedent. Add a local `import` of the constant from
       `../utils/contextCaps`, because the `runBatched` call in
       `_runGenerativeBackfill` still reads it until task 5.
   - Test: no new test. This move is a pure refactor. The task-2 pins
     guard it.
   - Verification: run the typecheck. Re-run the three task-2 files. All
     tests pass. Confirm `git diff -- packages/core/src/index.ts` is empty.

4. **Add the `'backfill'` resolver operation (spec change 2, spec test
   item 3).**
   - Test first: create `packages/core/__tests__/contextBudgetBackfill.test.ts`.
     The file imports `resolveContextBudget` and `resolveMaxPromptChars`
     from `../src/config/context`. It imports
     `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` from `../src/utils/contextCaps`.
     Add one `describe` block, "resolveMaxPromptChars: backfill op (spec
     test 3)", with three tests:
     - R1. Legacy shapes: `resolveContextBudget(undefined)` and
       `{ context: { budget: 'legacy' } }` both return 40_000 for
       `'backfill'`.
     - R2. Declared formula: `{ budget: 'declared', contextWindowTokens:
       32_000 }` returns 100_800 for `'backfill'`. The test also asserts
       that the `'backfill'` value equals the `'resolve'` and `'heal'`
       values. The arithmetic is `(32000 - 4000) * 0.9 * 4 = 100800`.
     - R3. Floor clamp: `{ budget: 'declared', contextWindowTokens: 8_000 }`
       derives 14_400, and the resolver returns 40_000. This test mirrors
       the PR #438 test "floors at today caps: window 8000 clamps to
       40_000/40_000/24_000" in `configContext.test.ts`.
   - Run the new file. R1–R3 fail: typecheck rejects `'backfill'`, or the
     value is wrong.
   - Code: edit `packages/core/src/config/context.ts`.
     - Import `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` from `../utils/contextCaps`.
     - Add `backfill: ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` to `OP_FLOOR`.
     - Extend `ContextBudgetOp` to `'resolve' | 'heal' | 'extract' | 'backfill'`.
     - In `declaredPromptCap`, return `Math.max(OP_FLOOR[op], derived)`.
       This replaces the per-op `if` chain and covers `'backfill'`.
     - In `resolveMaxPromptChars`, the legacy branch returns `OP_FLOOR[op]`.
       This replaces the nested ternary. The legacy numbers stay identical.
     - Update the `declaredPromptCap` doc comment to name backfill beside
       resolve and heal. The extract ratio rule stays unchanged.
   - Verification: run the new file; R1–R3 pass. Run
     `__tests__/configContext.test.ts`, `__tests__/contextBudget.test.ts`,
     and `__tests__/contextBudgetE2E.test.ts`; all pass. Run the typecheck.

5. **Wire the backfill site to the resolver (spec change 3, spec test
   items 4, 5).**
   - Test first: add two `describe` blocks to
     `packages/core/__tests__/contextBudgetBackfill.test.ts`.
   - The new file needs its own harness, because I3 forbids edits to
     `ontologyBackfill.test.ts`. Copy the shape of `makeWiki` and
     `seedEntry` from that file. Do not import from it. The harness
     takes a `config` argument, calls `createWiki(db, { llmProvider: {
     generateText }, config })`, runs `wiki.setup()`, and sets a strict
     manifest on entity `e1` with one typed fact `fact_typed`.
   - Block "declared backfill boundary (spec test 4)", two tests. The
     fixture reads the cap as
     `cap = resolveMaxPromptChars(resolveContextBudget(cfg), 'backfill')`
     for `cfg = { context: { budget: 'declared', contextWindowTokens: 32_000 } }`.
     The test asserts `cap === 100_800` before it uses it.
     - B1. Two untyped facts with bodies of
       `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS / 2 - 60` chars share one call.
       Under legacy, the same pair splits into two calls; the task-2
       pins prove that. The test asserts one `generateText` call, both
       fact ids in it, and `systemPrompt.length + userPrompt.length <= cap`.
     - B2. Two untyped facts with bodies of `cap / 2 - 60` chars split at
       the derived cap. The test asserts two calls. Each call carries one
       fact id. Each call's prompt length is `<= cap` and `> 40_000`.
       This brackets the derived cap from above: a wrongly larger cap
       joins the pair, and a wrongly smaller cap breaks the bounds.
       State its limit honestly: the same two-call shape also appears
       under the legacy floor, because an oversized single fact is still
       sent alone. Only B1 separates the derived cap from the floor.
     - The `generateText` mock answers with the ids found in the prompt,
       like the existing oversized-batch test does.
   - Block "no silent fallback (spec test 5)", one test:
     - F1. The harness builds the wiki with a valid config object, `{}`.
       `WikiMemory` throws at construction on a malformed `context`
       section, so a malformed section reaches the pass only by mutation.
       After setup and seeding, the test sets
       `config.context = { budget: 'declared' }`, which lacks
       `contextWindowTokens`. The test asserts that
       `wiki.runOntologyBackfill('e1')` rejects with `/contextWindowTokens/`.
       It also asserts that `generateText` was never called. It asserts
       that no seeded untyped fact carries an `okf_type` or an
       `ontology_checked_at` stamp.
     - Precondition: `WikiMemory` stores `options` by reference, and
       `MaintenanceService` reads `this.options.config` at call time.
       The implementer must confirm this in `src/WikiMemory.ts`. If either
       holds a copy, the implementer stops and asks the controller.
   - Run the new file. B1, B2, and F1 fail against the hardcoded 40_000.
   - Code: edit `packages/core/src/services/MaintenanceService.ts`.
     - In `doRunOntologyBackfill`, at entry beside `resolveShortlistK`
       (line ~2127), resolve the budget once:
       `const maxPromptChars = resolveMaxPromptChars(resolveContextBudget(this.options.config), 'backfill')`.
       An invalid `context` section then throws before the classifier
       path (`_runClassifierBackfill`) types or stamps any fact, which is
       what the spec's "throws at pass entry" sentence requires. A local
       classifier pass needs no prompt cap, so one resolve serves both
       paths.
     - Thread `maxPromptChars` through the runOpts into
       `_runGenerativeBackfill`, with a required check that mirrors the
       existing `shortlistK` check (line ~2267, same error shape and
       wording pattern: "resolved at doRunOntologyBackfill entry").
     - In `_runGenerativeBackfill`, at the `runBatched<WikiFact,
       OntologyBackfillBatch>` call, replace
       `maxPromptChars: ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` with the
       threaded `maxPromptChars`.
     - Delete the local `import` added in task 3; it is now unused. Keep
       the re-export.
   - Verification: run the new file; all six tests pass. Re-run the three
     task-2 files; all pass unchanged. Run
     `__tests__/contextBudgetByteIdentity.test.ts`; it passes. Run the
     typecheck.

6. **Verify the invariants.** Each command below must print nothing, or
   must pass.
   - I1: `git diff 2b69852a -- packages/core/src/services/BoundedLlmCall.ts`
   - I2: `git diff 2b69852a -- packages/core/src/index.ts`. Then run the
     build. Confirm that `packages/core/dist/index.d.ts` still exports
     `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` with the literal type `40000`.
   - I3: `git diff 2b69852a -- packages/core/__tests__/configContext.test.ts packages/core/__tests__/contextBudgetIngest.test.ts packages/core/__tests__/ontologyBackfill.test.ts`
   - I4: the task-2 files and `contextBudgetByteIdentity.test.ts` pass.
     The R1 test pins the legacy number at the resolver.
   - I5: `git diff 2b69852a -- packages/core/src/services/PromptService.ts packages/core/src/prompts`
   - Scope: `git diff --stat 2b69852a` lists only the spec folder,
     `contextCaps.ts`, `context.ts`, `MaintenanceService.ts`, and
     `contextBudgetBackfill.test.ts`.

7. **Verify suite health (spec test item 6).**
   - Files: none.
   - Verification: run the typecheck and the full core suite. The suite
     reports 254 files and 2969 tests, all passing. The implementer
     records both counts in the ledger beside the task-1 baseline. Root
     `pnpm test` must also pass before the PR leaves draft.

8. **Write the cleanup commit (`specs/README.md` lifecycle step 4).**
   - Timing: after the tiered review loops converge, and before the
     `gh pr ready` flip.
   - Files:
     - `specs/backfill-cap-context-budget/spec.md`: flip the Status line
       to Implemented, with the date and the PR number.
     - `specs/backfill-cap-context-budget/plan.md`: delete.
     - `specs/backfill-cap-context-budget/LEDGER.md`: delete.
     - `docs/ROADMAP.md`: add the step 9 done mark in the same PR, per
       `AGENTS.md`.
   - Verification: `ls specs/backfill-cap-context-budget/` lists only
     `spec.md`. The spec Status line reads Implemented.

## Controller adjudication of the plan's open point (2026-11-22)

The authoring run flagged that the generative-site swap leaves the
classifier path unresolved. The controller verified the premise live:
`_runClassifierBackfill` runs at `MaintenanceService.ts:2171`, before the
generative escalation (`:2196`, `:2225`), and `resolveShortlistK` already
resolves at pass entry (`:2127`). The spec rules the question: Proposed
change 3 says an invalid `context` section "throws at pass entry". The
authority order (INTENT, then spec, then plan) settles it — the resolve
moves to `doRunOntologyBackfill` entry, and `maxPromptChars` threads
through the runOpts beside `shortlistK`. Task 5 above carries the amended
shape. No extra test is needed: the F1 test already pins the throw, the
stamps, and the un-called mock, and the expected counts stay 254 files /
2969 tests.
