# context-budget (PR 7a) — ledger

In flight: nothing (T1–T7 implemented on branch `spec/context-budget`; gates green 2026-11-21)

- [x] 1. T1 — byte-identity pins pre-change — evidence: `packages/core/__tests__/contextBudgetByteIdentity.test.ts` (10 tests, literals captured pre-change); commit `test(context-budget): T1 byte-identity + batch-boundary pins (pre-change captures)`
- [x] 2. T2 — ContextBudget type + estimateTokensWith — evidence: `packages/core/__tests__/contextBudget.test.ts` (byte-equal to `estimateTokens` under legacy); commit `feat(context-budget): add ContextBudget type and estimateTokensWith wrapper`
- [x] 3. T3 — config/context.ts resolver (legacy/declared, floors, throws) — evidence: `packages/core/__tests__/configContext.test.ts` (28 tests); commit `feat(context-budget): add config/context.ts resolver with legacy/declared modes`
- [x] 4. T4 — WikiConfig.context + four cap swaps + selectBatch budget param — evidence: typecheck green; legacy pins unchanged after swaps; commit `feat(context-budget): wire config.context through selectBatch/runResolve/heal cap sites (fail-fast at construction)`
- [x] 5. T5 — index.ts export surface — evidence: runtime spot-import test in `contextBudget.test.ts` (T5 export surface); commit `feat(context-budget): export context-budget resolver surface from core index` (T5 exports + T6 tests share this commit)
- [x] 6. T6 — remaining tests (precedence, meter independence, backfill exclusion) — evidence: `packages/core/__tests__/contextBudgetIngest.test.ts`, `packages/core/__tests__/contextBudgetE2E.test.ts` (declared scaling + construction fail-fast)
- [x] 7. T7 — gates + diff sweep — evidence: `pnpm -r typecheck` exit 0 (after building sibling dists); full unit suite green: core 245 files / 2838 tests, all other packages green; diff vs `origin/spec/context-budget` contains only the Files-touched set (as amended) plus `WikiMemory.ts`/`engineDefaults.ts` carrying the plan's sanctioned construction-path fail-fast (T4, r2); no `estimateTokens` call-site change; `MaintenanceService.ts:2144` untouched

## Discrepancies

- (none)
