# LEDGER — source-store-passage-count (PR #490)

In flight: **plan APPROVED (Kurt, msg `1576084081173594154`) — implement
in the NEXT session** per handoff
`records/handoffs/2026-11-28-handoff-pr490-implement-source-store-passage-count.md`
(vault). No implementation started in the planning session. Plan review
converged (r1 REQUEST CHANGES → r2 APPROVE WITH NITS, spend $0.8642).
Owner notes folded 2026-11-28: LEDGER synced to plan T1–T6; Task 1 step 5
skippable when Task 3's RED run supplies the shipped-path number.
Spec: Reviewed (owner-approved 2026-11-28, msg `1576081158758998158`).

- [x] T1 hoist `listStoredSourcesSql(prefix)` builder + EQP pin test (RED
      evidence = failed `toContain`, never a throw; step 5 optional per
      plan)
- [x] T2 counting regression tests (0 and 3 passages, `id` columns first)
- [x] T3 file-backed performance guard at 5,000 docs × 3 passages
      (< 500 ms ceiling; RED against shipped SQL first, measured time
      recorded)
- [x] T4 correlate on `document_id` (GREEN: EQP + counting + guard + full
      suite; file-backed fixed-path time recorded; spec Errata numbers)
- [ ] T5 gates: `pnpm build`, `pnpm exec tsc --noEmit`,
      `grep listStoredSourcesSql packages/core/dist/index.d.ts` → nothing,
      root `pnpm test`
- [ ] T6 final probe numbers into spec Errata; cleanup commit (Status →
      Implemented, plan/LEDGER deleted) before `gh pr ready`

Reconciliation rule (specs/README.md): a box ticks only after its
verification passes, as a step of the implementation loop.

## Verification log

- **T1 ✓ 2026-11-28** — `dd8b37a2` builder hoist (SQL byte-identical),
  `594e67f8` EQP pin. RED re-verified by controller at `594e67f8`: fast
  loop EXIT=1, `Tests 1 failed | 8 passed (9)`, failure is
  `AssertionError: expected 'SEARCH d USING INDEX llm_wiki_idx_sou…' to
  contain 'idx_source_passages_doc'` (assertion, not a throw). Shipped
  plan pinned: `SEARCH p USING INDEX llm_wiki_idx_source_passages_entity`.
  origin == HEAD readback `594e67f8`. Step 5 skipped per owner note.
- **T2 ✓ 2026-11-28** — `ddcdee07` counting regression test (raw SQL,
  `id` first, all 14 columns filled, `document_id` == doc `id`; asserts
  `[0, 3]` over deterministic refs). Controller re-verified at
  `ddcdee07`: fast loop EXIT=1 with ONLY the T1 pin failing,
  `Tests 1 failed | 9 passed (10)` — the new counting test passes against
  shipped SQL as the plan prescribes. Existing "passageCount 0" test
  untouched. origin == HEAD readback `ddcdee07`.
- **T3 ✓ 2026-11-28** — `54cd8656` file-backed guard (dedicated
  `WikiMemory` handle, 5,000 × 3 raw-SQL seed in one transaction,
  `afterAll` closes DB then removes file + sidecars — verified: no tmp
  residue). RED re-verified by controller at `54cd8656`: fast loop EXIT=1
  with exactly 2 failures (T1 pin + guard), guard fails on the measured
  assertion `listStoredSources took 10262 ms: expected 10262.030483 to be
  less than 500` (not a throw). **Shipped-path Errata figure: 10,414 ms**
  (T3 RED, file-backed; controller's own run 10,262 ms). This supplies
  the Task 1 step 5 number per the owner note. origin == HEAD readback
  `54cd8656`.
- **T4 ✓ 2026-11-28** — `1cc8c513`: builder predicate now
  `WHERE p.document_id = d.id` (entity predicate deleted); spec Errata
  gains the repo-run file-backed numbers (shipped 10,414 ms / fixed
  15 ms, 5,000 × 3). Controller re-verified at `1cc8c513`: fast loop
  EXIT=0 **11/11** (pin + counting + guard, zero assertion edits), core
  suite EXIT=0 **275 files / 3431 tests** (baseline 3428 + 3 new),
  typecheck EXIT=0. origin == HEAD readback `1cc8c513`.
