# Recognize llama.rn "Context is full" as context overflow — plan

Spec: `specs/context-is-full-overflow/spec.md`

1. Tests first (spec s5): add `Context is full`, case/prefix variants to `OVERFLOW_MESSAGES`; `Disk is full` and `Request queue is full, retry later` to `NOT_OVERFLOW` in `packages/core/__tests__/services/context-overflow.test.ts`. Verify fail: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/services/context-overflow.test.ts`
2. Add `/context is full/i` with provider comment to `CONTEXT_OVERFLOW_PATTERNS` in `packages/core/src/services/BoundedLlmCall.ts` (spec s3). Same command passes.
3. Optional runBatched split test in `packages/core/__tests__/services/BoundedLlmCall.overflow-runbatched.test.ts` (spec s5).
4. Check `apps/docs` for a page listing recognized messages (spec s4); full suite and typecheck under the flock.
