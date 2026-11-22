# Edge suggestions from System-One — ledger

In flight: nothing

- [x] 1. Baseline check — evidence: full suite 254 files / 2969 tests passed (70.55s); typecheck (`tsc --noEmit`) clean, no output.
- [x] 2. Config surface (§1, §2, §9) — evidence: 06b282b6 (wave 1). Added type-case test in `systemOneConfig.test.ts`; before the change `tsc --noEmit` on the test file reported 4 `edges` errors, after: 0. `pnpm typecheck` clean; `systemOneConfig.test.ts` + `engineDefaults.test.ts` 60/60 pass. Note: `tsconfig` `include` is `src` only, so `pnpm typecheck` cannot see test files; the pre-change failure was shown by running `tsc` directly on the test file.
- [x] 3. `resolveSystemOneEdges` (test plan 1, first half) — evidence: 06b282b6. 3 tests written first (all 8 new resolver tests failed red: not a function); after the change `systemOneConfig.test.ts` passes.
- [x] 4. `resolveEdgesMinConfidence` (test plan 1, second half; 18, third clause) — evidence: 06b282b6. 5 tests written first (red), then green; `systemOneConfig.test.ts` + `engineDefaults.test.ts` 2 files / 60 tests pass, `engineDefaults.test.ts` unchanged. Note: `formatConfigValue` renders NaN and Infinity both as `null`, so their warn messages collide under `warnOnce`; the test expects 1 warn for NaN and 0 further for Infinity (shared message). Resolver still returns `undefined` for both.
- [x] 5. Public exports — evidence: dd4c0a49 (wave 2). `publicExports.test.ts` does not enumerate resolver names, so added 1 case to `systemOneConfig.test.ts` (import both from `../src/index`); ran red first (`-t "public export"` failed, resolvers undefined), then added both to the `./utils/engineDefaults` block in `index.ts`; `systemOneConfig`, `publicExports`, `export`, `graphOwnershipExports` pass.
- [x] 6. Mode, floor, and `shortlistK` plumbing — evidence: dd4c0a49. Baseline `ontologyBackfill`/`classifierBackfill`/`contextBudgetBackfill` 3 files / 58 tests green before the change, green after. `MaintenanceService.ts`: edge mode + floor resolved once beside the typing chain; `shortlistK`, `edgeSiteMode`, `edgeMinConfidence` passed to `_runClassifierBackfill`; `edgeSiteMode`/`edgeMinConfidence` in `runOpts` at both generative call sites; `edgeSiteMode` asserted like `shortlistK`. No existing test pins the `shortlistK` assert, so no sibling case added. `pnpm typecheck` clean.
- [x] 7. Compatibility pins (test plan 4, 5, 10) — evidence: dd4c0a49. 5 tests in new `classifierEdgeScreen.test.ts`, written before any screen code, all pass: request is exactly `{ okf_type }` with zero pool reads (legacy auto, `systemOne.typing: 'auto'`, explicit `edges: 'llm'`); typing `'llm'` + edges auto prompts equal baseline, classify uncalled; no-classify + edges auto prompts equal baseline; legacy-only pass equals explicit `edges: 'llm'` (counters + diagnostic codes); escalation-leg prompt contains the classifier-typed fact. Narrower than plan: the item-10 comparison covers counters and diagnostic codes, not persisted edges (no edge-bearing fixture before task 9), and the byte-identical `runBatched` args are checked via generative prompts rather than a `runBatched` spy. Re-run after task 8: still 5/5.
- [x] 8. Edge-question map construction (test plan 8, 16 first half, 17) — evidence: dd4c0a49. 6 tests written first; 6 red (empty edge keys), then green after the `_runClassifierBackfill` change (pool read once in-step before `withConcurrency`; collision set = pool titles shared by 2+ rows plus every batch fact's title per D3; target-side `typeSatisfies` filter; one question per unique (edge type, candidate) with key map). Targeted run: 10 files / 151 tests pass (`classifierEdgeScreen`, `classifierBackfill`, `ontologyBackfill`, `contextBudgetBackfill`, `classifierDiagnostics`, `systemOneConfig`, `publicExports`, `export`, `graphOwnershipExports`, plus `engineDefaults`-adjacent). `pnpm typecheck` clean. Answers to edge questions are not read yet (task 9).
- [x] 9. Band evaluation and edge conversion (test plan 2, 15, 16 second half, 18) — evidence: 849c94e4 (wave 3). 4 tests written first; run red with the rest of the wave (13 of 30 failing in `classifierEdgeScreen.test.ts`), green after the `_runClassifierBackfill` change (per-answer `validateClassifierAnswer`, source-type discard, directional band, `edges` key only when the site mode is `'auto'`). Targeted run (`classifierEdgeScreen`, `classifierBackfill`, `ontologyBackfill`, `classifierDiagnostics`, `contextBudgetBackfill`, `ontologyReceiptVocabulary`): 6 files, 97 passed, 1 todo. `pnpm typecheck` clean.
- [x] 10. Invalid and missing answers, edge-site diagnostics (test plan 7, 21) — evidence: behavior implemented and green (item 7, item 21, volume pin: one diagnostic per fact; all-missing keeps typing, no generative leg, `classification_invalid`; partial missing counts as invalid). Ticked after D4 resolution (reason markers accepted; `it.todo` retargeted to a real test asserting `detail.reason` markers, no `site` key, no counts; `classifierEdgeScreen.test.ts` 31/31, full core suite 255 files / 3010 passed, 0 todo). Former block: D4 — the spec's `detail.site: 'edge_screen'` and the per-fact counts cannot be emitted because `WikiDiagnosticDetail` is closed and `types.ts` is frozen (I3). Interim: edge site marked by `detail.reason` (`edge_uncertain`, `edge_answer_invalid`, `edge_answers_missing`); `it.todo` holds the count/site assertion.
- [x] 11. Overflow retry-once (test plan 20) — evidence: behavior implemented and green (retry succeeds / retry overflows = pre-PR `overflow_skip` with detail `{ factId }` / retry non-overflow error = threw / retry `WikiBudgetExhausted` = unattempted + stopped / no-edge-question overflow never retried; 5 tests). Ticked after D4 resolution (marker `reason: 'edge_screen_overflow_retry'` accepted; retry tests green in the 31/31 run). Former block: same D4 block for `detail.site: 'edge_screen'` on the successful-retry `context_overflow_skipped`; interim marker `reason: 'edge_screen_overflow_retry'`.
- [x] 12. Escalation gate plumbing (test plan 3, 6, 11, 12, 13, 14, 19) — evidence: 849c94e4 (wave 3). 7 tests; gate is now `classifierRun.escalated.length > 0` (live-mode re-check kept inside), `isEscalated` = accepted-with-fallthrough OR (`onLowConfidence: 'llm'` AND abstain/low_confidence) and drives `escalated`, `attempted` and `abstainCount`; the classifications build excludes fallthrough outcomes. Item 14 re-pointed per D1 ruling. Full suite: 255 files, 3009 passed, 1 todo (baseline 2969). `pnpm typecheck` clean.
- [x] 13. Vocabulary and untouched files (test plan 9) — evidence: `git diff --stat c0aa79e3` over OntologyService.ts, types.ts, utils/diagnostics.ts, prompts.ts, ontologyReceiptVocabulary.test.ts printed nothing; over `packages/core/src` it lists only config/systemOne.ts, index.ts, MaintenanceService.ts, utils/engineDefaults.ts (no ingest/librarian files).
- [x] 14. Docstrings (§9) — evidence: 45fa872b. `_runClassifierBackfill` docstring updated in MaintenanceService.ts; the gate comment (~:2190) already reflects conjunct removal from wave 3; `systemOne.ts` typing docstring already carries the `edges: 'auto'` caveat.
- [x] 15. Host docs (§9) — evidence: 45fa872b. `apps/docs/.../reference/configuration.md` gains `systemOne.edges` and `systemOne.minConfidence.edges` rows; typing row caveat added. Ontologies guide and ROADMAP not touched (outside this run's scope).
- [ ] 16. Suite health — evidence: <test run with file and test counts>
- [ ] 17. Cleanup commit — evidence: <commit>
  → RESOLVED (controller, 2026-11-22): option (b) ACCEPTED — the typed `detail.reason` marker carries the edge-site signal (`edge_uncertain`, `edge_answer_invalid`, `edge_answers_missing`, `edge_screen_overflow_retry`); `types.ts` stays frozen (I3) and `edgeStats` remain internal. Spec §4/§6 amended accordingly; boxes 10/11 may now be ticked; the it.todo is retargeted to assert the reason markers.

## Close-out fixes (2026-11-22)

Source: Opus implementation review (impl rung, $0.72 / 13 turns). Not committed.

- m1: the screened `candidate.id` now rides the classification (`edgeCandidateIds`, keyed by normalized target title). After the in-tx title index is built, `_applyOntologyBackfillBatch` drops an edge whose title now binds to a different id, through the existing `edge_dropped` path. Test written first (red: `edgesAdded` 1, expected 0) in `classifierEdgeScreen.test.ts` "retarget-race guard"; the fixture writes a same-title typed fact inside the classify stub. Discrepancy: `EdgeDropReason` and `WikiDiagnosticDetail` are closed (I3), so the drop uses reason `target_not_found`; the id mismatch is not named in `detail`.
- m2: the floor resolver now runs only when edges is `'auto'`, typing is `'auto'`, and `classify` is a function. Added a test that an inert (typing `'llm'`) pass logs no missing-floor warning. Docs row for `systemOne.edges` gains the prerequisite.
- m4: evidence SHAs filled in.
- m5: removed the redundant `edgeSiteMode === 'auto'` conjunct and the unread `edgeStats.asked`; commented the kept `runOpts.edgeSiteMode` guard.

## Discrepancies

Open questions for the controller. Each blocks only the named part of its task.

- 2026-11-22 — D1 (blocks task 12, item 14). The spec contradicts itself.
  §5 evaluates edge answers only for typing-accepted facts. So a typing
  escalation can never also carry `edge_fallthrough`. Test plan 14 requires
  a fact that is both. The planner cannot build that fixture. Proposed
  re-pointing: a low-confidence fact under `onLowConfidence: 'llm'`, with
  uncertain edge answers, joins `escalated` exactly once. It gets one
  generative decision, and its edge answers emit no edge-site diagnostic.
  The controller confirms this reading, or amends §5 or test 14.
- 2026-11-22 — D2 (blocks task 10, item 21's code assertion). §6 emits
  `classification_invalid` when any edge answer is "malformed". It does not
  say whether `missing_answer` counts as malformed. The all-missing fact
  therefore has no named code. §6's cost note mentions a "warn-severity
  diagnostic" for that shape, which suggests `classification_invalid`. The
  controller picks `classification_invalid` (warn) or
  `classification_low_confidence` (info) for the all-missing fact.
- 2026-11-22 — D4 (blocks tasks 10 and 11, the `detail` shape only). §6 and
  §4 require edge-site diagnostics to carry `detail.site: 'edge_screen'` plus
  asked/uncertain/invalid/missing counts. `WikiDiagnosticDetail`
  (`types.ts:979`) is a closed interface with no `site` or count keys, and
  I3 freezes `types.ts` (and `diagnostics.ts`). Emitting them needs a cast or
  a type edit. Interim: the edge site rides the existing typed
  `detail.reason` (`edge_*` values); counts are computed in `edgeStats` but not
  emitted. The controller rules: amend `types.ts` (adding optional `site` and
  count keys, no new code) or accept the `reason`-based marker and amend §6.
- 2026-11-22 — D3 (blocks task 8's batch-collision set). §4 skips a candidate
  whose normalized title matches "any OTHER fact in this pass's batch". The
  source fact itself can share that title too. The intra-transaction index
  update at `MaintenanceService.ts:2778` then overwrites the entry with the
  source fact. The edge would resolve to a self-edge. Should the collision
  set include the source fact's own title? The planner recommends yes: use
  every batch fact's title. That reading departs from the word "OTHER".
  → RESOLVED (controller, 2026-11-22): classification_invalid (warn) for the all-missing fact — missing_answer is a malformed-shaped answer and the info-level code would understate it. detail distinguishes missing vs malformed. Consistent with §6's warn-severity cost note.
  → RESOLVED (controller, 2026-11-22): ADOPTED — the collision set includes EVERY batch fact's title, including the source fact's own. §4's word 'OTHER' was too narrow; a self-edge via the :2778 intra-tx overwrite is exactly the permanent-graph garbage posture A guards against. Spec §4 wording to be amended in the PR's spec touch-ups if needed.

  → RESOLVED (controller, 2026-11-22): re-pointing APPROVED. Test 14 becomes: a low-confidence fact under onLowConfidence 'llm', with uncertain edge answers discarded, joins escalated exactly once, gets one generative decision, and emits no edge-site diagnostic. The rung-4 fix (edge answers evaluated only for typing-accepted facts) makes the compound shape impossible by design; §5 stands, test 14 is re-pointed.