# Step 9: The ontology-backfill prompt cap joins the context budget — ledger

In flight: task 6 (invariant sweep), task 7 (suite health), task 8 (cleanup)

- [x] 1. Reconcile the baseline (253 files / 2963 tests at `2b69852a`) — evidence: controller baseline run 2026-11-22 11:21Z, exit 0, `.superpowers/sdd/step9-backfill-cap/baseline-core.log`
- [x] 2. Verify the existing pins before any change (spec test items 1, 2) — evidence: implementer pre-change run 73 tests pass (task-3-report.md); pins verified untouched in diff
- [x] 3. Move the constant to the leaf caps module (spec change 1) — evidence: commit bb787ad1; typecheck exit 0
- [x] 4. Add the `'backfill'` resolver operation (spec change 2, spec test item 3) — evidence: commit 72c0a628; RED R1 24000!=40000, GREEN 43 tests (task-3-report.md)
- [x] 5. Wire the backfill site to the resolver (spec change 3, spec test items 4, 5) — evidence: commit 8978d4cc; RED B1/F1, GREEN 89 tests; controller suite 254 files / 2969 tests exit 0
- [ ] 6. Verify the invariants I1–I5 and the diff scope — evidence: <command output>
- [ ] 7. Verify suite health (spec test item 6; expected 254 files / 2969 tests) — evidence: <test run>
- [ ] 8. Write the cleanup commit (`specs/README.md` lifecycle step 4) — evidence: <commit>

## Discrepancies
