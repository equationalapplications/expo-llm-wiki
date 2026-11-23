# Meter reservation — plan

Spec: `specs/meter-reservation/spec.md`

1. Failing concurrency test (spec Test plan 3) and default-path pin (Test plan 4) — `packages/core/src/__tests__/services/meter-reservation.test.ts`; `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run src/__tests__/services/meter-reservation.test.ts` (concurrency case fails, pin passes).
2. Meter reservation API (§1, §2) — `utils/usage.ts`; unit tests in `__tests__/usage.test.ts` (Test plan 1, 8).
3. Wrappers reserve/settle/release (§3) — `utils/llmCall.ts`; tests in `llmCall.test.ts`, `utils/callClassify.test.ts` (Test plan 2, 5, 7).
4. Docs and code comments (§8, §9) — guide, type-on-write spec §3, 2026-07-13 backfill spec pointer, `types.ts` tokenBudget doc.
5. Verification — existing suites unmodified, full core suite, `pnpm -r typecheck`, `.d.ts` pack-diff (Test plan 6).
