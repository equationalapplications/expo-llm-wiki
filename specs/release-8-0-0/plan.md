# Plan: release 8.0.0

Implements `specs/release-8-0-0/spec.md`.

1. Remove the `wiki_*` tool names and helpers from `core-llm-tools`, retarget schema tests, and update its docs (spec change 1).
2. Add `utils/engineDefaults.ts`, resolve every read site through it, and flip both defaults (change 2).
3. Add the construction warnings and make `getInstructions()` follow the strategy (changes 3 and 4).
4. Set explicit configuration in tests, apps and benchmark baselines that depend on 7.x behavior (changes 5 and 6).
5. Write the migration guide, update docs, and amend `INTENT.md` and `AGENTS.md` (change 7).
6. Verify with build, lint, typecheck and `pnpm test`.
7. After the spec's merge blockers clear: flip Status to Implemented, delete this file and `LEDGER.md`, `gh pr ready`.
