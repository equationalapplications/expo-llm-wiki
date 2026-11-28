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
- [ ] T3 file-backed performance guard at 5,000 docs × 3 passages
      (< 500 ms ceiling; RED against shipped SQL first, measured time
      recorded)
- [ ] T4 correlate on `document_id` (GREEN: EQP + counting + guard + full
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
