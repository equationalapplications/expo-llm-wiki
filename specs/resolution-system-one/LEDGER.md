# Resolution from System-One — ledger

In flight: nothing

Baseline: full core suite at lane base `206936cc` — **255 files / 3014
tests, controller-measured 2026-11-22 14:05 EST, full suite green in the
lane worktree** (code-identical to `206936cc`; lane commits are docs-only).

- [ ] 1. Baseline and ledger reconcile — evidence: baseline measured
      controller-side (this line); suite green at lane base
- [ ] 2. Config surface: `'resolve'` site member and `resolve` key — evidence: <commit, test run, or log link>
- [ ] 3. Mode resolver `resolveSystemOneResolve` — evidence: <commit, test run, or log link>
- [ ] 4. Floor resolver `resolveResolveMinConfidence` — evidence: <commit, test run, or log link>
- [ ] 5. The prologue `screenResolveCandidates` (D3, D5 RESOLVED — unheld) — evidence: <commit, test run, or log link>
- [ ] 6. Wire the prologue into `runResolve` (D2 RESOLVED — unheld) — evidence: <commit, test run, or log link>
- [ ] 7. Receipt emission loop in `ops/index.ts` (D2 RESOLVED — unheld) — evidence: <commit, test run, or log link>
- [ ] 8. Public exports — evidence: <commit, test run, or log link>
- [ ] 9. Pass-level tests (D2 RESOLVED — unheld) — evidence: <commit, test run, or log link>
- [ ] 10. Invariant audit — evidence: <commit, test run, or log link>
- [ ] 11. Suite health — evidence: <commit, test run, or log link>
- [ ] 12. Cleanup commit (D1 RESOLVED — roadmap mark lands in this PR) — evidence: <commit, test run, or log link>

## Discrepancies

No ledger-versus-disk rollbacks yet. The plan author raised these
questions for the controller on 2026-11-22. Each one names the task it holds.

**CONTROLLER ADJUDICATIONS 2026-11-22 14:10 EST (all five resolved; the
held tasks are unheld above):**

- **D1 → ROADMAP RULE WINS.** The step-11 Done mark is written by the
  cleanup commit INSIDE this PR (step-10 precedent: commit `347cc286`
  carried the Done line in PR #459). Spec §8's "post-merge, not in this
  PR" line was a controller drafting error and is amended in this same
  commit. Task 12 proceeds as written by the plan (which already follows
  the roadmap rule).
- **D2 → APPROVED as recommended.** `ResolveOutcome` gains the internal
  field `classifierSettled: number[]` (merged-batch item indexes, built
  like `overflowSkipped`). It is not a public export: no public surface.
  `apply.ts` stays untouched. Tasks 6, 7, 9 unheld.
- **D3 → APPROVED as recommended.** The question `instructions` embed the
  neighbour's title and body, clipped with `safeSlice` to
  `OPS_NEIGHBOUR_BODY_CHARS`. The state stays the candidate's title and
  body. Task 5 unheld.
- **D4 → SPEC AMENDED.** Spec §2's proposed docstring text now reads
  "warns once per process" (amended in this commit, matching ruling Q5).
  Task 2's wording stands.
- **D5 → APPROVED as recommended.** A `WikiBudgetExhausted` throw from
  `callClassify` during the screen surfaces as `budgetStop` (identical
  handling to the generative leg — the same meter would stop the LLM call
  next). Any other throw maps to `warnReason: 'no-classifier'` (no new
  union member) and the all-or-nothing fallthrough applies. Task 5
  unheld.

Plan-author questions, preserved verbatim below the rulings.

- 2026-11-22 — D1 (holds task 12, roadmap line only). Spec §8 says the
  step-11 Done mark lands "at cleanup (post-merge) … not in this PR".
  `docs/ROADMAP.md:47-52` says the completing PR writes the mark.
  `specs/README.md` forbids post-merge cleanup commits. The controller
  brief also puts the mark in the cleanup commit. Step 10 wrote its mark
  in PR #459. Question: does the spec §8 line yield to the roadmap rule?
  If yes, the spec §8 text needs an amendment in the same PR.
- 2026-11-22 — D2 (holds tasks 6 and 7). Spec §5 says settled ops "flow
  back through `runResolve`'s existing return shape". Spec §6 says
  `ops/index.ts` emits one receipt per settled candidate. `ops/index.ts`
  cannot tell a settled NOOP from a generative NOOP in `res.ops` today.
  Question: may `ResolveOutcome` gain one internal field? The plan author
  recommends `classifierSettled: number[]` (merged-batch item indexes),
  mirroring `overflowSkipped`. `ResolveOutcome` is not a public export,
  so the field adds no public surface. `apply.ts` stays unchanged.
- 2026-11-22 — D3 (holds task 5, question text only). Spec §4 sets the
  state to the candidate's title and body. It sets the question to "does
  this candidate add NO information beyond neighbour nX …". The spec never
  says where the neighbour's text appears. The classifier cannot judge
  the pair without it. Question: may the question `instructions` embed the
  neighbour's title and body, clipped with `safeSlice` to
  `OPS_NEIGHBOUR_BODY_CHARS`? The plan author recommends that option.
- 2026-11-22 — D4 (no task held; ruling applied). Spec §2's docstring
  text says the unavailable classifier "warns once per pass". Ruling Q5
  and spec §4 say once per process. The plan follows the ruling. Task 2
  writes "once per process" into the `systemOne.ts` docstring. The
  controller may want the spec §2 block amended to match.
- 2026-11-22 — D5 (holds task 5, budget path only). Every classify call
  must go through `callClassify` (`src/utils/llmCall.ts:72-79`). That
  wrapper throws `WikiBudgetExhausted` when the meter cannot fit the
  request. Spec §4 says any classifier throw empties `settled` and the
  batch falls through. Today `runResolve` turns a tight meter into a
  `budgetStop` (`__tests__/opsResolve.test.ts:125`). Question: does a
  budget exhaustion during the screen surface as `budgetStop`, or fall
  through like any other throw? The plan author recommends `budgetStop`,
  because the generative leg would hit the same meter. The spec's
  `warnReason` union has no value for a classifier throw. The plan maps a
  non-budget throw to `'no-classifier'`, which adds no new union member.
