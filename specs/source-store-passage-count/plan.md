# Plan — source store passage count index fix (spec: source-store-passage-count)

Branch: `fix/source-store-passage-count` · PR: #490 (draft) · Issue: #489

All steps run in `packages/core` unless stated. Keep every guard TDD: write
or change the test first, see it fail for the right reason, then fix. The
EQP pin is the primary regression guard for the predicate change; the timer
is a secondary guard against gross slowdowns.

## Task 1 — hoist the builder, pin the plan, measure the shipped path

1. In `packages/core/src/services/SourceStoreService.ts`, add an exported
   function `listStoredSourcesSql(prefix: string): string` that returns the
   current listing SQL with `${prefix}` interpolated once.
2. Change `listStoredSources` to call the builder. No SQL text changes in
   this task.
3. Add the EQP pin test in
   `packages/core/__tests__/sourceStoreRead.test.ts`:
   - build the store through the file's `setup()` helper — a bare
     `openTestDatabase()` has no tables or indexes until `wiki.setup()`
     runs;
   - seed one entity with at least one document and passage via
     `storeSource`;
   - run `EXPLAIN QUERY PLAN` over `listStoredSourcesSql(PREFIX)` through
     `db.getAllAsync(sql, [E])` — the SQL carries a `?` for `entity_id`,
     so the parameter array is mandatory;
   - assert the plan's `detail` rows contain the substring
     `idx_source_passages_doc`, and no row contains
     `idx_source_passages_entity`. Assert on index-name substrings, never
     on the full plan text.
4. Run the EQP test. It MUST fail (RED) with the failed
   `toContain('idx_source_passages_doc')` assertion — a thrown error
   (missing table, unbound parameter) is NOT valid RED evidence.
5. Add a second, temporary measurement (not a committed test): run
   `listStoredSources` once against the shipped SQL at the 5,000-document
   × 3-passage scale of the spec's Evidence table. Record the shipped time
   in LEDGER.md — the Errata needs this number and it cannot be measured
   after Task 4 lands. (File-backed or in-memory both fine; state which.)

## Task 2 — counting regression tests (guard the predicate change)

1. Add a test, written before the fix, that inserts two documents through
   raw SQL — one with 0 passage rows, one with 3 — filling every NOT NULL
   column (`entity_id`, `source_ref`, `source_hash`, `text`, `text_hash`,
   `char_count`, `created_at` on documents; `entity_id`, `document_id`,
   `seq`, `start_offset`, `end_offset` on passages), then asserts
   `listStoredSources` returns passage counts `[0, 3]`.
2. These tests pass against the shipped SQL too — the shipped query is
   slow, not wrong. Their job is to fail a WRONG fix (for example,
   counting every passage of the entity), which the existing suite cannot
   catch: its fixtures each hold exactly one passage per document, and the
   test titled "passageCount 0" actually asserts `passageCount: 1`
   (`sourceStoreRead.test.ts:57-70`). Do not edit that existing test.

## Task 3 — performance guard test (RED at the measured scale)

1. Add a file-backed guard test at the 5,000-document × 3-passage scale —
   the scale the spec's Evidence table measured, not an extrapolated one:
   - open `new WikiMemory(openTestDatabase(<tmp path>), options)` and run
     `setup()` on that handle (the file's shared `setup()` hard-codes the
     in-memory database);
   - seed through raw SQL inserts inside one transaction, every NOT NULL
     column filled;
   - call `listStoredSources` once; assert 5,000 rows return and the call
     takes under 500 ms;
   - in an `afterAll`: `closeAsync()` first, then delete the temp file and
     any `-wal` / `-journal` sidecars.
2. Run it against the shipped SQL. It MUST fail with a measured time in
   the seconds (RED evidence in LEDGER.md; expected ~10 s per the probe).

## Task 4 — correlate on document_id (GREEN)

1. Change the builder's inner subquery to
   `WHERE p.document_id = d.id`. Delete the `p.entity_id = d.entity_id`
   predicate.
2. The Task 1 EQP pin, Task 2 counting tests, and Task 3 guard MUST all
   pass. The whole `sourceStoreRead.test.ts` suite MUST pass with zero
   edits to existing assertions.
3. In the same commit, amend the spec as the behavior change requires:
   land the shipped-path number from Task 1 step 5 in the Errata alongside
   the fixed-path re-measurement.
4. Commit: `fix(source-store): probe the passage count on the document
   index`.

## Task 5 — full gates

1. `pnpm build` — must pass.
2. `pnpm exec tsc --noEmit` — must pass with zero errors.
3. Public-surface check: `grep listStoredSourcesSql packages/core/dist/index.d.ts`
   must find nothing (the builder stays module-internal; `src/index.ts`
   has no `export *` from services).
4. Root `pnpm test` (all packages except integration, then integration
   without the embedding-model suites) — must pass.
5. Record each gate's tail output in LEDGER.md.

## Task 6 — final numbers and cleanup commit (after review convergence)

1. Re-run the scratch probe at the 5,000 × 3 scale on the fixed SQL
   (in-memory and file-backed). Write both fixed-path numbers plus the
   Task 1 shipped-path number into the spec Errata, replacing the
   scratch-reproduction note; state the measurement conditions of each.
2. After the tiered review loops converge: one cleanup commit flips the
   spec Status to `Implemented` and deletes `plan.md` and `LEDGER.md`.
   Push it before `gh pr ready`.

## Risks and pins

- **EQP text drifts across SQLite versions.** The test asserts
  index-name substrings only. Real drift risks are the planner choosing a
  different index (the pin fires) or EQP wording changing around the
  names (`USING COVERING INDEX` still matches the substring). SQLite does
  not rename user indexes.
- **Perf bound flakiness on CI runners.** 500 ms at the 5,000 × 3 scale
  sits far below the measured shipped-path time (~10 s) and far above the
  measured fixed-path time (7.8 ms in-memory). Do not assert a lower
  bound or a ratio; assert only the ceiling and the row count. If the EQP
  pin ever fails, trust it over the timer — the timer guards gross
  slowdowns only.
- **`EXPLAIN QUERY PLAN` through the adapter.** `openTestDatabase` passes
  any statement to better-sqlite3's `prepare().all()`; EQP returns rows,
  so `getAllAsync` works. The statement carries one `?` that must be
  bound. Verified 2026-11-28 in the scratch probe (which bound its
  parameter).
- **Entity-pair invariant.** `source_passages` carries no foreign key
  tying its `entity_id` to the document's `entity_id`; correctness of the
  one-predicate correlation rests on every writer (`sourceStoreUpsert`,
  the import path) stamping matching entity ids. The spec states this
  invariant (see its Proposed change section).
- **No public surface changes.** The builder is exported from the service
  module only, never from `src/index.ts`; Task 5 step 3 asserts this on
  the built `d.ts`.
