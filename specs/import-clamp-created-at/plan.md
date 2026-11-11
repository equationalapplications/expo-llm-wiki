# Plan: import-clamp-created-at

Spec: `spec.md` (this folder). One branch, one PR (#362).

1. **Tests first (red).** `packages/core/__tests__/importClampCreatedAt.test.ts`
   covering test plan items 1–5. Verify: the new tests fail on main.
2. **Diagnostic code (§2).** Add `event_created_at_clamped` to
   `WikiDiagnosticCode`, `SEVERITY` (`warn`) and `MESSAGE`. Verify: typecheck.
3. **`addIgnoreDuplicate` returns boolean (§2).** `changes > 0`. Verify:
   typecheck; existing callers unaffected.
4. **Clamp + emit (§1, §2)** in `ImportExportService.doImportEntity`.
   Verify: the new tests pass; the full core suite passes.
5. **Docs.** One row in `apps/docs/src/content/docs/guides/diagnostics.md`.
6. **Review.** Run a code review, address findings.
7. **Cleanup** (after review loops converge): Status → Implemented, delete
   `plan.md` and `LEDGER.md`, `gh pr ready`.
