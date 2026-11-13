# Librarian guidance and the general leave-out rule — ledger

In flight: 9 (docs), 10 (cleanup)

- [x] 1. Golden strings fixture + generator — evidence: commit after this one; generator re-run diffs empty (verified in-session)
- [x] 2. Config types (guidance, guidanceForEntity, deprecation, diagnostic codes + detail fields) — evidence: commit 8eed8f93; `pnpm typecheck` green (only pre-existing parseOkfBundle/core-okf error)
- [x] 3. Constants (GUIDANCE_MAX_CHARS, rule sentence) — evidence: commit 8eed8f93; librarianGuidance.test.ts asserts the ruled sentence text and cap boundary behavior
- [x] 4. PromptService threading + marked section + rule sentence — evidence: commit 8eed8f93; golden fixture re-captured post-change diffs EMPTY (no-guidance byte parity); 18 placement/resolution tests pass
- [x] 5. Resolution seams — evidence: commits c01c7809 + 9035ae14; scheduler-path test drives `maintenanceScheduler.run` (default AND per-entity resolver guidance asserted on the built prompt); grounding-corpus tests for ops/legacy/heal writers + behavioural ingest case; 12 harness tests green; full suite 211 files / 2426 tests, 0 failures; golden fixture diff-empty
- [x] 6. Warning messages (updated + explicit-ops) — evidence: commit 8eed8f93; librarianGuidance.test.ts 'upgrade warnings' block (legacy substring kept, explicit-ops second message)
- [x] 7. Instructions surface — evidence: commit c01c7809 + 9035ae14; WikiMemory-level `getInstructions` tests: over-cap emits `guidance_too_long` with `operation: 'read'` and detail `{guidanceLength: 2001, guidanceSource: 'default'}`, templates drop section + rule sentence; within-cap emits nothing and carries the section on ingest/librarian only; templates-carried assertion covered by buildInstructionTemplates test
- [x] 8. Rule 5 falsifiable test — evidence: commits c01c7809 + 9035ae14; ops UPDATE + SUPERSEDE targeting the document fire `contradicts_document` with the row byte-unchanged; heal (document genuinely offered as anchor, asserted via prompt) drops the ids, row byte-unchanged (refuses silently — no diagnostic exists on that path, see discrepancies); legacy same-title writes a separate fact, document row byte-unchanged. Falsifiability proof: guard disabled at apply.ts:151 made the ops tests fail RED, then reverted
- [ ] 9. Docs update — evidence: pending
- [ ] 10. Cleanup commit (Status → Implemented, delete plan/LEDGER, ready) — evidence: pending

## Discrepancies

- 2026-11-13 — ledger created at spec-gate close; no prior claims to
  reconcile against disk.
- 2026-11-13 — spec test item 8 predicted a `fact_deduplicated` refusal
  diagnostic on the legacy path; legacy fuzzy-dedupes only against
  `librarian_inferred` rows, so a same-title document fact is NOT
  deduplicated and no diagnostic fires (a separate fact is written). Rule
  5 holds (document row byte-unchanged, asserted). Spec-text erratum;
  note rides the cleanup commit.
- 2026-11-13 — spec item 8's "refusal diagnostics fire" is only
  partially satisfiable: heal refuses silently (mutableIds guard, no
  diagnostic exists on that path). Test asserts the byte-unchanged rows
  plus proof the document was genuinely offered to the model.
