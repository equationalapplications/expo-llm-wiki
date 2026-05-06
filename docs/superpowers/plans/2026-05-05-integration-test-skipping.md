# Handoff: Integration Test Skipping Issue

**Date:** 2026-05-05  
**Status:** In Progress  
**Related PR:** feat/retrieval-tuning

## Problem

During `pnpm run integration-test`, the SciFact BEIR benchmark test appears skipped (`↓ __tests__/scifact.test.ts (1 test | 1 skipped)`), but the same test runs successfully when invoked directly via `pnpm run benchmark`. The test has no `.skip` annotation.

## Root Cause (Hypothesis)

The `recall.test.ts` and `scifact.test.ts` files both attempt to load large fastembed ONNX models concurrently during `beforeAll`. This likely causes:
- ONNX runtime resource exhaustion (memory, thread pool)
- One or both test suites timing out or hanging
- Vitest marking tests as "skipped" instead of failed

When `scifact.test.ts` runs alone via `pnpm run benchmark`, there's no resource contention and it completes successfully (~2 min for 300 queries).

## Context

- `packages/integration/__tests__/scifact.test.ts`: loads `BGESmallENV15` model, runs 300 queries, measures NDCG@10
- `packages/integration/__tests__/recall.test.ts`: also loads `BGESmallENV15` model, runs smaller recall scenarios
- Both use `beforeAll` with 300s timeout; scifact uses an additional 300s test timeout
- `packages/integration/vitest.config.ts` has a 300s `hookTimeout`

## Next Steps

1. **Isolate the issue**: Run `pnpm run integration-test` with verbose output and capture timing/error logs
2. **Measure concurrency impact**: 
   - Try running just `recall.test.ts` alone
   - Try running just `scifact.test.ts` alone
   - Run both together and measure completion time vs sequential
3. **Options to resolve**:
   - **A)** Increase Vitest hook/test timeout further (may mask issue)
   - **B)** Load fastembed model once globally in a setup file, share across tests
   - **C)** Run scifact/recall tests serially (not in parallel) during `integration-test`
   - **D)** Mock fastembed in recall tests, leave scifact as the only real embedding test
   - **E)** Reduce model size or use a lighter model for recall tests

## Files to Check

- `packages/integration/vitest.config.ts` — hook/test timeouts, parallelization settings
- `packages/integration/__tests__/recall.test.ts` — embedding setup
- `packages/integration/__tests__/scifact.test.ts` — embedding setup
- `packages/integration/helpers/llm.ts` — shared embedding utilities

## Acceptance Criteria

- `pnpm run integration-test` consistently shows all tests running (no `↓ skipped`)
- All 36+ tests pass (or fail for real reasons, not timeouts)
- `pnpm run benchmark` (scifact alone) continues to work
- Total integration-test runtime remains < 2 min (currently ~2.5 min)
