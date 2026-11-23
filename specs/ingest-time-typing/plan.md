# Ingest-time typing — plan

Spec: `specs/ingest-time-typing/spec.md`

1. Pin default-host behavior on unmodified code (Test plan 1b, 1c): end-to-end prompt byte identity and receipt sequences — `packages/core/__tests__/ingestTypingCompat.test.ts`.
2. Pin `ingest_zero_facts` under engagement (red) and fix the gate to the mode (§4), Test plan 10.
3. Config key, resolver, export (§1; Test plan 2).
4. Shared `typingEngages` + `canEngageIngestTyping`; `classifyFactsForWrite` `opts.concurrency`; `TypingCounters` to `types.ts` (§2, §3, §9; Test plan 3).
5. Refactor both write paths onto `normalizeForWrite` with canonical slug to `upsertGraphCore` (§4); step 1 pins stay green, plus the one `writer: 'llm'` delta.
6. Engagement hoist, `engaged` prompt, `getInstructions().ingest` (§5; Test plan 4).
7. Pre-transaction typing stage, receipts, counters, result `typing` (§3, §8, §9; Test plans 5-9, 11-13).
8. Docs and docs pin (Test plan 15).
9. Full suite, typecheck (Test plan 14, 16).
