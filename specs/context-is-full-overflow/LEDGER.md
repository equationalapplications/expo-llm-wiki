# Recognize llama.rn "Context is full" as context overflow — ledger

In flight: nothing (implementation done; review loops next)

- [x] 1. Tests first — evidence: failed before fix (1 failed test in each of the two files), then 24 passed with it; `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/services/context-overflow.test.ts`; 4949e854
- [x] 2. Add pattern — evidence: 4949e854, same command, 24 passed
- [x] 3. runBatched split test — evidence: 4949e854, __tests__/services/BoundedLlmCall.overflow-runbatched.test.ts passes
- [x] 4. Docs grep, full suite, typecheck — evidence: no apps/docs page lists recognized messages; core suite 258 files / 3096 tests passed; `flock ... pnpm -r typecheck` clean after building workspace packages

## Discrepancies

- 2026-11-23 — spec has no "Open questions" section, so no defaults were recorded; status flipped only.
