# Plan: `auth --email` remedy-poll noise (#326)

Spec: `spec.md` (this folder). Status stays Draft until Kurt approves; the build does not wait (spec §10).

1. **T1 - tests first (spec §8).** Add tests 1-9 to `packages/mcp-server/__tests__/authmd.test.ts` and the `waits` assertion to the existing remedy test (test 10). Verify that tests 1-7 and 9 fail on the unchanged `authmd.ts`, that test 8 fails only on its line count, and that every existing test still passes. Fix the stale comment at L122-123 in passing (spec §9).
2. **T2 - implementation (spec §3.1, §3.2).** In `registerByEmail`, add `lastRemedy` and `remedyBackoffSeconds`, change the remedy arm and the sleep expression, and reset both variables on `authorization_pending` and `slow_down`. Verify: `pnpm --filter @equationalapplications/mcp-server test typecheck build` is green and every §8 test passes.
3. **T3 - spec amendments (spec §6).** Append the dated notes to `specs/mcp-server/spec.md` §7 step 3 and §12.1. Verify the text against §6.
4. **Cleanup (after review converges).** Flip Status to Implemented, delete `plan.md` and `LEDGER.md`, run root `pnpm test`, then mark the PR ready.
