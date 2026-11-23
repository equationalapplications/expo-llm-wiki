# Partial index on `entries(entity_id, deleted_at)` — ledger

In flight: nothing; implementation complete, awaiting review loops.

- [x] 1. v18 migration and helper (1d3c95f4; `vitest run __tests__/migration18.test.ts`, 7 passed)
- [x] 2. migration18 test (1d3c95f4; same command)
- [x] 3. hard-coded 17 updates (1d3c95f4 + fts5RenameRetire follow-up; full core suite 3102 tests, `pnpm --filter @equationalapplications/core-llm-wiki test`)
- [x] 4. Rust REQUIRED_SCHEMA_VERSION (`cargo test --test schema_parity`: 1 passed; full crate run shows 3 engine_tests connection_path failures, see PR)
- [x] 5. plan-switch re-verification recorded in spec (scratch timing; no hint needed)
- [x] 6. full suite and core typecheck (`pnpm --filter ... typecheck` clean; `pnpm -r typecheck` fails only in schema-org for missing core dist build)
