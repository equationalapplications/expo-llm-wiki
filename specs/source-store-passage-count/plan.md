# Plan — source store passage count index fix (spec: source-store-passage-count)

Branch: `fix/source-store-passage-count` · PR: #490 (draft) · Issue: #489

All steps run in `packages/core` unless stated. Test commands run from the
repo root with `pnpm --filter @equationalapplications/core-llm-wiki ...`
or `cd packages/core && pnpm vitest run <file>`. Keep every task TDD:
write or change the test first, see it fail for the right reason, then fix.

## Task 1 — hoist the builder, pin the plan (RED first)

1. In `packages/core/src/services/SourceStoreService.ts`, add an exported
   function `listStoredSourcesSql(prefix: string): string` that returns the
   current listing SQL with `${prefix}` interpolated once.
2. Change `listStoredSources` to call the builder. No SQL text changes in
   this task.
3. Add a test in `packages/core/__tests__/sourceStoreRead.test.ts`:
   open the test database, run `EXPLAIN QUERY PLAN` over
   `listStoredSourcesSql(PREFIX)` through `db.getAllAsync`, and assert:
   - the plan names `idx_source_passages_doc`;
   - the plan does not name `idx_source_passages_entity`.
   Assert on the index-name substring of the `detail` column, never on the
   full plan text.
4. Run the new test. It MUST fail (RED) — the shipped SQL plans on the
   entity index. Record the failure text in LEDGER.md as the RED evidence.

## Task 2 — correlate on document_id (GREEN)

1. Change the builder's inner subquery to
   `WHERE p.document_id = d.id`. Delete the `p.entity_id = d.entity_id`
   predicate.
2. Run the Task 1 test. It MUST pass (GREEN).
3. Run the whole `sourceStoreRead.test.ts` suite unchanged (entity
   isolation, `passageCount` accuracy, `passageCount 0`). It MUST pass
   with zero edits to existing assertions.
4. Commit: `fix(source-store): probe the passage count on the document
   index` (this commit name goes in the ledger evidence).

## Task 3 — performance guard test

1. Add a test that opens `openTestDatabase(<tmp file path>)` (file-backed,
   per the issue's measurement method), seeds one entity with 2,000
   documents and 3 passages per document through raw SQL inserts inside
   one transaction, then calls `listStoredSources` once.
2. Assert 2,000 rows return and the call takes under 500 ms. Clean up the
   temp file in an `afterAll`.
3. Run it. Record the measured time in LEDGER.md. The bound must stay
   generous; if a CI run flirts with it, raise the bound and note the
   measured head-of-ship numbers in the spec Errata instead of tuning the
   test loop.

## Task 4 — full gates

1. `pnpm build` — must pass.
2. `pnpm exec tsc --noEmit` — must pass with zero errors.
3. Root `pnpm test` (all packages except integration, then integration
   without the embedding-model suites) — must pass.
4. Record each gate's tail output in LEDGER.md.

## Task 5 — probe numbers and cleanup commit (after review convergence)

1. Re-run the Task 3 scale probe (5,000 docs × 3 passages, in-memory and
   file-backed) and write the final numbers into the spec Errata,
   replacing the scratch-reproduction note.
2. After the tiered review loops converge: one cleanup commit flips the
   spec Status to `Implemented` and deletes `plan.md` and `LEDGER.md`.
   Push it before `gh pr ready`.

## Risks and pins

- **EQP wording drifts across SQLite versions.** The test asserts the
  index-name substring only. If a future SQLite renames the index, the
  test fails loudly — that is the desired pin.
- **Perf bound flakiness on CI runners.** 500 ms is 60× the measured
  fixed-path time. Do not assert a lower bound or ratio; assert only the
  ceiling and the row count.
- **`EXPLAIN QUERY PLAN` through the adapter.** The test helper
  (`openTestDatabase`) passes any statement to better-sqlite3's
  `prepare().all()`; EQP returns rows, so `getAllAsync` works. Verified
  2026-11-28 in the scratch probe.
- **No public surface changes.** The builder is exported from the service
  module only, never from `src/index.ts`; `pnpm build` d.ts checks must
  show no new public symbols (Task 4 gate covers this).
