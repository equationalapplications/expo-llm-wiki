# Durable Vector Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every committed fact delete is recorded in SQLite and delivered to the host's `onEmbeddingPersisted({ vector: null })` hook until it succeeds once. Retries, restarts and crashes don't lose it, and one failing id never blocks the others.

**Architecture:** Two SQLite triggers on `entries` fill a `vector_removals` ledger. One `VectorRemovalService.drain()` delivers the ledger: it applies the hook gate, keyset paging, a per-id in-flight map and backoff. `forget`, `runPrune`, heal, ingest, import, `syncSearchIndex`, `setup()` and `runPendingMaintenance` call that drain instead of their own post-commit loops.

**Tech Stack:** TypeScript, SQLite via `SQLiteAdapter` (better-sqlite3 in tests), vitest, pnpm.

**Spec:** `specs/durable-vector-removal/spec.md` (revision 2). Read it first. Section numbers below (§) refer to it.

## Global Constraints

- pnpm only; never `npm install`. No new dependency.
- Never edit `CHANGELOG.md` or any `"version"` field. Commits are `feat(core):` / `fix(core):` / `docs:` / `test(core):`. No `BREAKING CHANGE` footer, and no body line starts with that phrase.
- Every SQL statement uses the configured table prefix (`${this.prefix}` / `${p}`). Never hard-code `llm_wiki_`.
- No `schema_version` bump, and no migration (§5.1).
- Diagnostics are content-free: ids, counts and timestamps only.
- Core tests need built deps. If imports fail, run `pnpm run build` at the repo root. Run one file with `cd packages/core && pnpm exec vitest run __tests__/<file>`.
- Each task ends with `cd packages/core && pnpm exec tsc --noEmit -p .` clean and its test files green.

## Review Focus

1. **Host-held transaction on the shared connection.** A background drain must never call the hook for rows the host hasn't committed (spec test 24, Task 2).
2. **A hookless second process on the same file.** It must leave every obligation in place (test 13; Tasks 2 and 4).
3. **Prefix other than `llm_wiki_`.** Triggers and the ledger must work under a custom `tablePrefix`. Task 1 adds `vectorRemoval schema works under a custom prefix`.
4. **Very large wipes.** `clearAll` on many facts must enqueue in one statement, and the forget drain must touch only that call's ids (tests 16 and 19; Tasks 1 and 3).
5. **The old stop-at-first behavior in existing tests.** Tests asserting it must be updated to the new contract, not deleted (Tasks 3 and 4).

---

### Task 1: Ledger schema, triggers and repository

**Files:**
- Modify: `packages/core/src/db/schema.ts` (append the DDL in `setupDatabase`, after `entries` exists)
- Create: `packages/core/src/repositories/VectorRemovalRepository.ts`
- Test: `packages/core/__tests__/vectorRemovalLedger.test.ts`

**Interfaces:**
- Produces, as `class VectorRemovalRepository extends BaseRepository` with constructor `(db, prefix)`, like the other repositories:
  - `interface LedgerRow { seq: number; entity_id: string; fact_id: string; attempts: number; last_attempt_at: number | null; fact_state: 'live' | 'deleted' | 'gone' }`
  - `readPage(scope: { entityId?: string; ids?: string[] }, cursor: { maxSeq: number; attempts: number; seq: number }, limit: number, tx: SQLiteAdapter): Promise<LedgerRow[]>`. It returns unconfirmed rows only, with `LEFT JOIN entries` for `fact_state`, ordered by `attempts, seq`.
  - `maxSeq(tx?): Promise<number>`
  - `confirm(seqs: number[], now: number, tx)`
  - `bumpAttempts(seqs: number[], now: number, tx)`
  - `deleteBySeq(seqs: number[], tx)`, used for stale, gone or resurrected rows.
  - `backstopEnqueue(entityId: string, ids: string[], now: number, tx): Promise<number>` runs `INSERT OR IGNORE` for ids with no row. Chunk `ids` at 500 per statement.
  - `deleteForFacts(entityId: string, ids: string[], tx)` removes rows together with a hard delete.
  - `discardPending(entityId?: string, tx?): Promise<number>`
  - `pendingStats(entityId?: string): Promise<{ count: number; oldestEnqueuedAt: number | null; maxAttempts: number }>`
  - `entitiesWithPending(): Promise<string[]>`
  - `statusFor(ids: string[]): Promise<Map<string, 'pending' | 'confirmed'>>`. An id with no row is absent from the map.
- Produces in the schema: the table, index and two triggers exactly as in spec §5.1–§5.2.

- [ ] **Step 1: Write the failing tests** in `vectorRemovalLedger.test.ts`. Use `openTestDatabase()`, `new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } })`, and `await wiki.setup()`.
  - `a soft delete enqueues one row`: insert a live entry, run `UPDATE … SET deleted_at = 1`, and expect one ledger row with `attempts 0` and `confirmed_at NULL`.
  - `resurrection removes the unconfirmed row`: soft-delete, then set `deleted_at = NULL`. Expect 0 rows.
  - `a soft delete and resurrection in one transaction leave no row`.
  - `a re-delete after confirmation re-enqueues with a new seq`: confirm the row, resurrect it, then delete again. Expect `confirmed_at NULL` and a higher `seq`.
  - `a bulk soft delete of 1000 facts enqueues 1000 rows in one statement`: spy on `runAsync` and count calls.
  - `rows are scoped by entity`.
  - `vectorRemoval schema works under a custom prefix`: use `config: { tablePrefix: 'x_' }` and expect the `x_vector_removals` rows to appear.
  - `a fresh setup creates the table, index and both triggers; setup twice is idempotent`: query `sqlite_master`.
  - Repository unit cases:
    - `readPage` order and the `fact_state` values;
    - `backstopEnqueue` skips ids that already have rows;
    - `confirm`, `bumpAttempts` and `deleteBySeq` touch only the given `seq`s.
- [ ] **Step 2:** Run the file. Expect FAIL (no table).
- [ ] **Step 3:** Add the DDL to `setupDatabase`, and implement the repository.
- [ ] **Step 4:** Run the file and the existing schema and migration tests (`__tests__/migration*.test.ts`, `__tests__/fts5*.test.ts`). Expect PASS.
- [ ] **Step 5:** Commit `feat(core): vector_removals ledger filled by triggers on entries (spec durable-vector-removal §5.1-5.2)`.

### Task 2: Drain service and the hook gate

**Files:**
- Create: `packages/core/src/services/VectorRemovalService.ts`
- Modify: `packages/core/src/services/EmbeddingService.ts`. Add `callRemovalHook(entityId, factId, timeoutMs): Promise<void>`: no gate check, a timeout error carrying `HOOK_TIMEOUT_MARKER`, and validation factored out as `validateDeletionTimeout(): number`.
- Modify: `packages/core/src/types.ts`. Add diagnostic codes `external_deletion_pending` and `external_deletion_discarded`, operation `'externalDeletion'`, and detail fields `oldestEnqueuedAt?: number` and `maxAttempts?: number`.
- Test: `packages/core/__tests__/vectorRemovalDrain.test.ts`

**Interfaces:**
- Consumes: `VectorRemovalRepository` (Task 1).
- Produces, as `class VectorRemovalService` with constructor `(db, options: WikiOptions, repo: VectorRemovalRepository, embeddingService: EmbeddingService, metadataRepo: MetadataRepository)`:
  - `type DrainScope = { entityId: string; ids?: string[] } | { all: true }`
  - `interface DrainResult { confirmed: number; pending: number; failedIds: string[]; timedOut: boolean; firstCause?: Error }`. `failedIds` holds at most 100 ids.
  - `drain(scope: DrainScope, opts?: { deadlineMs?: number; backoff?: boolean; trigger?: WikiDiagnosticTrigger }): Promise<DrainResult>`
  - `gate(): 'hook' | 'none' | 'force'`
  - `markExternalIndexInUse(tx): Promise<void>` (meta key `external_index_in_use`)
  - `externalIndexInUse(): Promise<boolean>`
- Behavior is exactly spec §5.3–§5.4:
  - `'none'` leaves the ledger untouched and emits `external_deletion_pending` per entity when rows are pending.
  - `'force'` runs `discardPending`, clears the marker, and emits `external_deletion_discarded`.
  - Pages are read inside `db.withTransactionAsync`. If BEGIN throws, the drain returns early with `pending` set and no calls.
  - Uses the per-id in-flight `Map<string, Promise<void>>`, a keyset snapshot, and the stop conditions: first timeout, 5 consecutive rejections, or the deadline.
  - The per-call timeout is `min(validated timeout, time left)`.
  - Backoff applies only when `opts.backoff === true`.

- [ ] **Step 1: Write the failing tests** (spec tests 3, 13 drain part, 14 drain part, 15, 20, 21, 24, 25). Each name below is the `it` name:
  - `a rejecting id does not stop the drain`
  - `a hang stops the drain after one call and moves the row back`: 5 ids with a hook that never resolves, and `deletionHookTimeoutMs: 50`. Expect 1 call and `timedOut: true`. A second drain calls id 2 first.
  - `without a hook the ledger is unchanged and pending is reported`
  - `force discards pending rows and reports the count`
  - `an invalid deletionHookTimeoutMs throws before any call and leaves attempts unchanged`
  - `entity A's drain never sends entity B's ids`
  - `a re-delete during an in-flight confirmation stays pending`
  - `a host-held transaction makes the drain stop with no calls`: open a transaction with raw `BEGIN` through the unwrapped adapter, then drain.
  - `every drain ends: 300 rows with every third rejected, at most 300 calls`
  - `the same id in two concurrent drains is called once`
  - `resolved for a gone fact deletes the ledger row`
- [ ] **Step 2:** Run the file. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the file and `__tests__/diagnostics*.test.ts`. Expect PASS.
- [ ] **Step 5:** Commit `feat(core): VectorRemovalService drain with hook gate, keyset paging and in-flight map (§5.3-5.4)`.

### Task 3: `forget()` on the ledger

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts` (forget: replace the post-commit loop at ~`:638-654`)
- Modify: `packages/core/src/types.ts` (`WikiExternalDeletionError`)
- Modify: `packages/core/src/WikiMemory.ts` (construct `VectorRemovalRepository` and `VectorRemovalService`, pass the service to `MaintenanceService` as a new optional last constructor argument)
- Test: `packages/core/__tests__/vectorRemovalForget.test.ts`, plus updates to existing forget hook tests (find them with `grep -rln "ANN cleanup hook rejected" packages/core/__tests__`)

**Interfaces:**
- Consumes: `VectorRemovalService.drain`, `VectorRemovalRepository.backstopEnqueue` and `statusFor`.
- Produces:
  - `class WikiExternalDeletionError extends Error { readonly code = 'WIKI_EXTERNAL_DELETION'; entityId: string; unconfirmedIds: string[]; unconfirmedCount: number; timedOut: boolean; cause?: Error }`, exported from the core index.
  - The message prefixes and precedence follow spec §5.9.

- [ ] **Step 1: Write the failing tests** (spec tests 1, 4, 5, 16):
  - `forget continues past a rejecting id and lists only the unconfirmed ones`
  - `a forget retry after success makes no hook call`
  - `a legacy soft-deleted id without a ledger row is sent exactly once`: insert a row with `deleted_at` set via raw SQL with the triggers bypassed, by deleting its ledger row afterwards.
  - `forget sends only its own ids when the entity has a backlog`: 50 pending rows, then `forget({ entryId })` gives exactly 1 call.
  - `the timeout message wins over a rejection`
  - `forceDeleteIgnoreRankerHook: forget makes no call and resolves`
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement spec §5.5:
  - backstop in the transaction;
  - drain `{ entityId, ids }` after the commit, under the lock;
  - throw `WikiExternalDeletionError` when any selected id is still `'pending'`;
  - keep the `Invalid deletionHookTimeoutMs` error path.
- [ ] **Step 4:** Update existing tests that assert stop-at-first. Change the assertions, keep the scenarios. Run `pnpm exec vitest run __tests__/forget*.test.ts __tests__/vectorRemovalForget.test.ts` and every file found by the grep. Expect PASS.
- [ ] **Step 5:** Commit `feat(core): forget delivers removals through the ledger (§5.5)`.

### Task 4: `runPrune()` on the ledger

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts` (runPrune, ~`:240-360`)
- Modify: `packages/core/src/repositories/EntryRepository.ts` (`softDeleteByIds` gains `AND deleted_at IS NULL`)
- Test: `packages/core/__tests__/vectorRemovalPrune.test.ts`, plus updates to existing `PrunePartialFailureError` tests (`grep -rln PrunePartialFailureError packages/core/__tests__`)

**Interfaces:**
- Consumes: `drain`, `gate`, `externalIndexInUse`, `backstopEnqueue`, `statusFor`, `deleteForFacts`.
- Produces: nothing new. `PrunePartialFailureError` keeps its constructor.

- [ ] **Step 1: Write the failing tests** (spec tests 2, 10, 13 prune part, 14 prune part):
  - `a failing id is kept, the others are hard-deleted, and events and vacuum still run`: assert `deletedEvents` on the error.
  - `ids confirmed at forget time are not sent again by prune`
  - `pruneSupersededAfter sends null at soft-delete time`
  - `without a hook and with the marker set, prune keeps ledger rows`
  - `without a hook and never marked, prune removes ledger rows with their facts`
  - `force: prune hard-deletes and removes ledger rows with no call`
  - `a legacy prunable row without a ledger row is sent before its hard delete`
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement spec §5.6 steps 1–6.
- [ ] **Step 4:** Run the new file, `__tests__/prune*.test.ts` and the files found by the grep. Expect PASS.
- [ ] **Step 5:** Commit `feat(core): runPrune hard-deletes only confirmed removals and finishes before throwing (§5.6)`.

### Task 5: Heal, ingest, import and `upsertGraph`

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts` (heal loops at ~`:903-910` and `:1187-1194`)
- Modify: `packages/core/src/services/IngestionService.ts` (`:466-477`)
- Modify: `packages/core/src/services/ImportExportService.ts` (`:567-585`). Leave `:523` and `:548` alone: those are no-vector clears of live facts.
- Modify: `packages/core/src/WikiMemory.ts` (`syncSearchIndex` drains after its sync; `upsertGraph` JSDoc)
- Test: `packages/core/__tests__/vectorRemovalPaths.test.ts`

**Interfaces:**
- Consumes: `drain(scope, { trigger })`. These paths pass `ids` they collected, and never throw for removals.
- Produces: an `emitHookFailed(entityId, ids, operation)` helper inside `VectorRemovalService`, used for the `hook_failed` diagnostics these paths keep.

- [ ] **Step 1: Write the failing tests** (spec tests 6, 7, 8, 9, 11):
  - `heal orphan with a rejecting hook: pending, hook_failed, delivered by the next runPendingMaintenance`. If Task 7 isn't done yet, call `drain({ all: true })` directly, and leave a `// Task 7` note to switch it.
  - `heal with a hanging hook resolves within the timeout`
  - `full re-ingest with a rejecting hook leaves superseded ids pending`
  - `replace import with a rejecting hook leaves removals pending`
  - `a merge tombstone over a live fact delivers null`
  - `a replace import of the same ids leaves no ledger rows and no null calls`
  - `upsertGraph: no call inside the host transaction; rollback leaves no rows; syncSearchIndex delivers; a stable-id re-upsert leaves no row`
  - `force: heal and ingest make no removal call`
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement spec §5.7 (the heal, re-ingest, import and `upsertGraph` bullets, and the force-flag scope).
- [ ] **Step 4:** Run the new file plus `__tests__/heal*.test.ts`, `__tests__/ingest*.test.ts`, `__tests__/importDump*.test.ts` and `__tests__/upsertGraph*.test.ts`. Expect PASS.
- [ ] **Step 5:** Commit `feat(core): heal, ingest, import and upsertGraph deliver removals through the ledger (§5.7)`.

### Task 6: Embed after delete (G10)

**Files:**
- Modify: `packages/core/src/repositories/EntryRepository.ts`. `updateEmbeddingBlob` gains `AND deleted_at IS NULL` and returns `{ changes: number }`.
- Modify: `packages/core/src/services/EmbeddingService.ts`. Skip the vector hook when `changes === 0`. Add `afterVectorCall(entityId, factId)`: the `INSERT OR REPLACE … WHERE NOT EXISTS (live row)` statement from spec §5.7.
- Modify: `packages/core/src/services/RememberService.ts` and `TemporalService.ts`. After `embedFact`, call `afterVectorCall` and await `drain({ entityId, ids: [id] })`. Pass `VectorRemovalService` in through the constructors, and wire it in `WikiMemory.ts`.
- Test: `packages/core/__tests__/vectorRemovalEmbedRace.test.ts`

**Interfaces:**
- Consumes: `drain`.
- Produces: `EmbeddingService.afterVectorCall(entityId: string, factId: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (spec test 12):
  - `remember with a slow embed and a forget during it: the last hook call for the id is null`
  - `forget then runPrune({ retainSoftDeletedFor: 0 }) during an in-flight vector call: the last hook call is null`
  - `embedding a deleted fact stores no blob and makes no vector call`
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new file plus `__tests__/remember*.test.ts`, `__tests__/supersede*.test.ts`, `__tests__/runReembed.test.ts` and `__tests__/diagnosticsEmbedding.test.ts`. Expect PASS.
- [ ] **Step 5:** Commit `fix(core): an embed that lands after its fact was deleted ends with a null call (§5.7 G10)`.

### Task 7: Public API, `setup()` drain and `runPendingMaintenance`

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`:
  - `runExternalDeletions` and `getPendingExternalDeletions`;
  - `setup()` marks the marker and starts the drain;
  - `drain()` joins it;
  - `getPendingMaintenance` gains the field.
- Modify: `packages/core/src/services/MaintenanceScheduler.ts` (the `'externalDeletions'` job runs first)
- Modify: `packages/core/src/types.ts`:
  - `MaintenanceJob` gains `'externalDeletions'`;
  - `PendingMaintenance.pendingExternalDeletions?`;
  - `RunPendingMaintenanceResult.externalDeletions`;
  - `WikiOptions.drainExternalDeletionsOnSetup?`.
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/core/__tests__/vectorRemovalApi.test.ts`

**Interfaces:**
- Produces, exactly as spec §5.9:
  - `runExternalDeletions(entityId?: string, opts?: { deadlineMs?: number }): Promise<{ confirmed: number; pending: number; failedIds: string[]; timedOut: boolean }>`
  - `getPendingExternalDeletions(entityId?: string): Promise<{ count: number; oldestEnqueuedAt: number | null; maxAttempts: number }>`

- [ ] **Step 1: Write the failing tests** (spec tests 17, 18, 13 for `runPendingMaintenance`, 23 for the `'refuse'` path):
  - `crash recovery: rows committed in one instance are delivered by runExternalDeletions in a second instance on the same file`. Extend `openTestDatabase(path?: string)` in `__tests__/helpers/sqliteAdapter.ts` to accept a file path; the default stays `':memory:'`. Use a temp dir.
  - `setup drains owed removals; wiki.drain() awaits it`
  - `drainExternalDeletionsOnSetup: false makes no call and emits external_deletion_pending`
  - `the setup drain stops within its deadline when the hook hangs`
  - `runPendingMaintenance runs externalDeletions first, for wiped entities too, honors jobs and deadlineMs, and reports the counts`
  - `getPendingMaintenance lists an entity whose only work is removals`
  - `setup({ migrations: 'refuse' }) does not throw for the new schema objects`
  - `a hookless runPendingMaintenance leaves the ledger unchanged`
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. If Task 5 left a `// Task 7` test note, switch that test to `runPendingMaintenance` now.
- [ ] **Step 4:** Run the new file plus `__tests__/runPendingMaintenance*.test.ts`, `__tests__/getPendingMaintenance*.test.ts`, `__tests__/deferred*.test.ts` and `__tests__/WikiMemory.test.ts`. Expect PASS.
- [ ] **Step 5:** Commit `feat(core): runExternalDeletions, getPendingExternalDeletions, setup drain and maintenance job (§5.7, §5.9)`.

### Task 8: Docs, INTENT and Status notes

**Files:**
- Modify: `apps/docs/src/content/docs/guides/deleting-data.md`, `apps/docs/src/content/docs/project/security.md`, the relevant `apps/docs/src/content/docs/reference/*` pages
- Modify: `packages/core/src/types.ts` (`VectorRanker` JSDoc at ~`:784-792`)
- Modify: `INTENT.md` (rule 7 sentence, rule 7 Status, Amendments entry dated 2026-11-11)
- Modify: `specs/import-followups/spec.md` §6, `docs/superpowers/specs/2026-05-07-vectorranker-security-hardening.md` (append Status notes; never replace text)

- [ ] **Step 1:** Write the docs per spec §5.11 and §4. Use the exact INTENT rule 7 text from §5.11. Check every signature and default against the code before writing it.
- [ ] **Step 2:** Run `pnpm --filter ./apps/docs run build`. Expect `Complete!`.
- [ ] **Step 3:** Commit, with the INTENT change in its own commit: `docs(intent): rule 7 allows the no-model setup drain of owed removals`. Commit the rest as `docs: durable external removal contract`.

### Task 9: Whole-branch verification

- [ ] **Step 1:** Run `pnpm run build && pnpm run typecheck && pnpm test && pnpm --filter ./apps/docs run build && pnpm --filter ./apps/wiki-demo run lint`. Expect all green.
- [ ] **Step 2:** Run `grep -rn "llm_wiki_vector_removals" packages/core/src`. Expect no hits (prefix discipline).
- [ ] **Step 3:** Whole-branch review (requesting-code-review), then fix and re-run.
