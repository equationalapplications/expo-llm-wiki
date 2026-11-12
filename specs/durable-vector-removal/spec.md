# Durable removal of forgotten facts from the host's vector index

**Status:** Reviewed (2026-11-11: Opus high review, revision 2; owner directed implementation). Previously Draft (2026-11-11).
Revision 2 (2026-11-11), after an Opus (high) review of revision 1:
- The ledger is filled by SQLite triggers, not by call-site edits (§5.2).
- A process without the hook never clears an obligation (§5.3).
- In-call drains send their own ids first (§5.4).
- Timeouts and paging are fixed so one row can't block the rest (§5.4).
- Resurrection removes the obligation (§5.2).
- Prune finishes its other work before it throws (§5.6).
- The INTENT §7 wording is corrected (§5.11).
- The test plan is rewritten (§8).

Revision 3 (2026-11-11), from the Task 2 review: calls in flight are keyed by ledger row (`seq`), not by fact (§5.4); the drain's deadline is an absolute time named `deadlineAt`; a failed write transaction stops the drain as transient; liveness is checked per page (§5.4). From the Task 3 review: forget on a never-set-up store falls back to per-id hook calls (§5.5.5); a hookless store without the marker emits no pending diagnostic (§5.3).

**Date:** 2026-11-11
**Branch:** `docs/spec-durable-vector-removal`, stacked on PR #371 (`docs/spec-import-followups`); retargets to `main` after #371 merges.
**Source baseline:** `889da3f5` (PR #371 head).
**Found by:** the PR #371 review series (Haiku max, Fable high), then a Fable (high) architecture consult, an outside design review, and an Opus (high) spec review, 2026-11-11.
**Delivery:** one PR, draft until implemented, per `specs/README.md`. Commit types `feat(core):` / `fix(core):`, so semantic-release cuts a minor. Nobody edits `CHANGELOG.md` or any `"version"` field. No `BREAKING CHANGE` footer, and no body line starts with that phrase.

---

## 0. Intent check

- **Deletion promise (charter rule 8, "Your data is yours to take or delete").**
  - A host that wires an external vector index through `VectorRanker.onEmbeddingPersisted` relies on `forget()` to remove the fact there too. Today that removal is best effort (§2).
  - This spec makes it durable: once a delete commits, the engine records it, and it keeps asking the host's hook to remove the fact until the hook succeeds once.
- **INTENT rule 6 ("nothing is dropped silently").** An obligation is never cleared without a hook call or a stated reason (§5.3).
- **INTENT rule 7 ("Nothing spends your allowance invisibly"): amendment needed, ruled 2026-11-11.**
  - Rule 7 says "In deferred mode nothing runs in the background at all."
  - §5.7 finishes owed removals after `setup()` without the host asking. That work makes no model call and spends no tokens. It only calls the host's own hook for deletes the host already requested.
  - The owner ruled on 2026-11-11 that this is allowed. §5.11 amends rule 7 with that one exception and adds a dated Amendments entry.
- **Rule 10 (spec first).** This is the spec.
- **Rule 8 (dependency surface).** No new dependency.
- **Curated Thoughts schema check (INTENT "Three kinds of software").**
  - Curated Thoughts checks the wiki tables' schema from Rust at startup, before the JS engine loads.
  - §5.1 adds one table, one index and two triggers. That is **open question O1**, to be answered from the Curated Thoughts side before this ships.
  - This repository does not edit Curated Thoughts.

## 1. Problem

The host's hook hears about a delete only from a post-commit loop that nothing records. So a forgotten fact can stay in the host's index for good:

1. **The first failure stops the rest.** `forget()` and `runPrune()` stop at the first id whose hook rejects or times out, and the ids after it are never sent.
2. **Retries re-send.** A `forget()` retry re-enumerates soft-deleted rows, so it re-sends ids the hook already removed. A hook that throws "not found" fails the retry at the same id every time.
3. **A crash loses it.** Nothing records that removals are owed. If the process dies after `forget()` commits and before the loop ends, nothing resends them.
4. **Some paths only report, or never call.** Heal, re-ingest and replace-mode import report a failed call as `hook_failed` and never retry. Some paths never call the hook at all (§2).
5. **An embed can race a delete.** An embedding saved after its fact was deleted re-adds the vector.

`read()` is not affected. Retrieval checks ranker hits against live rows (`RetrievalService.ts:877-890`), so a forgotten fact is never returned. The exposure is the vector left in the host's own index.

## 2. Evidence (verified against source at `889da3f5`, and by the Opus review)

| # | Path | Today | Gap |
|---|---|---|---|
| G1 | `forget`, `MaintenanceService.ts:638-654` | Post-commit loop, `notifyEmbeddingPersistedOrThrow`; first failure throws | Later ids never sent; crash loses all |
| G2 | `forget` retry, `MaintenanceService.ts:555,605`; `EntryRepository.findIdById:411-418` | Selectors include soft-deleted rows | Re-sends removed ids; "not found" blocks retries |
| G3 | `runPrune` hard delete, `MaintenanceService.ts:284-333` | Hook before hard delete; `break` at first failure; the throw skips event retention, vacuum and the final sync; `getPrunableMetadata` (`EntryRepository.ts:611-622`) has no `ORDER BY` | One failing id blocks the ones after it, and the rest of prune, on every run |
| G4 | `runPrune` superseded step, `MaintenanceService.ts:271-280` | `softDeleteByIds`, no hook | Vector stays until the hard delete, 7 days by default |
| G5 | Heal orphan pass, `MaintenanceService.ts:896-910`; heal delete, `:1187-1194` | `notifyEmbeddingPersisted` (no timeout); failure → `hook_failed` | Never retried; a hanging hook hangs heal |
| G6 | Re-ingest (full path), `IngestionService.ts:456-477` | Same best-effort loop | Never retried. (The partial path supersedes nothing, `:383-396`, so it has no gap.) |
| G7 | `importDump` replace, `ImportExportService.ts:152-160,567-585` | Same best-effort loop | Never retried |
| G8 | `importDump` merge tombstone, `ImportExportService.ts:350-351,567` | A bundle fact with `deleted_at` soft-deletes a live fact; the loop walks `softDeletedFactIds`, which is empty in merge mode | Hook never called |
| G9 | Public `upsertGraph`, `WikiMemory.ts:944,985-1036`; `IngestionService.ts:720-721` | Supersedes facts inside the host's transaction | Hook never called |
| G10 | Embed after delete, `EntryRepository.updateEmbeddingBlob:1161-1173`; `EmbeddingService.ts:195-212` | `UPDATE … WHERE id = ?`, no `deleted_at IS NULL`; then the hook with the vector | `remember()` (`RememberService.ts:47-51`) and `supersede()` (`TemporalService.ts:96-101`) embed after commit, outside any lock, so a concurrent `forget`, or a forget followed by a prune, can be followed by the vector being re-added |

**Not gaps:**
- Librarian ops UPDATE/DELETE only set `valid_to`. The fact stays as history and reaches G4 later.
- Reembed reads live rows only (`EntryRepository.ts:1242-1253`), and its lock excludes it from running alongside forget.
- The only hard delete of `entries` is `bulkDeletePruned`.
- Tasks and edges carry no vectors.
- Import's `null` call for a live fact with no vector (`ImportExportService.ts:523`) removes an embedding, not a fact, and stays off the ledger.

## 3. Goal and non-goals

**Goal.**
- Once a delete commits, every affected fact id is recorded in the same transaction.
- The engine keeps calling `onEmbeddingPersisted({ entityId, factId, vector: null })` until it resolves once for that id, across retries, restarts and crashes.
- `runPrune()` never hard-deletes a fact whose removal is unconfirmed while a hook is in use.
- One failing id never blocks the others.
- The engine does not send a confirmed id again.
- A process without the hook never clears an obligation.
- The host can see what is owed.

**Non-goals:**
- A batch hook (`onEmbeddingsRemoved`). It is the real speed lever, and it's a follow-up (§9).
- Auditing the host's index, its backups or its replicas.
- Exporting the ledger in `exportDump`.
- Changing what `read()` returns.

## 4. What stays with the host (irreducible)

The docs state these plainly (§5.11):

1. **The hook must tolerate a repeat, and must not resolve without removing.**
   - Delivery is at least once. A crash between the hook resolving and the engine recording it means one repeat, and so does a timed-out call that is still running when a later drain resends it.
   - The engine can't tell "already gone" from a real failure. A hook that throws on "not found" keeps that id pending; it no longer blocks other ids.
2. **The app must run again.** An uninstalled or never-reopened app can't call a remote index. A hard deadline needs a server-side delete.
3. **Every process that drains uses the same hook.** A process without the hook leaves obligations untouched (§5.3), so they wait for one that has it.
4. **Copies the hook doesn't reach:** index backups, outbox consumers (`enableOutbox`), and the host's other systems.
5. **Deadlines.** The engine guarantees eventual delivery while the app runs. The host monitors the pending count (§5.9).

## 5. Proposed change

### 5.1 Schema: the removal ledger

One table, one index and two triggers, all created in the every-open base DDL (`packages/core/src/db/schema.ts`), so no code path can see them missing (the #316 lesson):

```sql
CREATE TABLE IF NOT EXISTS {p}vector_removals (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id       TEXT NOT NULL,
  fact_id         TEXT NOT NULL UNIQUE,
  enqueued_at     INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  confirmed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS {p}vector_removals_pending
  ON {p}vector_removals (entity_id, attempts, seq) WHERE confirmed_at IS NULL;
```

**Why a table, not a column on `entries`:**
- Ledger rows must outlive the fact's hard delete (§5.3 and the G10 fix).
- Curated Thoughts checks the `entries` columns.
- A partial index on `entries` would be an unchunked scan of the largest table.

**Schema version:**
- No `schema_version` bump. A version-only migration would make hosts on `migrations: 'auto'` or `'refuse'` throw `WikiMigrationRequiredError` on first open, for a migration with no work (`sourceRefNormalize.ts:113-116`).
- Bump only if O1 requires it.

**The `seq` guard:**
- Re-enqueueing an id replaces its row, which takes a new `seq`.
- A confirmation, an attempt bump or a resurrection delete applies only `WHERE seq = ?` of the row the drain read.

### 5.2 Enqueue: triggers on `entries`

Triggers fill the ledger. Call sites don't, which covers every path, future ones, and the host's own raw-SQL deletes. The FTS ledger uses the same pattern (`services/search/fts5Sql.ts:68-83`).

```sql
CREATE TRIGGER IF NOT EXISTS {p}vector_removals_enqueue
AFTER UPDATE OF deleted_at ON {p}entries
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO {p}vector_removals (entity_id, fact_id, enqueued_at)
  VALUES (NEW.entity_id, NEW.id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS {p}vector_removals_resurrect
AFTER UPDATE OF deleted_at ON {p}entries
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  DELETE FROM {p}vector_removals WHERE fact_id = NEW.id AND confirmed_at IS NULL;
END;
```

- **Coverage.** `ON CONFLICT DO UPDATE` fires UPDATE triggers. So the upsert in `upsertGraph` (G9), tombstones written by `upsertForImport` and `upsert` (G8), and every bulk soft delete enqueue with no code change.
- **Bulk wipes.** A 120,000-row `clearAll` is still one statement from JS; SQLite runs the trigger per row in C.
- **Resurrection in the same transaction.** Supersede-then-upsert of the same ids (`upsertGraph`, replace-mode import of a backup) inserts and then deletes the row in one transaction. The commit leaves no ledger row, and no `null` is sent.
- **Re-delete.** `INSERT OR REPLACE` resets `attempts`, `last_attempt_at` and `confirmed_at`, and takes a new `seq`. A fact deleted again after a confirmation is owed again.
- **Gating.** The triggers fire whether or not a hook is configured. The gate is at drain and prune time (§5.3, §5.6). An app with no external index pays one small insert per deleted fact. Prune removes it with the fact (§5.6).
- **`enqueued_at`** uses SQLite's clock at second resolution, which is enough to order and to report the oldest pending row. `seq` gives the exact order.

### 5.3 The hook gate, and the "external index in use" marker

The ledger has three cases, decided per process:

| Process state | Drains | Prune |
|---|---|---|
| Hook configured, no force | Call the hook (§5.4) | Hard-delete only confirmed rows (§5.6) |
| No hook configured | **No change to the ledger.** Report `{ pending }`. Emit `external_deletion_pending` when rows are pending **and** the store has the marker (below); a store that never had an external index stays quiet | Hard-delete the fact. Keep its ledger row unless the store has never had a hook (below) |
| `forceDeleteIgnoreRankerHook: true` | Delete pending rows without calling (the index was decommissioned). Report the count in a content-free `external_deletion_discarded` diagnostic | Hard-delete freely, and remove the ledger rows |

**The marker.** `setup()` records a sticky meta key, `external_index_in_use = 1`, whenever `vectorRanker.onEmbeddingPersisted` is configured. Prune in a process without the hook removes ledger rows with their facts only while the marker is absent. Without the marker, the store has never had an external index, so nothing is owed. A force-mode drain clears the marker.

`notifyEmbeddingPersistedOrThrow` returns early as success when there is no hook or force is set (`EmbeddingService.ts:275-276`). So the drain checks the gate itself, before calling. It never relies on that early return.

### 5.4 Drain

One routine, `drainVectorRemovals(scope, opts)`, in a new `VectorRemovalService`. `scope` is either `{ entityId, ids? }` or `{ all: true }`.

- **No `JobManager` lock.** It reads the ledger and `entries`, and writes only the ledger.
- **Validation.** It validates `deletionHookTimeoutMs` once before draining, and throws the existing `Invalid deletionHookTimeoutMs` error.
- **Per-row in flight.** Each instance keeps a `Map<factId, { seq, promise }>` of calls in flight.
  - A drain that reaches the same `seq` already in flight awaits that promise, raced against its own per-call budget, and doesn't call again.
  - Only the drain that made the call settles the row (confirm or bump), so one call never bumps `attempts` twice.
  - If the joiner's budget runs out first, it counts as a timeout for the joiner: it stops without settling. The shared call keeps running.
  - If the in-flight entry has a different `seq` (the fact was re-deleted), the drain awaits it and then makes a fresh call for its own `seq`. A `null` sent before a re-delete never confirms the newer obligation.
  - No per-entity coalescing.
- **Snapshot and keyset paging.**
  - At start, the drain reads `maxSeq`.
  - It pages with `WHERE confirmed_at IS NULL AND seq <= :maxSeq AND (attempts, seq) > (:lastAttempts, :lastSeq) ORDER BY attempts, seq LIMIT 100`. Each row is tried at most once per drain, and every drain ends.
  - For `{ entityId, ids }`, it pages over those ids first (§5.5).
- **Page reads.** Each page is read in one statement, `LEFT JOIN {p}entries`, so the drain knows whether the fact is live, soft-deleted or gone. The read runs inside a short `withTransactionAsync` on the serialized adapter, and no hook is called until that transaction closes.
  - If the read can't begin (for example, the host holds an open transaction on the same connection), the drain stops as transient. Rows aren't touched.
  - A settling write that fails stops the drain the same way. That page's results are lost, the rows stay pending (safe; at worst a repeat call), and the result carries `transient: true`.
  - Liveness is read once per page. A fact made live again during its page can still get `null`. That costs recall, not privacy, like the in-flight window below.
- **Per row:**
  1. If the fact is live, the row is stale (resurrected after the read): delete it `WHERE seq = ?`, no call.
  2. Otherwise call the hook with `vector: null`. The per-call timeout is `min(deletionHookTimeoutMs, time left before opts.deadlineAt)`.
  3. **Resolved:** set `confirmed_at WHERE seq = ?`. If the fact row is gone (already hard-deleted), delete the ledger row instead. Writes are batched, one transaction per page.
  4. **Rejected or timed out:** bump `attempts` and `last_attempt_at WHERE seq = ?`. A timeout counts the same, so a hanging id moves behind the others.
- **Stop conditions:** the first timeout (a dead index costs one timeout per drain, not one per id), 5 consecutive rejections, or `opts.deadlineAt` (an absolute `Date.now()` time). Public APIs take `deadlineMs`, a duration from the call, and convert it.
- **Backoff, for automatic drains only:** skip a row whose `last_attempt_at` is within `min(2^attempts, 3600)` s. Calls the host makes ignore backoff.
- **Result:** `{ confirmed: number; pending: number; failedIds: string[] /* ≤ 100 */; timedOut: boolean; transient?: boolean }`. `confirmed` counts rows whose confirmation or gone-row delete actually changed a row.
- **Known window (accepted).** If a fact is resurrected while its `null` call is in flight, the host's index loses the live fact's vector. That costs recall, not privacy, and `runReembed` restores it.

### 5.5 `forget()`

1. **Backstop, inside its own transaction.** For selected ids that have no ledger row (soft-deleted before this release, or by a store that never had the marker), it runs `INSERT OR IGNORE INTO {p}vector_removals … SELECT … WHERE NOT EXISTS (…)`. A retry by a host mid-way through #371's documented recovery therefore still sends every id.
2. **After the commit,** while it still holds its lock, it drains `{ entityId, ids: <this call's selected ids> }`. Only those ids, not the entity's whole backlog. The backlog belongs to the drains in §5.7 and §5.9.
3. **Outcome:**
   - It resolves when every selected id is confirmed, or has no ledger row because it's gone or resurrected.
   - Otherwise it throws `WikiExternalDeletionError` (§5.9). The local delete stays committed, and the unconfirmed ids stay owed.
   - Under the no-hook row of §5.3, it resolves, and the obligations stay recorded.
4. **A retry** sends only ids still unconfirmed (closes G1 and G2).
5. **Store whose `setup()` never ran** (the #316 recovery path): the ledger table doesn't exist yet. With a hook configured, forget falls back to calling the hook per selected id, continuing past failures, and throws `WikiExternalDeletionError` for the ids not confirmed. Nothing is recorded, because there is nowhere to record it; the error tells the host to retry.
6. **Outcome message when no cause is known** (an id still pending after a shared in-flight call or a transient stop): `forget(<entityId>/<id>) failed: ANN cleanup not confirmed`.

### 5.6 `runPrune()`

1. **Superseded step (G4).** `softDeleteByIds` fires the trigger, so removal is sent at soft-delete time, not 7 days later. `softDeleteByIds` gains `AND deleted_at IS NULL`, so a repeat never re-stamps `deleted_at`.
2. **Backstop.** Prunable rows with no ledger row get `INSERT OR IGNORE`, when the hook is configured.
3. **Drain** `{ entityId, ids: <prunable ids> }`.
4. **Hard delete.** It hard-deletes the prunable rows the §5.3 table allows, and deletes their ledger rows in the same transaction. An unconfirmed row is never hard-deleted while a hook is configured (closes G3).
5. **Then it finishes event retention, vacuum and the final sync**, and only then throws `PrunePartialFailureError` if rows remain.
   - The class and fields stay the same, and `deletedEvents` is filled in.
   - `deleted` counts rows hard-deleted, `remaining` counts rows kept, and `failedAt` names the first unconfirmed id in drain order. Rows are no longer contiguous; the JSDoc says so.
   - `cause`: a timeout takes precedence, otherwise the first rejection, sanitized as today.
6. Ids confirmed at forget time aren't sent again.

### 5.7 Drains outside `forget` and `runPrune`

- **After `setup()` (owner ruling 2026-11-11).** When the hook is configured and the ledger has pending rows, `setup()` starts one `{ all: true }` drain.
  - It isn't awaited, uses backoff, and has a 10 s total deadline. Because of the per-call cap in §5.4, its real worst case is 10 s.
  - It emits `background_job_failed` if it throws, and `external_deletion_pending` per entity when it ends with rows pending.
  - `wiki.drain()` awaits it (today `drain()` is "a no-op in 'deferred' mode"; it now joins this drain).
  - Hosts turn it off with `WikiOptions.drainExternalDeletionsOnSetup: false`. That option sits beside `vectorRanker`, `deletionHookTimeoutMs` and `forceDeleteIgnoreRankerHook`.
- **`runPendingMaintenance()`.** A new job, `'externalDeletions'`, is added to `MaintenanceJob`.
  - It runs first, for entities taken from the ledger (filtered by `entityIds` when given), so fully pruned and wiped entities are included.
  - It honors `deadlineMs`, doesn't draw from `tokenBudget`, and ignores backoff.
  - When `jobs` is given, it runs only if listed.
  - The result gains `externalDeletions: { confirmed: number; pending: number }`.
- **Heal (G5), re-ingest (G6), replace-mode import (G7).** The post-commit `null` loops are replaced by an awaited drain of the ids that call deleted, under the timeout. A rejection still emits `hook_failed` for that id. The removal stays owed. These paths never throw for it.
- **`upsertGraph` (G9).**
  - The trigger enqueues inside the host's transaction, and the enqueue rolls back with it.
  - `syncSearchIndex(entityId?)`, which the host already calls after the commit, drains the entity's pending rows (non-throwing, backoff ignored).
  - The JSDoc says the host's transaction must be opened through the adapter given to `createWiki`.
- **Embed after delete (G10), for `remember()` and `supersede()` only.** Reembed is already safe by lock.
  - `updateEmbeddingBlob` gains `AND deleted_at IS NULL` and returns the change count. On 0 changes `embedFact` skips the hook.
  - After the vector call settles, resolved or rejected, one statement runs: `INSERT OR REPLACE … SELECT … WHERE NOT EXISTS (SELECT 1 FROM {p}entries WHERE id = ? AND deleted_at IS NULL)`. A missing row counts as not live.
  - Then an awaited drain of that id. So the last call the host sees for a deleted id is `null`.
- **`forceDeleteIgnoreRankerHook` scope (behavior change, called out).**
  - Today heal, ingest and import still call the hook when the flag is set, because `notifyEmbeddingPersisted` has no force check. Under this spec, the flag means "the index is decommissioned": no removal calls anywhere, and the ledger is discarded (§5.3).
  - The legacy spec `docs/superpowers/specs/2026-05-07-vectorranker-security-hardening.md` gets an appended Status note.

### 5.8 Locks and concurrency

- `forget` and `runPrune` keep their `JobManager` locks and drain their own ids while holding them, as today. Other drains take no lock.
- The per-id in-flight map prevents duplicate calls within one instance. Two `WikiMemory` instances on one database (SynapseTree) aren't coordinated. The worst case is a duplicate call, which §4.1 covers.

### 5.9 Public API (all additive)

- **`wiki.runExternalDeletions(entityId?: string, opts?: { deadlineMs?: number })`**
  - Returns `Promise<{ confirmed: number; pending: number; failedIds: string[]; timedOut: boolean }>`.
  - No `entityId` means every entity in the ledger. Ignores backoff.
- **`wiki.getPendingExternalDeletions(entityId?: string)`**
  - Returns `Promise<{ count: number; oldestEnqueuedAt: number | null; maxAttempts: number }>`.
- **`class WikiExternalDeletionError extends Error`**
  - `code = 'WIKI_EXTERNAL_DELETION'`.
  - Fields: `entityId`, `unconfirmedIds` (at most 100), `unconfirmedCount`, `timedOut`, and `cause` (sanitized).
  - The message keeps today's prefixes, so existing matchers still work:
    - `forget(<entityId>/<first unconfirmed id>) failed: ANN cleanup hook rejected`;
    - or, when any call timed out, `forget(<entityId>/<id>) failed: <timeout message>`. Timeout takes precedence.
  - The `Invalid deletionHookTimeoutMs` error is thrown as today, before any drain.
- **Diagnostics** (content-free, per entity, `WikiDiagnostic.entityId` set):
  - `external_deletion_pending` with `{ count, oldestEnqueuedAt, maxAttempts }`.
  - `external_deletion_discarded` with `{ count }`.
  - New `WikiDiagnosticOperation` value: `'externalDeletion'`.
  - `WikiDiagnosticDetail` gains `oldestEnqueuedAt?` and `maxAttempts?`.
- **`PendingMaintenance.pendingExternalDeletions?: number`** (optional, so hosts that build the type still compile). `getPendingMaintenance()` lists an entity whose only pending work is removals.
- **`MaintenanceJob`** gains `'externalDeletions'`. `RunPendingMaintenanceResult` gains `externalDeletions`.
- **`WikiOptions.drainExternalDeletionsOnSetup?: boolean`**, default `true`.
- **React.** No new hook. `useWikiForget` surfaces `WikiExternalDeletionError` like any rejection.

### 5.10 Files touched

- **New:** `packages/core/src/repositories/VectorRemovalRepository.ts`, `packages/core/src/services/VectorRemovalService.ts`.
- **Edited:**
  - `db/schema.ts` (table, index, triggers);
  - `repositories/EntryRepository.ts` (`updateEmbeddingBlob` guard and change count; `softDeleteByIds` filter);
  - `services/EmbeddingService.ts` (skip on 0 changes; G10 post-check);
  - `services/MaintenanceService.ts` (forget, prune, heal);
  - `services/IngestionService.ts`, `services/ImportExportService.ts` (drain instead of loops);
  - `services/MaintenanceScheduler.ts` (new job);
  - `services/RememberService.ts`, `services/TemporalService.ts` (awaited G10 drain);
  - `WikiMemory.ts` (wiring, new methods, `setup()` drain, `drain()`, `syncSearchIndex()`, `upsertGraph` JSDoc);
  - `types.ts` (types, error, diagnostics, `VectorRanker` JSDoc);
  - `index.ts` exports.
- **Tests:** new `packages/core/__tests__/vectorRemoval*.test.ts`. Existing tests that assert stop-at-first-failure are updated to the new contract.
- **Docs:**
  - `apps/docs/src/content/docs/guides/deleting-data.md`, `project/security.md`, `reference/*`;
  - `INTENT.md` (rule 7 text, rule 7 Status, Amendments);
  - Status notes in `specs/import-followups/spec.md` §6 and `docs/superpowers/specs/2026-05-07-vectorranker-security-hardening.md`.

### 5.11 Docs and INTENT

- **`guides/deleting-data.md`:**
  - Replace the "Current limits" caution (added in #371) with the §3 guarantee and the §4 list.
  - Document `runExternalDeletions`, `getPendingExternalDeletions`, both diagnostics, `drainExternalDeletionsOnSetup`, `WikiExternalDeletionError` and the force-flag behavior.
- **`VectorRanker` JSDoc** (`types.ts:784-792`) and `project/security.md`: the same guarantee, briefly.
- **`reference/*`:** the new methods, error, option and job, in the existing layout.
- **INTENT rule 7:**
  - The sentence "In deferred mode nothing runs in the background at all; the host decides when and how much." becomes "In deferred mode nothing runs in the background, with one exception that makes no model call: after `setup()` the engine finishes removals from the host's vector index that the host already requested (`drainExternalDeletionsOnSetup`, on by default). The host decides when and how much."
  - Rule 7's Status line records the change.
  - The Amendments section gets a dated 2026-11-11 entry.
- **Status notes (appended, never replacing):** `specs/import-followups/spec.md` §6, and the 2026-05-07 vectorranker-security-hardening spec.

## 6. Owner rulings

1. **Ship in its own spec and PR, after #371.** Ruled 2026-11-11 (accepted).
2. **Finish owed removals in the background after `setup()`, in deferred mode too.** Ruled 2026-11-11: allowed. The guardrails are those in §5.7: no model call, hook configured, not awaited, a 10 s deadline, and an opt-out flag.

## 7. Open questions

- **O1.** Does the Curated Thoughts startup schema check accept the new table, index and two triggers on `entries`? Its Rust check runs before the JS engine creates them, so on the first launch of the new version it also sees a store without them. Does it accept both states? To be answered from the Curated Thoughts side. Until then this PR stays draft.
- **O2.** Is 10 s the right total deadline for the setup drain on mobile?
- **O3.** Should confirmed ledger rows for facts that are never pruned (`pruneRetainSoftDeletedFor: null`) be purged? Proposed: no. The rows are small, and prune removes them with their fact.

## 8. Test plan

**Regression tests** (each must fail before the change and pass after):

1. `forget({ sourceRef })` over 3 ids, with the hook rejecting id 1: ids 2 and 3 are called. `WikiExternalDeletionError.unconfirmedIds` is `[id1]`.
2. A failing id doesn't block prune:
   - prune hard-deletes the confirmed rows and keeps the failing one;
   - event retention and vacuum still run, and `deletedEvents` is set;
   - a `forget` retry doesn't call the confirmed ids again.
3. Hanging hook on 5 ids: one call, `timedOut: true`, 5 pending. The next drain reaches id 2 first (the hung row moved back).
4. `forget({ entryId })` retry after success: no hook call.
5. A legacy soft-deleted id (no ledger row) selected by `forget`: exactly one call, then it resolves.
6. Heal orphan and heal delete with a rejecting hook: the row stays pending, `hook_failed` fires, and the next `runPendingMaintenance` delivers.
7. Heal with a hanging hook resolves within the timeout.
8. Full re-ingest with a rejecting hook: the superseded ids are pending and delivered later.
9. `importDump`:
   - replace mode with a rejecting hook leaves the removals pending;
   - a merge tombstone over a live fact delivers `null`;
   - a replace import of the same ids (a backup restore) leaves no ledger rows and makes no `null` calls.
10. `pruneSupersededAfter`: `null` is delivered at soft-delete time.
11. `upsertGraph`:
    - no hook call inside the host transaction;
    - a rollback leaves no ledger rows;
    - `syncSearchIndex()` after the commit delivers;
    - a stable-id re-upsert of a live fact leaves no ledger row.
12. Embed race:
    - `remember()` with a slow embed and a `forget` during it: the last call for the id is `null`;
    - the same with `forget` followed by `runPrune({ retainSoftDeletedFor: 0 })` while the vector call is in flight: the last call is `null`.
13. A process without the hook:
    - `runPendingMaintenance`, `runExternalDeletions` and `runPrune` leave every pending row unchanged when the marker is set;
    - prune removes the rows when the marker was never set.
14. `forceDeleteIgnoreRankerHook`:
    - pending rows from before the flag was set are discarded with `external_deletion_discarded`;
    - zero calls on every path, heal and ingest included.
15. An invalid `deletionHookTimeoutMs` makes a drain throw before any call, and no `attempts` change.
16. A backlog of 50 pending ids for an entity, then `forget({ entryId })`: forget resolves after exactly one call.

**New-behavior tests** (no "before" state to fail against):

17. Crash recovery. Enqueue through the trigger in a committed transaction on a better-sqlite3 temp file, then open a second `WikiMemory` on that file with a healthy hook. `runExternalDeletions()` calls every id, and pending becomes 0.
18. The setup drain:
    - under the same setup as test 17, every id is delivered after `await wiki.drain()`;
    - with `drainExternalDeletionsOnSetup: false`, no call is made and `external_deletion_pending` fires;
    - the drain stops within the deadline when the hook hangs.
19. `clearAll` on 1,000 facts: one statement enqueues them all (adapter spy).
20. Draining entity A never sends entity B's ids.
21. A re-delete while a confirmation is in flight: the id stays pending (`seq` guard).
22. A fact resurrected before its drain: no `null` call, and its ledger row is gone.
23. Schema: fresh and upgraded stores both have the table, the index and the triggers. `setup({ migrations: 'refuse' })` doesn't throw for them.
24. A background drain while the host holds an open transaction on the same connection stops as transient, with rows untouched and no hook calls.
25. Every drain ends: 300 rows, with the hook rejecting every third, finish in one drain with at most 300 calls.

## 9. Follow-ups (not in this PR)

- An optional batch hook, `onEmbeddingsRemoved({ entityId, factIds })`, for indexes with bulk delete.
