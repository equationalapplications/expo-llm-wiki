# Legacy-control runs for the backfill-cap B1/B2 tests — plan

Spec: `specs/backfill-cap-legacy-control/spec.md`

1. Add B1-control and B2-control to the `declared backfill boundary` describe in `packages/core/__tests__/contextBudgetBackfill.test.ts` — verify: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/contextBudgetBackfill.test.ts`.
2. One-off mutation check (not committed): shrink B1 bodies under 40_000 total; B1-control red, B1 green; revert.
3. Append the one-line note to test plan item 4 of `specs/backfill-cap-context-budget/spec.md`.
4. Full core suite and `pnpm -r typecheck` once through the lock; update PR body.
