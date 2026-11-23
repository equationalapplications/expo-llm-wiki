# Partial index on `entries(entity_id, deleted_at)` — ledger

In flight: nothing; implementation complete, awaiting review loops.

- [x] 1. v18 migration and helper (1d3c95f4; `vitest run __tests__/migration18.test.ts`, 7 passed)
- [x] 2. migration18 test (1d3c95f4; same command)
- [x] 3. hard-coded 17 updates (1d3c95f4 + fts5RenameRetire follow-up; full core suite 259 files, 3102 tests all passed, `pnpm --filter @equationalapplications/core-llm-wiki test`)
- [x] 4. Rust REQUIRED_SCHEMA_VERSION (crate schema fixtures 17 to 18 in engine/walk/lifecycle tests, bench-traversal, proof example; main passes engine_tests, branch failed until the fixtures moved; then `cargo test --manifest-path crates/graphrag-core/Cargo.toml` all ok)
- [x] 5. plan-switch re-verification recorded in spec (scratch timing; no hint needed)
- [x] 6. full suite and core typecheck (`pnpm --filter ... typecheck` clean; `pnpm -r typecheck` not green: schema-org fails for missing core dist build; open)
- Open: none else; build timing (27 ms) recorded in spec.
