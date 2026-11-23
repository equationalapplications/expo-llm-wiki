# In-place update provenance — ledger

In flight: 4 UPDATE-in-place writer

- [x] 1. Schema + v18 migration + Rust pin + helpers — evidence: d7807b4b; vitest derivedEvents/migrations/migration17/setupBudget/sourceRefNormalize pass; cargo test graphrag-core all ok
- [x] 2. WikiFact field, mapper, upserts (presence flag), outbox — evidence: d7807b4b; vitest run __tests__/derivedEvents.test.ts (9 pass)
- [x] 3. Widened EVENT_MATCH_SQL + malformed-row tests — evidence: f03fcb96; vitest run __tests__/derivedEvents.test.ts __tests__/forgetEventId.test.ts (33 pass)
- [ ] 4. UPDATE-in-place writer + unresolved-merge diagnostic — evidence:
- [ ] 5. UPDATE-as-SUPERSEDE inheritance — evidence:
- [ ] 6. Apply-time re-check + source_event_gone — evidence:
- [ ] 7. Dump export/import + derived_events_invalid — evidence:
- [ ] 8. OKF emit/parse — evidence:
- [ ] 9. Docs, as-landed notes, INTENT amendment — evidence:
- [ ] 10. Full suite, typecheck, cargo, PR body — evidence:

## Discrepancies

