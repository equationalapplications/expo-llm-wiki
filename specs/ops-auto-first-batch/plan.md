# ops + auto first batch — plan

Spec: `specs/ops-auto-first-batch/spec.md`

1. Failing tests, in `packages/core/__tests__/opsAutoFirstBatch.test.ts`. Each test maps to spec test-plan item 1–5:
   - count trigger;
   - token trigger;
   - legacy history preserved;
   - a failed first pass leaves the log re-readable;
   - start-of-log marker semantics.

   Verify: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/opsAutoFirstBatch.test.ts`. The fix-dependent tests must fail.
2. Implement spec §1.
   - Add `MaintenanceService.anchorWatermarkBeforeTrigger(entityId, preCheckpoint, tx)`. It is package-internal and does all reads and writes on `tx`. Export `START_OF_LOG_WATERMARK = { at: 0, id: '' }` from `MetadataRepository.ts`.
   - Call the helper from both `WriteService.write` trigger paths before `updateCheckpoint(memory: count)`, only when `resolveLibrarianStrategy(config) === 'ops'`.

   Verify: the new tests pass, plus the full core suite.
3. Add the docs note from spec §3 to `apps/docs/src/content/docs/guides/maintenance.md`. Verify: the docs build still passes.
4. Verify: root `pnpm test` and `pnpm -r typecheck` pass. The benchmarks baseline (spec test-plan item 6) waits for #357 to merge.
