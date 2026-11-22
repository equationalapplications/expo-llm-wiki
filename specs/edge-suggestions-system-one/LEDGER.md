# Edge suggestions from System-One — ledger

In flight: nothing

- [ ] 1. Baseline check — evidence: <test run>
- [ ] 2. Config surface (§1, §2, §9) — evidence: <commit, test run>
- [ ] 3. `resolveSystemOneEdges` (test plan 1, first half) — evidence: <commit, test run>
- [ ] 4. `resolveEdgesMinConfidence` (test plan 1, second half; 18, third clause) — evidence: <commit, test run>
- [ ] 5. Public exports — evidence: <commit, test run>
- [ ] 6. Mode, floor, and `shortlistK` plumbing — evidence: <commit, test run>
- [ ] 7. Compatibility pins (test plan 4, 5, 10) — evidence: <commit, test run>
- [ ] 8. Edge-question map construction (test plan 8, 16 first half, 17) — evidence: <commit, test run>
- [ ] 9. Band evaluation and edge conversion (test plan 2, 15, 16 second half, 18) — evidence: <commit, test run>
- [ ] 10. Invalid and missing answers, edge-site diagnostics (test plan 7, 21) — evidence: <commit, test run>
- [ ] 11. Overflow retry-once (test plan 20) — evidence: <commit, test run>
- [ ] 12. Escalation gate plumbing (test plan 3, 6, 11, 12, 13, 14, 19) — evidence: <commit, test run>
- [ ] 13. Vocabulary and untouched files (test plan 9) — evidence: <test run, diff output>
- [ ] 14. Docstrings (§9) — evidence: <commit>
- [ ] 15. Host docs (§9) — evidence: <commit>
- [ ] 16. Suite health — evidence: <test run with file and test counts>
- [ ] 17. Cleanup commit — evidence: <commit>

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