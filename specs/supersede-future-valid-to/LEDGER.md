# supersede/reopen — ledger

In flight: nothing (implementation done; awaiting review loops)

- [x] 1. Migration v18 helper, schema, Rust pin — evidence: schema v18 helper commit; `vitest run __tests__/migration18.test.ts`, cargo test via lock green
- [x] 2. Repository plumbing + types — evidence: commit 'supersede records the replaced end'
- [x] 3. supersedeInTx records prior end — evidence: `vitest run __tests__/supersede.test.ts`
- [x] 4. Diagnostic + emission — evidence: `vitest run __tests__/opsLibrarian.test.ts`
- [x] 5. reopen() — evidence: `vitest run __tests__/reopen.test.ts` (18 tests)
- [x] 6. Export/import/OKF — evidence: `vitest run __tests__/temporalRoundTrip.test.ts`
- [x] 7. Docs — evidence: docs commit
- [x] 8. INTENT amendment — evidence: INTENT rule 12 amendment 2026-11-23
- [x] 9. Full verification — evidence: core suite 3127/3128 then fixed fixture; `pnpm -r typecheck` clean

## Discrepancies

## Review r1 (T4, 2026-11-23)

- [x] Import replaces (absent key imports null; null when not superseded); supersede always writes prior_valid_to — evidence: this commit; `vitest run` temporalRoundTrip/supersede/reopen/opsLibrarian 69 passed; full core suite 260 files, 3130 tests passed via lock.
