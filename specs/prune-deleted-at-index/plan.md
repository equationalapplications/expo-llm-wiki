# Partial index on `entries(entity_id, deleted_at)` — plan

Spec: `specs/prune-deleted-at-index/spec.md`

1. Migration v18 and `createEntriesDeletedIndex` helper; fresh-store call in `WikiMemory.setup()`. Files: `packages/core/src/db/migrations.ts`, `packages/core/src/WikiMemory.ts`. Verify: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/migration18.test.ts`.
2. New `migration18.test.ts` (registered/stamped, upgrade, gate, per-query plans, export/import round trip), written first. Same command.
3. Update hard-coded 17 in `sourceRefNormalize.test.ts` and `setupBudget.test.ts`; re-read `fts5RenameRetire.test.ts:133`. Verify: run those files.
4. Rust `REQUIRED_SCHEMA_VERSION` 17 to 18. Verify: `flock /tmp/claude-1000/expo-llm-wiki-fullsuite.lock cargo test --manifest-path crates/graphrag-core/Cargo.toml`.
5. Re-verify the hard-delete plan switch and record it in the spec; record the shared-v18 ruling.
6. Full core suite and `pnpm -r typecheck` through the lock.
