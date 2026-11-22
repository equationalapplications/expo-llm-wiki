# Edge suggestions from System-One — plan

Spec: `specs/edge-suggestions-system-one/spec.md`

Authority: INTENT beats spec beats plan. Where this plan and the spec
disagree, the spec wins and the implementer stops. Open questions sit in
`LEDGER.md` under Discrepancies; a task that names one waits for its answer.

## Baseline and end state

- Baseline: lane base `c0aa79e3`. The controller measured 254 test files and
  2969 tests passing on 2026-11-22. The full core suite ran green in 71s.
- End state: 255 test files. The count is 2969 plus only the net new tests.
  No existing test changes its assertions. No existing test is deleted.
- The new file is `packages/core/__tests__/classifierEdgeScreen.test.ts`. It
  holds test-plan items 2–8 and 10–21. Item 1 extends
  `packages/core/__tests__/systemOneConfig.test.ts`. Item 9 adds no test.

## Commands

- Full suite: `pnpm --filter @equationalapplications/core-llm-wiki test`
- Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
- Targeted file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`
- Targeted case: append `-t "<test name>"` to the targeted-file command.

## Invariants (every task keeps these)

- I1. `runBatched` and the step-9 prompt cap stay untouched.
- I2. `resolveEdges`, `resolveAndPersistEdges`, `EdgeDropReason`, and the edge
  diagnostics stay untouched. `OntologyService.ts` has an empty diff.
- I3. `types.ts`, `utils/diagnostics.ts`, `prompts.ts`, and
  `ontologyReceiptVocabulary.test.ts` have empty diffs. The PR adds zero
  diagnostic codes.
- I4. The public export surface gains exactly `resolveSystemOneEdges` and
  `resolveEdgesMinConfidence`. No other export changes.
- I5. With no `systemOne.edges` key, the classifier path is byte-identical.
  The classify request carries exactly `{ okf_type: question }`. Each
  classification is exactly `{ id, okf_type }`, with no `edges` key. The
  classifier step performs no shortlist-pool read.
- I6. With no `systemOne.edges` key, generative prompts are byte-identical.
  `_runGenerativeBackfill` keeps its in-step pool read in every mode. Nothing
  hoists the read to `doRunOntologyBackfill` entry.
- I7. Ingest and librarian edge sites stay untouched (ruling OQ1).
- I8. Nobody runs prettier or any formatter. Diffs show only intended lines.
- I9. Nothing caps the edge-question map (ruling OQ2). The overflow retry-once
  rule is the only circuit breaker.

## Vocabulary (one word, one meaning)

- **edge mode** — the resolved value of `systemOne.edges`: `'auto'` or `'llm'`.
- **site mode** — the edge mode after the floor check. It is `'auto'` only
  when the edge mode is `'auto'` and a valid floor exists.
- **floor** — the resolved `systemOne.minConfidence.edges` value, in [0.5, 1].
- **pool** — the rows that `findShortlistRowsByEntityId` returns.
- **candidate** — one pool row from a fact's ranked shortlist.
- **edge question** — one `binary` question keyed `edge:<edge_type>:<targetFactId>`.
- **key map** — the map from edge-question key to (definitions, candidate).
- **edge screen** — asking, banding, and converting edge questions for a fact.
- **fallthrough** — a typing-accepted fact routed to the generative step by
  its edge answers. The outcome flag is `edge_fallthrough`.

## Tasks

1. **Baseline check.** Files: none. Test: none written. Run the full suite and
   the typecheck at the lane head. Record the file and test counts in the
   ledger evidence. Verification: the full suite reports 254 files and 2969
   tests passing; the typecheck exits 0. A mismatch stops the wave.

2. **Config surface (§1, §2, §9).** Test first: add a type-level case to
   `systemOneConfig.test.ts`. The case builds a `WikiConfig` with
   `systemOne: { edges: 'auto', minConfidence: { typing: 0.5, edges: 0.7 } }`.
   The case fails the typecheck before the change. Change
   `packages/core/src/config/systemOne.ts`: `SystemOneThresholdSite` becomes
   `'typing' | 'edges'`. Add `edges?: 'auto' | 'llm'` beside `typing`, with
   the §2 docstring verbatim. Append "unless `systemOne.edges: 'auto'`" to
   the `typing` docstring parenthetical. Update the header comment's
   "Exactly one member today" line to name both members. Verification: the
   typecheck exits 0; the targeted `systemOneConfig.test.ts` run passes.

3. **`resolveSystemOneEdges` (§2; test plan 1, first half).** Test first, in
   `systemOneConfig.test.ts`: unset config and `{}` return `'llm'`; `'auto'`
   and `'llm'` pass through. An invalid value (`'off'`, `1`, `1n`, a circular
   object) returns `'llm'`. Each invalid value warns exactly once, through
   `warnOnce`, with the `[core-llm-wiki] systemOne:` prefix, naming
   `systemOne.edges`. A typing value never changes the result. Change
   `packages/core/src/utils/engineDefaults.ts`: add `resolveSystemOneEdges(config)`
   beside `resolveSystemOneTyping`. Reuse `isTypingMode` and
   `formatConfigValue`. Add no legacy chain and no call option. Verification:
   the targeted `systemOneConfig.test.ts` run passes.

4. **`resolveEdgesMinConfidence` (§3; test plan 1, second half; test plan 18,
   third clause).** Test first, in `systemOneConfig.test.ts`. The resolver
   returns `number | undefined`. With edge mode `'auto'`:
   - a missing floor returns `undefined` and warns once, naming
     `systemOne.minConfidence.edges`;
   - `0`, `0.3`, `0.49`, `1.01`, `NaN`, `Infinity`, and `'0.7'` each return
     `undefined` and warn once;
   - `0.5` returns `0.5`; `0.7` returns `0.7`; `1` returns `1`;
   - `minConfidence.typing` and `ontology.classifyMinConfidence` never feed
     the result.
   With edge mode `'llm'` or unset, the resolver returns `undefined`. It
   reads no floor and emits no warning, even for `0.3`. Change
   `engineDefaults.ts`: add `resolveEdgesMinConfidence(config)` beside
   `resolveTypingMinConfidence`. It calls `resolveSystemOneEdges(config)`
   first and returns `undefined` unless that returns `'auto'`. Add a local
   [0.5, 1] guard; do not touch `isConfidenceFloor`. Export no default floor
   constant. Verification: the targeted `systemOneConfig.test.ts` run passes;
   the targeted `engineDefaults.test.ts` run passes unchanged.

5. **Public exports (Files touched: `index.ts`; invariant I4).** Test first:
   if `publicExports.test.ts` enumerates resolver names, add the two new
   names there. Otherwise add one import-and-call case to
   `systemOneConfig.test.ts` that imports both from `../src/index`. Change
   `packages/core/src/index.ts`: add both resolvers to the existing
   `./utils/engineDefaults` export block. Verification: the targeted
   `publicExports.test.ts`, `export.test.ts`, and
   `graphOwnershipExports.test.ts` runs pass.

6. **Mode, floor, and `shortlistK` plumbing (§5 plumbing paragraph).** Test
   first: run `ontologyBackfill.test.ts`, `classifierBackfill.test.ts`, and
   `contextBudgetBackfill.test.ts` and record them green. Change
   `MaintenanceService.ts`:
   - In `doRunOntologyBackfill`, beside the typing chain, resolve the edge
     mode and the floor once per pass. Compute the site mode: `'auto'` only
     when the edge mode is `'auto'` and the floor is a number.
   - Add `shortlistK`, `edgeSiteMode`, and `edgeMinConfidence` to the explicit
     `_runClassifierBackfill` arguments. Do not re-resolve `shortlistK`.
   - Add `edgeSiteMode` and `edgeMinConfidence` to `runOpts` at both
     `_runGenerativeBackfill` call sites. Assert `edgeSiteMode` beside the
     existing `shortlistK` and `maxPromptChars` asserts, with the same
     message shape. The generative step reads neither field.
   If an existing test pins the `shortlistK` assert, add a sibling case for
   `edgeSiteMode` in that file. Verification: the typecheck exits 0; the
   three targeted runs pass unchanged.

7. **Compatibility pins first (test plan 4, 5, 10; invariants I5, I6).**
   Test first, in `classifierEdgeScreen.test.ts`. Write these before any
   screen code, so they guard every later task:
   - Item 5: with no `systemOne` keys, the classify spy sees exactly
     `{ okf_type: question }`, under typing `'llm'` and legacy `'auto'`. The
     classifier step proposes no edges. A `runBatched` spy sees the same
     arguments and `maxPromptChars` as the baseline fixture.
   - Item 4: `edges: 'auto'` with a valid floor and no `classify` method
     produces the baseline generative edges and prompts. Repeat with
     `typing: 'llm'` and a `classify` method present; the spy records zero
     calls (ruling OQ3, inert).
   - Item 10: a full pass with legacy keys only matches the baseline. The
     comparison covers persisted edges, `edge_dropped` diagnostics, and
     counters, for both typing modes. Under `edges: 'auto'`, the
     escalation-leg prompt lists the classifier-typed facts of the same pass.
   - A pool-read spy records zero `findShortlistRowsByEntityId` calls from
     the classifier step when the site mode is `'llm'`.
   Change: none; these pass at this point. Verification: the targeted
   `classifierEdgeScreen.test.ts` run passes. Re-run it after every later task.

8. **Edge-question map construction (§4 candidates, filter, and collision
   bullets; test plan 8, 16 first half, 17).** Blocked on Discrepancy D3 for
   the batch-collision set only. Test first, in `classifierEdgeScreen.test.ts`,
   asserting on the classify spy's `questions`:
   - Item 8: a fact with zero candidates gets no edge question. Its
     classifier typing applies. No edges persist. It does not reach the
     generative step.
   - Item 16, first half: a (definition, candidate) pair whose `target_type`
     the candidate's `okf_type` does not satisfy is never asked.
   - Item 17(a): two pool rows share a `normalizeTitleKey` key with
     different ids. Neither row becomes an edge question, under either row
     order. No `edge_dropped` fires for them.
   - Item 17(b): a batch fact shares a candidate's normalized title. That
     candidate is never asked. No `edge_dropped` fires for it.
   - Key safety: an edge type containing `:` produces a working edge
     question. The key map, never a key parse, recovers the pair.
   Change `MaintenanceService.ts`, inside `_runClassifierBackfill` only:
   - When the site mode is `'auto'`, read the pool once, before
     `withConcurrency`. Build one scorer with `createShortlistScorer`.
   - Build the collision set before any classify call. It holds every
     normalized title shared by two or more pool rows, plus every batch
     fact's normalized title (scope per D3).
   - Per fact, rank candidates with `buildShortlist` and `shortlistK`. Drop
     colliding candidates.
   - For each manifest edge type and candidate, keep the pair when
     `typeSatisfies(target_type, candidate.okf_type, manifest)` holds. Emit
     one edge question per unique (`edge_type`, candidate id). The key map
     entry lists every definition that shares that `edge_type`. This keeps
     keys unique when several definitions share a type name.
   - Each edge question's instructions name the edge type, its description,
     and the candidate title. They carry no fact content beyond the state.
   - Use `normalizeTitleKey`, `resolveEdgeDefinitions`, and `typeSatisfies`
     from `utils/ontology.ts` unchanged.
   Verification: the targeted `classifierEdgeScreen.test.ts` and
   `classifierBackfill.test.ts` runs pass.

9. **Band evaluation and edge conversion (§3, §4 accepted-answers bullet;
   test plan 2, 15, 16 second half, 18 first and second clauses).** Test
   first, in `classifierEdgeScreen.test.ts`:
   - Item 2: typing accepted plus one confident "yes". The converted
     `{ edge_type, target_title }` entry persists through
     `resolveAndPersistEdges`. The `node_type_assigned` receipt carries
     writer `'classifier'`. The classifier step's `edgesAdded` is nonzero.
   - Item 15: several confident "no" answers plus one confident "yes". The
     "yes" edge applies. The fact does not reach the generative step.
   - Item 16, second half: an answer whose definitions' `source_type` does
     not match the chosen typing is discarded first. It yields no edge and
     no fallthrough.
   - Item 18: `p = 0.5` under floor `0.5` is a fallthrough. `p = 0.4` under
     floor `0.6` is a terminal confident "no".
   Change `_runClassifierBackfill`:
   - Add the edge questions to the existing request map beside `okf_type`.
   - Evaluate edge answers only when typing is `accepted`.
   - Discard source-mismatched answers before banding, using `typeSatisfies`.
   - Validate each answer with `validateClassifierAnswer` before banding.
     A non-`binary` answer is invalid with reason `kind_mismatch`.
   - Band each valid answer per §3: `p > 0.5 && p >= floor` accepts;
     `p < 0.5 && 1 - p >= floor` is terminal; everything else is uncertain.
   - Extend the `accepted` outcome with its accepted edge entries and its
     per-fact counts. Build `target_title` from the candidate row's title.
   - Add an `edges` key to a classification only when the site mode is
     `'auto'` and the fact has accepted edges (invariant I5).
   Verification: the targeted `classifierEdgeScreen.test.ts`,
   `classifierBackfill.test.ts`, and `ontologyBackfill.test.ts` runs pass.

10. **Invalid and missing answers, and edge-site diagnostics (§6; test plan
    7, 21).** Blocked on Discrepancy D2 for item 21's diagnostic code only.
    Test first, in `classifierEdgeScreen.test.ts`:
    - Item 7: a malformed or out-of-range probability flags the fact
      `edge_fallthrough`. The answer never applies. The classifier leg
      emits no `edge_dropped` for it. The generative leg's own drops still
      surface as `edge_dropped`.
    - Item 21: a classifier answering only `okf_type` keeps its typing. The
      fact stays in the classifications build and the apply batch. No
      generative leg runs. No edges persist. Exactly one edge-site
      diagnostic fires per fact, with the missing-answer count in `detail`.
    - Volume pin: a fact with five uncertain answers emits one
      `classification_low_confidence` with `detail.site: 'edge_screen'`. A
      fact with any malformed answer emits one `classification_invalid`
      instead. Each `detail` carries asked, uncertain, invalid, and missing
      counts.
    Change `_runClassifierBackfill`: flag `edge_fallthrough` on any uncertain
    or invalid edge answer, except the all-`missing_answer` shape. A partial
    `missing_answer` set counts as invalid. Emit one edge-site diagnostic per
    flagged fact, and one per all-missing fact. Keep `invalidCount` counting
    typing outcomes only. Verification: the targeted
    `classifierEdgeScreen.test.ts` and `classifierDiagnostics.test.ts` runs pass.

11. **Overflow retry-once (§4 overflow bullet; test plan 20).** Test first, in
    `classifierEdgeScreen.test.ts`. The classify stub overflows on any
    request that carries edge questions:
    - Retry succeeds: typing applies; no edges are screened; the outcome is
      not `overflow_skip`; no fallthrough fires; exactly one
      `context_overflow_skipped` fires with `detail.site: 'edge_screen'`.
    - Retry overflows: the outcome is `overflow_skip`, stamped untyped, with
      no generative leg. Diagnostics match the pre-PR overflow exactly.
    - Retry throws `WikiBudgetExhausted`: the outcome is `unattempted` and
      `stopped` is set, as today.
    - Retry throws another error: the outcome is `threw`, with no cooldown stamp.
    - A request without edge questions that overflows is never retried. The
      spy records one call.
    Change `_runClassifierBackfill`: on an overflow with edge questions
    present, call `callClassify` once more with `{ okf_type: question }`
    only. Route that call's result through the existing catch and
    validation code. Mark the retried outcome so the diagnostics loop emits
    the edge-site overflow receipt. Verification: the targeted
    `classifierEdgeScreen.test.ts` and `classifierBackfill.test.ts` runs pass.

12. **Escalation gate plumbing (§5; test plan 3, 6, 11, 12, 13, 14, 19).**
    Blocked on Discrepancy D1 for item 14 only. Test first, in
    `classifierEdgeScreen.test.ts`:
    - Item 3: an uncertain answer sends the fact un-stamped to the generative
      step of the same pass. The merged result sums `edgesAdded`.
    - Item 6: under `onLowConfidence: 'llm'`, an abstain or low-confidence
      fact reaches the generative step wholesale. Its classifier edge
      answers are discarded. Its edges come only from the generative step.
    - Item 11: a generative classification with an unknown id still
      increments `failedValidation` before any receipt region. With a
      fallthrough and no typing-invalid fixture fact,
      `merged.failedValidation === generative.failedValidation`.
    - Item 12: under the default `onLowConfidence: 'leave'`, a fallthrough
      fact reaches the generative step. `markOntologyChecked` never stamps
      it. The generative step re-decides its typing.
    - Item 13: an ontology-off abort mid-classifier returns the zeroed shape,
      no persisted edges, `edgesAdded 0`, and empty `escalated`. The test
      does not assert an empty diagnostic buffer. A fallthrough-triggered
      leg with live mode `'off'` defers without calling generative.
    - Item 14: per D1.
    - Item 19: under `'leave'`, a low-confidence fact with an uncertain edge
      answer is stamped and left. No generative leg runs. No edges persist.
      Abstain and invalid typing behave the same. No edge-site diagnostic fires.
    Change `_runClassifierBackfill` and `doRunOntologyBackfill`:
    - Build `escalated` once. Typing escalations join only when
      `onLowConfidence` resolves `'llm'`. Fallthrough facts join always.
      Each fact joins at most once.
    - `isEscalated` returns true for fallthrough facts. So `attempted`
      excludes them, and `abstainCount` never counts them.
    - The classifications build excludes every fallthrough outcome. The
      all-missing shape is not a fallthrough and stays in the build.
    - The generative-leg gate becomes `classifierRun.escalated.length > 0`.
      The live-mode re-check stays inside the branch, unchanged.
    Verification: the targeted `classifierEdgeScreen.test.ts`,
    `classifierBackfill.test.ts`, and `ontologyBackfill.test.ts` runs pass.

13. **Vocabulary and untouched files (test plan 9; invariants I1–I3).** Test:
    none written. Run `ontologyReceiptVocabulary.test.ts` unchanged.
    Verification: the targeted run passes, and this command prints nothing:
    `git diff c0aa79e3 -- packages/core/src/types.ts packages/core/src/utils/diagnostics.ts packages/core/src/services/OntologyService.ts packages/core/src/prompts.ts packages/core/__tests__/ontologyReceiptVocabulary.test.ts`.
    Review `git diff c0aa79e3 -- packages/core/src/services/MaintenanceService.ts`.
    It shows no hunk inside `_runGenerativeBackfill` beyond the `runOpts`
    type and assert lines. It shows no hunk in `runBatched` or
    `_applyOntologyBackfillBatch`.

14. **Docstrings (§9).** Test: none written. Change the
    `_runClassifierBackfill` docstring to the §9 text. Task 2 already covers
    the `systemOne.ts` docstrings. Verification: the typecheck exits 0; a
    diff review shows comment-only hunks.

15. **Host docs (§9; Files touched, docs bullet).** Test: none written. Add
    `systemOne.edges` and `systemOne.minConfidence.edges` rows to
    `apps/docs/src/content/docs/reference/configuration.md`. Add a short
    edge-screen section to `apps/docs/src/content/docs/guides/ontologies.md`.
    State posture A: the floor is required under `'auto'`, valid in
    [0.5, 1], with no default. State that the feature shipped unbenchmarked
    (INTENT.md rule 11). Claim no accuracy or cost gain. Disclose that
    `'auto'` cost can exceed `'llm'` cost. Verification: run the docs app's
    build if `apps/docs/package.json` defines one; otherwise review the diff.

16. **Suite health.** Test: none written. Run the full suite and the
    typecheck. Verification: the suite reports 255 files. The test count is
    2969 plus the net new tests from tasks 2–12, counted by name in the
    ledger evidence. The typecheck exits 0. `git status` shows no stray
    lockfile and no formatter churn.

17. **Cleanup commit (`specs/README.md` lifecycle step 4).** Run only after
    the tiered review loops converge, and before `gh pr ready`. One commit:
    - flips the spec's Status line to `Implemented`;
    - deletes `plan.md` and `LEDGER.md`;
    - adds the step 10 Done line to `docs/ROADMAP.md`, per the convention at
      `docs/ROADMAP.md:48`.
    The commit edits no `CHANGELOG.md`, no `"version"` field, and carries no
    `BREAKING CHANGE` footer. Verification: `ls specs/edge-suggestions-system-one/`
    lists only `spec.md`; the full suite still reports task 16's counts.
