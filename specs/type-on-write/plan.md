# Type on write — plan

Spec: `specs/type-on-write/spec.md`

1. Byte-identity fixtures (Test plan 1) — record on UNMODIFIED code: every write prompt (`buildLibrarianPrompt`, `buildOpsExtractPrompt`, `buildIngestPrompt`) and backfill prompt (`buildOntologyBackfillPrompt`, `buildInstructionTemplates`) across modes off/strict/emergent x guidance x grounding x override. Test: `packages/core/tests/promptByteIdentity.test.ts` (path adjusted to repo layout). Verify: vitest on that file passes before any PromptService change.
2. Opt-in key and resolver (§1, Test 3) — `systemOne.ts`, `engineDefaults.ts`, `index.ts` export.
3. Rule-12 receipts (§9, Tests 11, 12) — new codes, `SEVERITY`/`MESSAGE`, `replacementId`, `apply.ts` emits, `LibrarianResult` id lists.
4. Template split (§5, Tests 1, 2, 5) — `WriteOntologyPromptContext`, `buildWriteOntologyAppendix`, `OntologyService.buildWritePromptContext`, PromptService split, call sites (extract.ts reserve estimate and extractOnce share one context). Fixtures from task 1 stay green.
5. Shared typing module (§2, §3, §8, §13; Tests 4, 7) — `services/typing/typeOnWrite.ts`; backfill imports predicate and question.
6. Legacy integration (§3, §4, §8; Tests 6-10).
7. Ops integration (§3, §4, §8; Tests 6-10).
8. Counters, scheduler, `getInstructions` (§5, §8; Tests 5, 13, 14).
9. Docs and INTENT rule 12 (§9, Files touched; Test 16).
10. Full verification: core suite, `pnpm -r typecheck`, PR body.
