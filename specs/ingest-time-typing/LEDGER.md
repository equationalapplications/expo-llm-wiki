# Ingest-time typing — ledger

In flight: 6 (engagement hoist, prompt, getInstructions, ingest_zero_facts gate)

- [x] 1. Compat pins on unmodified code — evidence: this commit (recorded on unmodified code); `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/ingestTypingCompat.test.ts` 40 passed
- [ ] 2. `ingest_zero_facts` gate fix — evidence:
- [x] 3. Config key, resolver, export — evidence: this commit; `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/typeOnIngestConfig.test.ts` 21 passed with typeOnWriteModule
- [x] 4. Shared engagement, concurrency opt, counters type — evidence: this commit; same command, `tsc --noEmit` clean
- [x] 5. `normalizeForWrite` on both write paths — evidence: this commit; `vitest run` ingest*, groundingIngest*, diagnosticsIngest, graphOwnershipIngest, ontologyReceipts, contextBudgetIngest, promptByteIdentity, typeOnWrite* 210 passed; compat pins unchanged (plus explicit writer:llm delta test)
- [ ] 6. Engagement hoist, prompt, getInstructions — evidence:
- [ ] 7. Typing stage, receipts, counters — evidence:
- [ ] 8. Docs and docs pin — evidence:
- [ ] 9. Full suite and typecheck — evidence:

## Discrepancies

