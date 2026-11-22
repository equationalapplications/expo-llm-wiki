# Step 9: The ontology-backfill prompt cap joins the context budget — ledger

In flight: nothing

- [ ] 1. Reconcile the baseline (253 files / 2963 tests at `2b69852a`) — evidence: <test run>
- [ ] 2. Verify the existing pins before any change (spec test items 1, 2) — evidence: <test run>
- [ ] 3. Move the constant to the leaf caps module (spec change 1) — evidence: <commit, test run>
- [ ] 4. Add the `'backfill'` resolver operation (spec change 2, spec test item 3) — evidence: <commit, red run, green run>
- [ ] 5. Wire the backfill site to the resolver (spec change 3, spec test items 4, 5) — evidence: <commit, red run, green run>
- [ ] 6. Verify the invariants I1–I5 and the diff scope — evidence: <command output>
- [ ] 7. Verify suite health (spec test item 6; expected 254 files / 2969 tests) — evidence: <test run>
- [ ] 8. Write the cleanup commit (`specs/README.md` lifecycle step 4) — evidence: <commit>

## Discrepancies
