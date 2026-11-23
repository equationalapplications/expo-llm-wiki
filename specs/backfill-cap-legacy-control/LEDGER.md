# Legacy-control runs for the backfill-cap B1/B2 tests — ledger

In flight: nothing (awaiting review loops)

- [x] 1. B1-control and B2-control tests — evidence: 61006144; `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/contextBudgetBackfill.test.ts` 8/8
- [x] 2. Mutation check (red recorded, reverted) — evidence: with both bodies changed to MAX/2 - 3000, B1-control RED (AssertionError: expected 1 to be 2), B1 green (7 passed, 1 failed); mutation reverted via git checkout, never committed
- [x] 3. Parent spec test-plan note — evidence: 245ce867
- [x] 4. Full core suite + typecheck — evidence: core suite 3096 passed + 1 timeout flake (idThreading B5, 5s under load; passes 13/13 alone), 3097 total; core typecheck clean

## Discrepancies

- 2026-11-23 — spec has no "Open questions" section; nothing to record as answers.
