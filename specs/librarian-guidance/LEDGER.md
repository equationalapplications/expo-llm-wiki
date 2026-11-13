# Librarian guidance and the general leave-out rule — ledger

In flight: 5 (test half) — scheduler-path, rule-5 falsifiable and grounding-corpus tests need the WikiMemory harness

- [x] 1. Golden strings fixture + generator — evidence: commit after this one; generator re-run diffs empty (verified in-session)
- [x] 2. Config types (guidance, guidanceForEntity, deprecation, diagnostic codes + detail fields) — evidence: commit 8eed8f93; `pnpm typecheck` green (only pre-existing parseOkfBundle/core-okf error)
- [x] 3. Constants (GUIDANCE_MAX_CHARS, rule sentence) — evidence: commit 8eed8f93; librarianGuidance.test.ts asserts the ruled sentence text and cap boundary behavior
- [x] 4. PromptService threading + marked section + rule sentence — evidence: commit 8eed8f93; golden fixture re-captured post-change diffs EMPTY (no-guidance byte parity); 18 placement/resolution tests pass
- [~] 5. Resolution seams — CODE complete (runLibrarianPass resolves for every caller incl. MaintenanceScheduler drain; IngestionService hoists past early returns; getInstructions emits 'read' diagnostic; immediate emission) — but the scheduler-path / rule-5 stub-rewrite / corpus tests still need the WikiMemory harness (spec test items 4, 6, and the corpus half of 3). Do not tick until those exist.
- [x] 6. Warning messages (updated + explicit-ops) — evidence: commit 8eed8f93; librarianGuidance.test.ts 'upgrade warnings' block (legacy substring kept, explicit-ops second message)
- [~] 7. Instructions surface — CODE complete (getInstructions threads guidance; 'read' diagnostic on over-cap); templates-carried assertion covered by buildInstructionTemplates test; WikiMemory-level diagnostic emission test pending with harness
- [ ] 8. Rule 5 falsifiable test — evidence: pending
- [ ] 9. Docs update — evidence: pending
- [ ] 10. Cleanup commit (Status → Implemented, delete plan/LEDGER, ready) — evidence: pending

## Discrepancies

- 2026-11-13 — ledger created at spec-gate close; no prior claims to
  reconcile against disk.
