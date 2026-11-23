# Type on write — ledger

In flight: task 8 (verify counters)

- [x] 1. Byte-identity fixtures on unmodified code — evidence: 4f50455d; `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/promptByteIdentity.test.ts` 2 passed
- [x] 2. Opt-in key and resolver — evidence: d853c9cf; `vitest run __tests__/systemOneConfig.test.ts` 67 passed
- [x] 3. Rule-12 receipts — evidence: 1f93ec21; `vitest run __tests__/librarianRule12Receipts.test.ts __tests__/ontologyReceiptVocabulary.test.ts __tests__/opsLibrarian.test.ts __tests__/librarianLegacyParity.test.ts ...` 94 passed
- [x] 4. Template split — evidence: 60fd513b; `vitest run __tests__/promptByteIdentity.test.ts __tests__/promptTemplateSplit.test.ts` + 36 related files 444 passed; `tsc --noEmit` clean
- [x] 5. Shared typing module — evidence: 01afb24f; `vitest run __tests__/typeOnWriteModule.test.ts __tests__/services` 245 passed; backfill/classifier-filtered run across __tests__ 88 passed; tsc clean
- [x] 6. Legacy integration — evidence: b4f09f6c; `vitest run __tests__/typeOnWriteLibrarian.test.ts` 20 passed (legacy); librarian/ground/ontology/diagnostics suites green; tsc clean
- [x] 7. Ops integration — evidence: 43b95731; `vitest run __tests__/typeOnWriteLibrarian.test.ts __tests__/typeOnWriteOps.test.ts` 39 + 11 passed; ops/librarian/ground/runPending/systemOne/classifier suites green
- [ ] 8. Counters, scheduler, getInstructions — evidence:
- [ ] 9. Docs and INTENT rule 12 — evidence:
- [ ] 10. Full verification and PR body — evidence:

## Discrepancies
