# Import diagnostics after commit — plan

Spec: `specs/import-diagnostics-after-commit/spec.md`

1. Re-run the audit on current main (PR #469 landed); amend the spec if it changed — `ImportExportService.ts`, `spec.md`.
2. Write `packages/core/__tests__/importDiagnosticsAfterCommit.test.ts` (5 cases); watch the rollback cases fail on main — `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/importDiagnosticsAfterCommit.test.ts`.
3. Spec §Proposed change 1: replace the inline emit with `refusalDiagnostics.push` plus comment; the new test passes.
4. Full core suite and `pnpm -r typecheck` through the shared flock; update the PR body.
