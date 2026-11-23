# Ingest-time typing — ledger

In flight: 8

- [x] 1. Compat pins on unmodified code — evidence: this commit (recorded on unmodified code); `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/ingestTypingCompat.test.ts` 40 passed
- [x] 2. `ingest_zero_facts` gate fix — evidence: this commit (folded into 6); test red with the old `ontologyContext !== null` gate, green with the mode gate: `vitest run __tests__/typeOnIngest.test.ts -t ingest_zero_facts`
- [x] 3. Config key, resolver, export — evidence: this commit; `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/typeOnIngestConfig.test.ts` 21 passed with typeOnWriteModule
- [x] 4. Shared engagement, concurrency opt, counters type — evidence: this commit; same command, `tsc --noEmit` clean
- [x] 5. `normalizeForWrite` on both write paths — evidence: this commit; `vitest run` ingest*, groundingIngest*, diagnosticsIngest, graphOwnershipIngest, ontologyReceipts, contextBudgetIngest, promptByteIdentity, typeOnWrite* 210 passed; compat pins unchanged (plus explicit writer:llm delta test)
- [x] 6. Engagement hoist, prompt, getInstructions — evidence: this commit; `vitest run __tests__/typeOnIngest.test.ts` 29 passed
- [x] 7. Typing stage, receipts, counters — evidence: this commit; same command (Test plan 5-13)
- [ ] 8. Docs and docs pin — evidence:
- [ ] 9. Full suite and typecheck — evidence:

## Discrepancies

