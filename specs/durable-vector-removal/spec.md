# Durable removal of forgotten facts from the host's vector index

**Status:** Draft (2026-11-11).
**Date:** 2026-11-11
**Branch:** `docs/spec-durable-vector-removal`, stacked on PR #371 (`docs/spec-import-followups`); retargets to `main` after #371 merges.
**Source baseline:** `889da3f5` (PR #371 head).
**Found by:** the PR #371 review series (Haiku max, Fable high), then a Fable (high) architecture consult and an outside design review, 2026-11-11.
**Delivery:** one PR, draft until implemented, per `specs/README.md`. Commit types `feat(core):` / `fix(core):`, so semantic-release cuts a minor. Nobody edits `CHANGELOG.md` or any `"version"` field. No `BREAKING CHANGE` footer, and no body line starts with that phrase.

---

## 0. Intent check

- **INTENT promise: deletion (charter rule 8, "Your data is yours to take or delete").** A host that wires an external vector index through `VectorRanker.onEmbeddingPersisted` relies on `forget()` to remove the fact from that index too. Today that removal is best effort (§2). This spec makes it durable: once a delete commits, the engine keeps asking the host's hook to remove each affected fact until the hook succeeds once.
- **INTENT §7 ("Nothing spends your allowance invisibly"): amendment needed, ruled 2026-11-11.** §7 says "In deferred mode nothing runs in the background at all." §5.6 below finishes owed removals after `setup()` without the host asking. That work makes no model call and spends no tokens; it only calls the host's own hook for deletes the host already requested. The owner ruled on 2026-11-11 that this is allowed. The PR amends §7's sentence (§5.10) so INTENT and code agree. INTENT §7 changes go through the same review as code (INTENT "Changes to this file").
- **Rule 10 (spec first).** This is the spec.
- **Rule 8 (dependency surface).** No new dependency.
- **Curated Thoughts schema check (INTENT "Three kinds of software").** Curated Thoughts checks the wiki tables' schema from Rust at startup. §5.1 adds one table. Whether that check rejects an unknown table is **open question O1**, to be answered from the Curated Thoughts side before this ships. This repository does not edit Curated Thoughts.

## 1. Problem

The host's hook is told about a delete in a post-commit loop that is not recorded anywhere. So a forgotten fact can stay in the host's index for good, in these ways:

1. **First failure stops the rest.** `forget()` and `runPrune()` stop at the first id whose hook rejects or times out. The ids after it are never sent.
2. **Retries re-send.** A `forget()` retry re-enumerates soft-deleted rows, so it re-sends ids the hook already removed. A hook that throws "not found" fails the retry at the same id every time.
3. **A crash loses it.** Nothing records that removals are owed. If the process dies after `forget()` commits and before the loop ends, nothing resends them.
4. **Some paths only report, or never call.** Heal, re-ingest and replace-mode import report a failed call as `hook_failed` and never retry. Several paths never call the hook at all (§2).
5. **An embed can race a delete.** An embedding saved after its fact was deleted re-adds the vector.

`read()` is not affected: retrieval checks ranker hits against live rows (`RetrievalService.ts:877-890`), so a forgotten fact is never returned. The exposure is the vector left in the host's own index.

## 2. Evidence (verified against source at `889da3f5`)

| # | Path | Today | Gap |
|---|---|---|---|
| G1 | `forget`, `MaintenanceService.ts:638-654` | Post-commit loop, `notifyEmbeddingPersistedOrThrow`; first failure throws | Later ids never sent; crash loses all |
| G2 | `forget` retry, `MaintenanceService.ts:555,605`; `EntryRepository.findIdById:411-418` | Selectors include soft-deleted rows | Re-sends removed ids; "not found" blocks retries |
| G3 | `runPrune` hard delete, `MaintenanceService.ts:284-297` | Hook before hard delete, `break` at first failure; `getPrunableMetadata` (`EntryRepository.ts:611-622`) has no `ORDER BY` | One failing id blocks the ones after it on every run |
| G4 | `runPrune` superseded step, `MaintenanceService.ts:271-280` | `softDeleteByIds`, no hook | Vector stays until the hard delete, 7 days by default |
| G5 | Heal orphan pass, `MaintenanceService.ts:896-910`; heal delete, `:1187-1194` | `notifyEmbeddingPersisted` (no timeout), failure → `hook_failed` | Never retried; a hanging hook hangs heal |
| G6 | Re-ingest, `IngestionService.ts:456-477` | Same best-effort loop, and only when `failedChunks === 0` | Never retried; on a partial ingest the superseded facts are never sent |
| G7 | `importDump` replace, `ImportExportService.ts:567-585` | Same best-effort loop | Never retried |
| G8 | `importDump` merge tombstone, `ImportExportService.ts:350-351,567` | A bundle fact with `deleted_at` soft-deletes a live fact; the loop walks `softDeletedFactIds`, empty in merge mode | Hook never called |
| G9 | Public `upsertGraph`, `WikiMemory.ts:985-1036`; `IngestionService.ts:720-721` | Supersedes facts inside the host's transaction | Hook never called |
| G10 | Embed after delete, `EntryRepository.updateEmbeddingBlob:1161-1173`; `EmbeddingService.ts:195-212` | `UPDATE … WHERE id = ?`, no `deleted_at IS NULL`; then the hook with the vector | `remember()` (`RememberService.ts:47-51`) and `supersede()` (`TemporalService.ts:96-101`) embed after commit, outside any lock, so a concurrent `forget` can be followed by the vector being re-added |

Not gaps: librarian ops UPDATE/DELETE set `valid_to` only (the fact stays as history and reaches G4 later). Reembed reads live rows only, and is excluded with forget by lock.

## 3. Goal and non-goals

**Goal.** Once a delete commits, every affected fact id is recorded in the same transaction, and the engine keeps calling `onEmbeddingPersisted({ entityId, factId, vector: null })` until it resolves once for that id, across retries, restarts and crashes. `runPrune()` never hard-deletes a fact whose removal is unconfirmed. One failing id never blocks the others. A confirmed id is not sent again by the engine. The host can see what is owed.

**Non-goals.**
- A batch hook (`onEmbeddingsRemoved`). It is the real speed lever and is a follow-up (§9).
- Auditing the host's index, its backups or replicas.
- Exporting the ledger in `exportDump`.
- Changing what `read()` returns.

## 4. What stays with the host (irreducible)

The docs state these plainly (§5.10):

1. **The hook must tolerate a repeat, and must not resolve without removing.** Delivery is at least once: a crash between the hook resolving and the engine recording it means one repeat. The engine cannot tell "already gone" from a real failure, so a hook that throws on "not found" keeps that id pending (it no longer blocks other ids).
2. **The app must run again.** An uninstalled or never-reopened app cannot call a remote index. A hard deadline needs a server-side delete.
3. **Every process that deletes configures the same hook.** A delete committed with no hook configured is not recorded (§5.2); `runPrune()` still calls the hook before the hard delete if one is configured then (§5.5).
4. **Copies the hook does not reach.** Index backups, outbox consumers (`enableOutbox`), and rows changed with raw SQL.
5. **Deadlines.** The engine guarantees eventual delivery while the app runs; the host monitors the pending count (§5.8).

## 5. Proposed change

### 5.1 Schema: the removal ledger

One table, created in the every-open base DDL (`packages/core/src/db/schema.ts`), so no code path can see it missing (the #316 lesson):

```sql
CREATE TABLE IF NOT EXISTS {prefix}vector_removals (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id      TEXT NOT NULL,
  fact_id        TEXT NOT NULL UNIQUE,
  enqueued_at    INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  confirmed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS {prefix}vector_removals_pending
  ON {prefix}vector_removals (entity_id, attempts, seq) WHERE confirmed_at IS NULL;
```

- Ids only, no fact content.
- No backfill.
- Plus one migration that only bumps `schema_version`, so a pinned reader can tell the shape changed (subject to O1).
- `seq` is the guard against a lost re-delete: re-enqueueing an id replaces its row, which gets a new `seq` (§5.2), and a confirmation only applies `WHERE seq = ?` of the row it drained (§5.3).

### 5.2 Enqueue, in the deleting transaction

A new `VectorRemovalRepository` writes the ledger. Every site that moves a fact from live to deleted calls it in the same transaction as the soft delete, beside the existing `outbox.push`:

- `EntryRepository.softDelete`, `softDeleteBySource`, `softDeleteByIds`, `bulkSoftDeleteByEntityId`, `markOrphaned`.
- `EntryRepository.upsertForImport` / `upsert` when the incoming row has `deleted_at` set and the stored row was live (closes G8).
- `upsertGraph`'s supersession, inside the host's transaction (closes G9); it rolls back with that transaction.

Rules:
- **Bulk sites use one statement:** `INSERT OR REPLACE INTO …vector_removals (entity_id, fact_id, enqueued_at) SELECT entity_id, id, ? FROM …entries WHERE <the UPDATE's own predicate>`. A 120,000-row wipe is one statement, not 120,000.
- **`INSERT OR REPLACE`** resets `attempts`, `last_attempt_at` and `confirmed_at`, and assigns a new `seq`. A fact deleted again after a confirmation is owed again.
- **Gated on configuration.** No row is written when `vectorRanker?.onEmbeddingPersisted` is absent or `forceDeleteIgnoreRankerHook === true`. Apps without an external index pay nothing.

### 5.3 Drain

One routine, `drainVectorRemovals(entityId, opts)`, in a new `VectorRemovalService`. Never inside a transaction. No `JobManager` lock: it reads and writes only the ledger, plus a read of `entries`.

- **Single flight per entity.** A drain requested while one is running for the same entity waits for it, then runs once more, so rows enqueued after the first drain started are covered.
- **Order:** `attempts ASC, seq ASC`, in pages of 100. A failing id sinks behind fresh ones and cannot starve them.
- **Per row:**
  1. Re-read the fact. If it is live again (resurrected by a later import or upsert), delete the ledger row without calling the hook.
  2. Otherwise call `notifyEmbeddingPersistedOrThrow(entityId, factId, null)` (the existing timeout applies).
  3. On success, `UPDATE … SET confirmed_at = ? WHERE seq = ?`. Writes are batched, one transaction per page.
  4. On rejection, bump `attempts` and `last_attempt_at`, and continue.
- **Stops** at the first timeout (a dead index costs one timeout, not one per id), after 5 consecutive rejections, or at `opts.deadlineMs`. It never gives up on a row.
- **Returns** `{ confirmed: string[]; pending: number; failedIds: string[]; timedOut: boolean }`.

### 5.4 `forget()`

After the commit, `forget()` drains the entity, then:
- resolves when every id this call selected is confirmed;
- otherwise throws `WikiExternalDeletionError` (§5.7). The local delete stays committed and the unconfirmed ids stay owed.

A retry sends only ids still unconfirmed: confirmed ids are skipped (closes G1, G2). `forceDeleteIgnoreRankerHook` keeps today's meaning: no hook call, no ledger row, no error.

### 5.5 `runPrune()`

- The superseded step (G4) now enqueues through `softDeleteByIds`, so the removal is sent at soft-delete time, not 7 days later.
- **Backstop.** A prunable row with no ledger row (deleted before this release, or while no hook was configured) is enqueued before the drain, if a hook is configured now.
- After the drain, prune hard-deletes every prunable row that is confirmed or has no hook configured, and deletes those ledger rows in the same transaction.
- An unconfirmed row is never hard-deleted (closes G3). If any remain, prune throws `PrunePartialFailureError` with the same class and fields. `deleted` counts rows hard-deleted, `remaining` counts rows left, `failedAt` names the first unconfirmed id in drain order. The rows are no longer contiguous; the JSDoc says so.
- Ids confirmed at forget time are not sent again.

### 5.6 After `setup()`, and in `runPendingMaintenance()`

- **After `setup()` (owner ruling 2026-11-11).** When the hook is configured and the ledger has pending rows, `setup()` starts one drain over every entity with pending rows. It is not awaited, has a total deadline of 10 s, and emits `background_job_failed` if it throws. It makes no model call. Hosts disable it with `config.externalDeletions.drainOnSetup: false`.
- **`runPendingMaintenance()`** drains every entity with pending rows, including entities wiped with `clearAll`, before its librarian work. It does not draw from `tokenBudget`. It runs while `opts.deadline` (if any) allows.
- **Backoff.** Automatic drains (after `setup()`, and inside heal, ingest and import) skip a row whose `last_attempt_at` is within `min(2^attempts, 3600)` s. `forget()`, `runPrune()`, `runPendingMaintenance()` and `runExternalDeletions()` ignore backoff.

### 5.7 Other paths

- **Heal (G5), re-ingest (G6), replace-mode import (G7).** The post-commit loops become a non-throwing drain of the entity, under the existing timeout. A rejection still emits `hook_failed`. The removal stays owed.
- **Partial ingest (G6).** Superseded facts are enqueued whenever they are soft-deleted, so a partial ingest owes them like a full one.
- **Embed after delete (G10).**
  - `updateEmbeddingBlob` gains `AND deleted_at IS NULL` and returns the change count. When it is 0, `embedFact` skips the hook.
  - After a hook call with a vector resolves, one statement enqueues the id if its fact is no longer live, then a non-awaited drain runs. So the last call the host sees for a deleted id is `null`.

### 5.8 Public API (all additive)

- `wiki.runExternalDeletions(entityId?: string, opts?: { deadlineMs?: number }): Promise<{ confirmed: number; pending: number; failedIds: string[]; timedOut: boolean }>`. No `entityId` means every entity with pending rows.
- `wiki.getPendingExternalDeletions(entityId?: string): Promise<{ count: number; oldestEnqueuedAt: number | null; maxAttempts: number }>`.
- `class WikiExternalDeletionError extends Error` with:
  - `entityId`;
  - `unconfirmedIds` (at most 100);
  - `unconfirmedCount`;
  - `timedOut`;
  - `cause` (sanitized, as today).

  Its message keeps today's prefix, `forget(<entityId>/<first id>) failed: ANN cleanup hook rejected` (or `… : <timeout message>`), so existing matchers keep working.
- **New diagnostic `external_deletion_pending`,** content-free: `{ count, oldestEnqueuedAt, maxAttempts }`. It is emitted after `setup()` when pending rows exist, and after any drain that leaves rows pending.
- **`PendingMaintenance.pendingExternalDeletions: number`.** `getPendingMaintenance()` lists an entity whose only pending work is removals.
- **`WikiConfig.externalDeletions?: { drainOnSetup?: boolean }`,** default `true`.
- **React.** No new hook. `useWikiForget` surfaces `WikiExternalDeletionError` like any other rejection.

### 5.9 Locks and concurrency

- `forget` and `runPrune` keep their `JobManager` locks around their own transactions, and drain while holding them, as today. Background drains take no lock and coordinate only through single flight.
- A hook that timed out may still be running when a later drain sends the same id. The host's hook must tolerate overlap (§4.1).
- Two `WikiMemory` instances on one database (SynapseTree) are not coordinated. The worst case is a duplicate call, which §4.1 already covers.

### 5.10 Docs and INTENT

- **`guides/deleting-data.md`:** replace the "Current limits" caution (added in #371) with the §3 guarantee and the §4 list. Document `runExternalDeletions`, `getPendingExternalDeletions`, the diagnostic, `drainOnSetup` and `WikiExternalDeletionError`.
- **`VectorRanker` JSDoc** (`types.ts:784-792`) and `project/security.md`: the same guarantee, briefly.
- **`reference/*`:** add the new methods and error, using the reference pages' layout.
- **INTENT §7:** "In deferred mode nothing runs in the background at all; the host decides when and how much." becomes "In deferred mode nothing that calls a model runs in the background; the host decides when and how much. The one exception makes no model call: after `setup()`, the engine finishes removals from the host's vector index that the host already requested (`externalDeletions.drainOnSetup`, on by default)."
- **Status notes owed (appended, never replacing):** `specs/import-followups/spec.md` §6 gets a pointer to this spec for external-index removal.

## 6. Owner rulings

1. **Ship in its own spec and PR, after #371.** Ruled 2026-11-11 (accepted).
2. **Finish owed removals in the background after `setup()`, under deferred mode too.** Ruled 2026-11-11: allowed. Recommended guardrails: no model calls, hook configured only, not awaited, 10 s deadline, opt-out flag (§5.6).

## 7. Open questions

- **O1.** Does the Curated Thoughts startup schema check accept an unknown table `{prefix}vector_removals` and a `schema_version` one higher? To be answered from the Curated Thoughts side. Until it is, this PR stays draft.
- **O2.** Is 10 s the right total deadline for the setup drain on mobile, or should it scale with the hook timeout?
- **O3.** Should the engine purge confirmed ledger rows for facts that will never be pruned (`pruneRetainSoftDeletedFor: null`)? Proposed: no. Rows are small, and prune removes them with their fact.

## 8. Test plan (each must fail before the change and pass after)

1. **Continue past a failure.** `forget({ sourceRef })` over 3 ids, hook rejects id 1: ids 2 and 3 are called. `WikiExternalDeletionError.unconfirmedIds` is `[id1]`.
2. **A failing id doesn't block prune.** Prune hard-deletes the confirmed rows and keeps the failing one. A `forget` retry does not re-call the confirmed ids.
3. **Crash.**
   - Setup: commit a forget with the hook stubbed to never run. Simulate this by enqueueing and killing before the drain.
   - Then open a new `WikiMemory` on the same database with a healthy hook.
   - Expect: `runExternalDeletions()` calls every id, and pending is 0.
4. **Setup drain.** Same setup as test 3, with `drainOnSetup` on. Every id is delivered without a host call. With `drainOnSetup: false`, no call happens and the diagnostic fires.
5. **Hanging hook on 5 ids.** Exactly one call, `timedOut: true`, 5 pending.
6. **Single `entryId` retry after success.** No hook call, zero counts.
7. **Heal orphan and heal delete with a rejecting hook.** The row stays pending and `hook_failed` fires. The next `runPendingMaintenance` delivers it.
8. **Heal with a hanging hook** resolves within the timeout.
9. **Re-ingest, full and partial, with a rejecting hook.** The superseded ids are pending and delivered later.
10. **`importDump`.** In replace mode with a rejecting hook, removals stay pending. A merge tombstone over a live fact delivers `null`.
11. **`pruneSupersededAfter`.** `null` is delivered at soft-delete time.
12. **`upsertGraph`.**
    - No hook call inside the host transaction.
    - A rollback leaves no ledger rows.
    - After commit, the next drain delivers.
    - A stable-id re-upsert of a live fact enqueues nothing.
13. **Embed race.**
    - Setup: `remember()` with a slow embed, and a `forget` during it.
    - Expect: no vector call after the forget.
    - With a vector call already in flight, the last call for the id is `null`.
14. **Once per id across forget and prune.** A legacy soft-deleted row with no ledger row is still called before its hard delete.
15. **Prune never hard-deletes an unconfirmed id.** `PrunePartialFailureError` fields are as specified.
16. **No hook, or `forceDeleteIgnoreRankerHook`.** Zero ledger writes, zero calls, and forget and prune behave as today.
17. **`clearAll` on 130,000 facts.** The enqueue runs as one statement.
18. **Draining entity A** never sends entity B's ids.
19. **Re-delete during an in-flight confirmation.** The id stays pending (`seq` guard).
20. **Schema.** Fresh and upgraded stores both have the table and index. `setup({ migrations: 'refuse' })` reports the version bump like any other migration.
21. **Resurrection.** A fact made live again before its drain gets no `null` call, and its ledger row is gone.

## 9. Follow-ups (not in this PR)

- Optional batch hook `onEmbeddingsRemoved({ entityId, factIds })` for indexes with bulk delete.
- A `deleted_at` filter or ledger check for other callers of `notifyEmbeddingPersisted` with a vector (reembed is already safe by lock).
