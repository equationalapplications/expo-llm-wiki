# In-place update provenance — plan

Spec: `specs/inplace-update-provenance/spec.md`

Test command base: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run <file>`

1. Schema + v18 migration (helper `addDerivedEventsColumn`) + Rust pin 18 + `parseStoredDerivedEvents`/serialize/validate helpers — `db/schema.ts`, `db/migrations.ts`, `utils/derivedEvents.ts`, `schema_check.rs`; tests 1, 8 (helper level); `cargo test` via lock.
2. `WikiFact.derived_events`, row mapper, both `upsert` paths (presence flag on import), outbox payload — `types.ts`, `EntryRepository.ts`; test 13 and import-presence test.
3. Widened `EVENT_MATCH_SQL` (json_each term under its own guard); the three repository methods and dryRun inherit; malformed-row tests; `forgetEventId.test.ts` stays green; tests 7, 8, 9.
4. `apply.ts` UPDATE-in-place writer, dedupe, `source_pointer_unresolved` on unresolved merge; tests 2, 3, 4.
5. `apply.ts` UPDATE-as-SUPERSEDE inheritance; plain SUPERSEDE untouched; tests 5, 6.
6. Apply-time re-check + `source_event_gone`; test 10.
7. Dump export/import + `derived_events_invalid`; test 11.
8. OKF frontmatter emit/parse + dropped-value report; test 12.
9. Docs (diagnostics, deleting-data, maintenance, okf, types, glossary, README), as-landed notes in the two referenced specs, INTENT dated amendment; tests 14, 15, 16.
10. Full suite + typecheck + cargo test through the lock; PR body.
