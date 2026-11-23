# supersede/reopen — plan

Spec: `specs/supersede-future-valid-to/spec.md`

1. Migration v18 helper + schema.ts + Rust pin — `migrations.ts`, `schema.ts`, `schema_check.rs`; test `migration18.test.ts`; `cargo test` via lock.
2. Repository plumbing + types — `EntryRepository.ts`, `types.ts`.
3. supersedeInTx records prior end — `TemporalService.ts`; `supersede.test.ts`.
4. Diagnostic code + emission (host and librarian) — `diagnostics.ts`, `apply.ts`; `opsLibrarian.test.ts`.
5. `reopen()` + reasons — `TemporalService.ts`, `WikiMemory.ts`; `reopen.test.ts`.
6. Export/import/OKF — `formatOkfBundle.ts`, `parseOkfBundle.ts`, `ImportExportService.ts`; `temporalRoundTrip.test.ts`.
7. Docs (D7) + JSDoc.
8. INTENT.md rule 12 amendment.
9. Full suite, typecheck, cargo test, PR body.
