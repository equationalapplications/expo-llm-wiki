# Librarian guidance and the general leave-out rule — plan

Spec: `specs/librarian-guidance/spec.md`

1. **Golden strings.** Capture the built prompts from the *unmodified*
   builders into a committed fixture
   (`packages/core/__tests__/__fixtures__/guidance-golden.json`): ingest
   (default / configured override / per-call override), legacy librarian
   (no-placeholder + placeholder templates), ops extract,
   `buildInstructionTemplates` both strategies, each with and without
   ontology and grounding. Generator script committed beside it.
   Verification: generator re-run on clean tree diffs empty.
2. **Config types.** `packages/core/src/types.ts`: `prompts.guidance`,
   `librarian.guidanceForEntity`, `@deprecated` on
   `prompts.librarianSystemPrompt`, `WikiDiagnosticCode` +=
   `guidance_too_long`/`guidance_resolver_failed`, `WikiDiagnosticDetail`
   += `guidanceLength`/`guidanceSource`. Verification: `pnpm -r typecheck`
   (or repo equivalent) green.
3. **Constants.** `packages/core/src/prompts.ts`:
   `GUIDANCE_MAX_CHARS = 2000`, exported leave-out rule sentence
   constant (exact ruled text). Verification: import compiles; unit
   test asserts the sentence text.
4. **PromptService.** Resolution helper (default → per-entity, trim
   emptiness, UTF-16 cap, marked section, rule sentence, hydration-safe
   append) + `guidance?: string` parameter on `buildIngestPrompt`,
   `buildLibrarianPrompt`, `buildOpsExtractPrompt`; third parameter on
   `buildInstructionTemplates`. Verification: test plan items 1–3 pass
   against the golden fixture.
5. **Resolution seams.** `MaintenanceService.runLibrarianPass` resolves
   per entity (ignores caller-supplied `guidance`);
   `IngestionService` resolves next to the ontology-context hoist;
   diagnostics emitted immediately at resolution. Verification: test
   plan items 4–6 pass, including the scheduler-path test.
6. **Warning messages.** `engineDefaults.ts`: updated ops message
   (points at `prompts.guidance`, keeps the `strategy: 'legacy'`
   substring assertion) + second message for explicit
   `librarian.strategy: 'ops'`. Verification: test plan item 8 passes.
7. **Instructions surface.** `WikiMemory.getInstructions` passes
   resolved guidance; `guidance_too_long` with `operation: 'read'` when
   over cap. Verification: test plan item 7 passes.
8. **Rule 5 falsifiable test.** Ingest a document, drive both
   strategies + heal with stub responses that attempt rewrites of an
   `immutable_document` fact; assert rows byte-unchanged and refusal
   diagnostics fire. Verification: test passes; mutation of the guard
   makes it fail.
9. **Docs.** README config section + prompts docs: guidance setting,
   cap, `{{…}}` constraint, no-secrets warning, deprecation notice.
   Verification: docs updated in same PR, latest version only.
10. **Cleanup commit.** Flip spec Status → Implemented, delete
    `plan.md` and `LEDGER.md`, `gh pr ready`. Verification: PR ready;
    CI green.
