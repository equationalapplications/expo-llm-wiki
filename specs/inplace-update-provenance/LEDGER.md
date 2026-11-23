# In-place update provenance — ledger

In flight: nothing (orchestrator review loops next)

- [x] 1. Schema + v18 migration + Rust pin + helpers — evidence: d7807b4b; vitest derivedEvents/migrations/migration17/setupBudget/sourceRefNormalize pass; cargo test graphrag-core all ok
- [x] 2. WikiFact field, mapper, upserts (presence flag), outbox — evidence: d7807b4b; vitest run __tests__/derivedEvents.test.ts (9 pass)
- [x] 3. Widened EVENT_MATCH_SQL + malformed-row tests — evidence: f03fcb96; vitest run __tests__/derivedEvents.test.ts __tests__/forgetEventId.test.ts (33 pass)
- [x] 4. UPDATE-in-place writer + unresolved-merge diagnostic — evidence: e4a16e6a; vitest run __tests__/derivedEvents.test.ts (20 pass) + opsLibrarian/sourcePointers/librarianLegacyParity/opsResolve/publicExports (73 pass)
- [x] 5. UPDATE-as-SUPERSEDE inheritance — evidence: e4a16e6a; vitest run __tests__/derivedEvents.test.ts (20 pass) + opsLibrarian/sourcePointers/librarianLegacyParity/opsResolve/publicExports (73 pass)
- [x] 6. Apply-time re-check + source_event_gone — evidence: e4a16e6a; vitest run __tests__/derivedEvents.test.ts (20 pass) + opsLibrarian/sourcePointers/librarianLegacyParity/opsResolve/publicExports (73 pass)
- [x] 7. Dump export/import + derived_events_invalid — evidence: 35b3c51b; vitest run __tests__/derivedEvents.test.ts __tests__/okfReimport.test.ts __tests__/sourcePointers.test.ts (50 pass)
- [x] 8. OKF emit/parse — evidence: 35b3c51b; vitest run __tests__/derivedEvents.test.ts __tests__/okfReimport.test.ts __tests__/sourcePointers.test.ts (50 pass)
- [x] 9. Docs, as-landed notes, INTENT amendment — evidence: docs commit on branch (INTENT amendment, guides, two as-landed notes); test 14 = librarianLegacyParity pass, 15/16 in derivedEvents.test.ts (25 pass)
- [x] 10. Full suite, typecheck, cargo, PR body — evidence: 90702d5d; core suite first run 3118/3120 (2 stale v17/arity fixtures fixed, re-verified 45 pass); typecheck core clean; rerun of eraseAcceptance blocked by host disk quota (SqliteError disk I/O / EDQUOT), see Discrepancies

## Discrepancies

- 2026-11-23 — Final full-suite rerun hit EDQUOT on the shared /tmp (eraseAcceptance.test.ts: 13 failures, all `SqliteError: disk I/O error`; the same file passed in the first full run). Environmental, not a code regression; re-run when quota frees. Also deleted this worktree's regenerable crates/graphrag-core/target (390M) to free space; cargo test had passed 18/18 suites before.
