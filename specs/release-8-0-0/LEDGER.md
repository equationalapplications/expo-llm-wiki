# Ledger: release 8.0.0

**In flight:** implementation done on `feat/8.0.0`; draft PR waits on the spec's merge blockers.

- [x] 1. Remove `wiki_*` tool names. Evidence: `core-llm-tools` 55/55 tests.
- [x] 2. Central defaults and flip. Evidence: `engineDefaults.test.ts`, core suite green.
- [x] 3. Construction warnings and strategy-aware `getInstructions()`. Evidence: `engineDefaults.test.ts`.
- [x] 4. Explicit config in tests, apps and benchmark baselines. Evidence: `pnpm test` green.
- [x] 5. Migration guide, docs, `INTENT.md`, `AGENTS.md`. Evidence: `apps/docs` build complete.
- [x] 6. Verification. Evidence: build, `pnpm -r --if-present lint`, typecheck, `pnpm test`; counts in the PR body.
- [ ] 7. Merge blockers cleared, Status flipped to Implemented, plan and ledger deleted, PR marked ready.
