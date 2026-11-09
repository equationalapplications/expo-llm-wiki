# Plan: 8.0.0 upgrade warning

1. Write `packages/core/__tests__/upgradeNotice.test.ts` and confirm it fails (spec §4).
2. Add `packages/core/src/utils/upgradeNotice.ts` and the `WikiMemory` constructor call (spec §2, §3).
3. Add the docs note under Maintenance in `reference/configuration.md` (spec §3).
4. Run build, typecheck and `pnpm test`.
5. Cleanup commit: flip the spec to Implemented and delete `plan.md` and `LEDGER.md`; `gh pr ready`.
