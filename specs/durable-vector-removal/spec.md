# Durable removal of forgotten facts from the host's vector index

**Status:** Implemented (PR #372, 2026-11-11; revision 4 implemented 2026-11-12; revision 6 implemented 2026-11-12; revision 7 implemented 2026-11-12; O1 answered and O2, O3 closed 2026-11-12; no open questions remain). Previously draft until open question O1 was answered. Previously Reviewed (2026-11-11: Opus high review, revision 2; owner directed implementation). Previously Draft (2026-11-11).
Revision 2 (2026-11-11), after an Opus (high) review of revision 1:
- The ledger is filled by SQLite triggers, not by call-site edits (§5.2).
- A process without the hook never clears an obligation (§5.3).
- In-call drains send their own ids first (§5.4).
- Timeouts and paging are fixed so one row can't block the rest (§5.4).
- Resurrection removes the obligation (§5.2).
- Prune finishes its other work before it throws (§5.6).
- The INTENT §7 wording is corrected (§5.11).
- The test plan is rewritten (§8).

Revision 3 (2026-11-11), from the Task 2 review: calls in flight are keyed by ledger row (`seq`), not by fact (§5.4); the drain's deadline is an absolute time named `deadlineAt`; a failed write transaction stops the drain as transient; liveness is checked per page (§5.4). From the Task 3 review: forget on a never-set-up store falls back to per-id hook calls (§5.5.5); a hookless store without the marker emits no pending diagnostic (§5.3). From the Task 7 review: removal-only entities are listed only when this process can act; job-list output fields exclude 'externalDeletions'; runPendingMaintenance awaits the setup drain; the setup drain discards under force (§5.7, §5.9). From the final review: upsertGraph removals get their own stash, independent of the search strategy (§5.7); the setup-drain await in runPendingMaintenance is bounded by `deadlineMs` (§5.7); removal-only entities are listed only while some row is outside backoff (§5.9); joiners of an in-flight call confirm a resolved call themselves (§5.4); the forget backstop stays gated to a hook (§5.5).

Revision 4 (2026-11-12), from a Fable (high) review of the PR head `2c3fbbfc`:
- **The setup drain is off by default** (owner ruling 2026-11-12, §6.3). Its background transactions made a host's own transactions on the shared connection throw "cannot start a transaction within a transaction" (§5.7). INTENT rule 7's exception becomes opt-in (§5.11).
- Prune re-reads ledger status inside its delete transaction, and deletes only confirmed ledger rows of facts it removed, so a removal re-owed during prune is never erased (§5.6).
- A drain of every entity pages one entity at a time, so each page read uses the partial index (§5.4).
- A hookless prune of a store with the marker also deletes the confirmed ledger rows of the facts it removes (§5.3).
- The embed-race check moves into `storeFactVector`, so every embed path has it, and runs only after a real vector call (§5.7).
- The "loop until nothing is pending" claim is corrected (§5.9). `runExternalDeletions()` returns `transient` (§5.9).
- From the scoped re-review: five consecutive rejections end only the current entity in a drain of every entity, so a failing entity can't starve the others, while a timeout or the deadline still ends the drain (§5.4). Prune counts, outboxes and keeps exactly the rows its SQL guard let through (§5.6). Import's preserved-blob vector calls get the embed-race check too (§5.7). Ledger reads before the first page return `transient` instead of throwing (§5.4).
- **O1 answered (2026-11-12).** Curated Thoughts' startup guard checks only the column sets of 9 named tables, so the new objects pass in both states (§7). The owner ruled that core is designed for correctness first and consumers adopt it (§6.4).
- **Orphan sweep (2026-11-12).** `setup()` deletes ledger rows whose fact row no longer exists, when nothing can still owe them: every confirmed one, and, on a store without the marker, every one (§5.3). It closes a leak found in the O1 check: a host that hard-deletes `entries` rows itself, bypassing prune (Curated Thoughts' Rust does), left the deleted facts' ids in the ledger forever.
- Not changed: the first `setup()` with a hook still delivers removals enqueued before the marker existed. Discarding them would drop real removals owed by a hookless process that shares the store with a hook process (the MCP server beside an app), which the deletion promise forbids. A hook already must treat an unknown id as success (§4.1). §5.3 records why.

Revision 5 (2026-11-12), from a Sonnet (high) review of the whole PR and CodeRabbit's review:
- **The enqueue trigger deletes, then inserts** (§5.2). An `INSERT … ON CONFLICT DO UPDATE` that soft-deletes a fact overrides the trigger's `OR REPLACE`, so a re-delete of a fact with a confirmed row threw `UNIQUE constraint failed` and rolled back the import or upsert. Reproduced.
- **A third trigger, on hard delete of `entries`, replaces the setup sweep** (§5.2, §5.3). A live fact deleted directly is now owed on a store with the marker. A hard-deleted soft-deleted fact drops the rows nothing can owe. That costs O(1) per delete instead of a full ledger scan at every `setup()`, and it also covers deletes made by an older engine after a downgrade.
- **A confirm whose fact is already gone deletes the row** in the same write (§5.4).
- **The never-set-up fallbacks stop at the first timeout,** and deliverRemovals' fallback is bounded by `deletionHookTimeoutMs` (§5.5.5).
- **If the embed-race check can't record a removal, it calls the hook with `null` directly** and emits `hook_failed` if that fails. It checks liveness with a read first, so a live fact opens no write transaction (§5.7).
- **Smaller fixes:**
  - `runExternalDeletions` and `getPendingExternalDeletions` work on a store whose `setup()` never ran;
  - the drain's final count can't turn a transient result into a throw;
  - `syncSearchIndex` restores its removal stash when the sync fails;
  - prune's outbox and `deletedIds` name only rows actually deleted;
  - import's `null` for an unembedded live fact is skipped under force;
  - docs: serverless "nothing is still running", security summary, `forget` JSDoc.
- **Not changed, two rejections:**
  - Serializing removal calls with import's vector writes. That is the accepted window in §5.4: a resurrect during an in-flight `null` costs recall, not privacy, and `runReembed` restores it.
  - Keying obligations by `(entity_id, fact_id)`. `entries.id` is a global primary key, so the failure needs a hookless prune on a marked store and then another entity reusing the same id. That is too narrow to justify changing the ledger's key and every query.

Revision 6 (2026-11-12), from CodeRabbit's follow-up on revision 5:
- **Prune names deleted rows with `DELETE … RETURNING id`** (§5.6). Revision 5's read-back after the DELETE also reported an id that vanished before the statement ran (a host's own hard delete after prune selected it), and staged an outbox `DELETE` for it. `RETURNING` names exactly the rows the statement removed. The engine already relies on `RETURNING` (`markOrphaned`).
- **When the embed-race record and the direct `null` call both fail, the record is tried once more** (§5.7). The hook wait gives a host's open transaction time to end; a recorded row re-owes a confirmed removal, and the next drain sends it. If that write fails too, nothing durable can hold the obligation, as in the never-set-up fallbacks (§5.5.5): `hook_failed` is the host's signal.
- **The direct `null` call is sent only for a fact known not live** (§5.7). Revision 5 sent it whenever the embed-race check threw, including when the liveness read itself failed, so a live fact could lose its external vector. Now a failed read still runs the guarded write, whose `NOT EXISTS` decides liveness atomically. If that write fails too, liveness is unknown and nothing is sent: a missed removal is reported (console), a wrong removal would not be.
- Docs: the security summary names the two cases that keep no record.
- From a Fable (high) review of `be9a80fd`:
  - **A fact restored after its removal was confirmed is embedded again** (§5.2). `upsertGraph` now sends `null` for a node it drops, but a later `upsertGraph` that re-adds the id restored the row with its old blob, so the reembed job skipped it and the host never got the vector back. The resurrect trigger now clears `embedding_blob` and `embedding` when a confirmed row exists, then drops the row; the reembed job embeds the fact and sends its vector. This covers every restore path, host SQL included, at one embedding call per restored fact. A fact restored before its removal was confirmed keeps its blob.
  - **The direct `null` waits for a pending row** (§5.7). The liveness read sees a host transaction's uncommitted writes, so a delete inside an open host transaction looked committed, the guarded write failed because that transaction was open, and a live fact got `null` when the host rolled back or restored it. A delete in that transaction also wrote a pending row in it, so when the write fails and the fact's row is pending, nothing is sent: a commit leaves the row for the next drain, a rollback leaves the fact live. The direct `null` is now only for a row that is confirmed or missing.
  - **Prune counts as kept only ids still owed** (§5.6). An id its DELETE skipped because the fact was restored, or was already gone with no pending row, is neither deleted nor kept, so `PrunePartialFailureError` no longer names it.

Revision 7 (2026-11-12), from CodeRabbit's review of `6dab60ae`:
- **The resurrect trigger also clears the embedding failure markers** (§5.2). A restored fact that kept `embedding_failed_at`, `embedding_failure_kind` or `embedding_attempts` could be deferred or skipped by the reembed job, so its vector never reached the host. The markers are cleared only with the confirmed-row blob clear; a fact restored before confirmation keeps both.
  - The trigger is built for the columns that exist. On an upgrade, the every-open DDL runs before migrations 3 (`embedding_blob`) and 11 (the markers) add them, and a body naming a missing column would fail every restore, so the trigger leaves out what's missing and those migrations rebuild it. A trigger built for fewer columns, such as revision 6's on a dev store, is replaced at the next `setup()`.
- **A store without the ledger gets the embed-race `null` too** (§5.7). On a store whose `setup()` never ran, `forget` calls the hook directly (§5.5.5), so a vector call in flight could land after its `null`. With no ledger to record into, a fact known not live gets a direct `null` after its vector call; a live one gets nothing.
- Docs: the deleting-data guide names the in-flight window (§5.4) and points to `runReembed(entityId)` to restore recall.
- Not changed, accepted windows:
  - A restore inside an uncommitted host transaction that rolls back while a vector call is in flight. The post-call liveness read sees the restore, so nothing is owed; the rollback brings the confirmed row back and the vector stays in the host's index. Reads on the shared connection can't see transaction boundaries, and the engine has no way to defer the check until the host's transaction ends. Same class as the host-transaction cases in revision 6.
  - A failed `statusFor` read after a failed guarded write still sends the direct `null`. It needs a read to fail right after one succeeded on the same connection. A wrong `null` costs recall that `runReembed` restores; a missed one leaves a deleted fact's vector in the host's index, so the code keeps the privacy side.

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

One table, one index and two triggers (rev 5 adds a third, on hard delete, §5.2), all created in the every-open base DDL (`packages/core/src/db/schema.ts`), so no code path can see them missing (the #316 lesson):

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
  -- Rev 6: a confirmed removal means the host lacks the vector, so clear the
  -- stored one for the reembed job, then drop the row.
  UPDATE {p}entries SET embedding_blob = NULL, embedding = NULL
   WHERE id = NEW.id
     AND EXISTS (SELECT 1 FROM {p}vector_removals WHERE fact_id = NEW.id AND confirmed_at IS NOT NULL);
  DELETE FROM {p}vector_removals WHERE fact_id = NEW.id;
END;
```

- **Coverage.** `ON CONFLICT DO UPDATE` fires UPDATE triggers. So the upsert in `upsertGraph` (G9), tombstones written by `upsertForImport` and `upsert` (G8), and every bulk soft delete enqueue with no code change.
- **Bulk wipes.** A 120,000-row `clearAll` is still one statement from JS; SQLite runs the trigger per row in C.
- **Resurrection after a confirmed removal (rev 6).** The resurrect trigger clears the fact's stored vector when its row is confirmed and drops the row, so the reembed job sends the vector again. Rev 7: it clears the fact's embedding failure markers with it, so the reembed job doesn't defer or skip the fact.
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

- **Hookless prune with the marker (rev 4).** It keeps the pending ledger rows of the facts it hard-deletes, and deletes their confirmed rows in the same transaction. Nothing reads a confirmed row once its fact is gone.
- **Rev 5: the hard-delete trigger replaces this sweep.** It applies the same rule per deleted row, so nothing scans the ledger at `setup()`. The text below is the rule it applies. A hard-deleted *live* fact is owed only on a store with the marker. On a store without one, nothing can owe it, the same as for pending rows of gone facts.
- **Orphan sweep at `setup()` (2026-11-12, superseded by rev 5).** One statement, keyed on `fact_id` store-wide (not the ledger's `entity_id`: a wiped entity is never pruned again, and a host may change `entity_id` in the same update as the soft delete). It deletes rows whose fact row is gone when they are confirmed, under any gate, or when the gate is not `'hook'` and the store has no marker. Pending rows whose fact is gone are kept while a hook could still owe them: under the hook gate a drain delivers and removes them; in a hookless process on a marked store they wait for the hook process. A failure is logged and doesn't fail `setup()`.
- **First hook `setup()` (rev 4, not changed).** Rows enqueued before the marker was first set are delivered, not discarded. They may be removals a hookless process sharing the store owes on behalf of a hook process. For a store that never had an index, they are calls for ids the index never held, which a hook must already treat as success (§4.1). An outside consult (Gemini, 2026-11-12) agreed, and pointed out the cost on a mature store: one call per unpruned soft-deleted fact. `guides/deleting-data.md` ("Adding an index to an existing store") tells hosts to check the count first and batch, or to discard with force when no other process shares the store.
- **No separate "inherited backlog" diagnostic (decided 2026-11-12, after Gemini and Fable consults).** Gemini proposed a one-time `external_deletion_inherited_backlog` at the marker transition. Not added, because:
  - `external_deletion_pending` already fires with the count on that same `setup()`, before any call.
  - The engine can't know the rows are inherited (the reason above), so the name would invite hosts to discard real removals.
  - A one-shot isn't persisted; a crash between the marker write and the emit loses it. The pending diagnostic repeats at every `setup()`.
  - It isn't blocked by API concerns: new diagnostic codes are allowed in minors (`WikiDiagnosticCode` JSDoc).
  - The docs (`guides/diagnostics.md`, `guides/deleting-data.md`) say how to read the first pending count instead. A `firstHookSetup` detail flag was also considered and skipped; it would add little beyond the count.

`notifyEmbeddingPersistedOrThrow` returns early as success when there is no hook or force is set (`EmbeddingService.ts:275-276`). So the drain checks the gate itself, before calling. It never relies on that early return.

### 5.4 Drain

One routine, `drainVectorRemovals(scope, opts)`, in a new `VectorRemovalService`. `scope` is either `{ entityId, ids? }` or `{ all: true }`.

- **No `JobManager` lock.** It reads the ledger and `entries`, and writes only the ledger.
- **Validation.** It validates `deletionHookTimeoutMs` once before draining, and throws the existing `Invalid deletionHookTimeoutMs` error.
- **Per-row in flight.** Each instance keeps a `Map<factId, { seq, promise }>` of calls in flight.
  - A drain that reaches the same `seq` already in flight awaits that promise, raced against its own per-call budget, and doesn't call again.
  - Only the drain that made the call bumps `attempts` on a failure, so one failed call never bumps twice. A resolved call may be confirmed by the owner or a joiner (confirm is idempotent: `WHERE seq = ? AND confirmed_at IS NULL`), so a joiner never reports a delivered id as unconfirmed.
  - If the joiner's budget runs out first, it counts as a timeout for the joiner: it stops without settling. The shared call keeps running.
  - If the in-flight entry has a different `seq` (the fact was re-deleted), the drain awaits it and then makes a fresh call for its own `seq`. A `null` sent before a re-delete never confirms the newer obligation.
  - No per-entity coalescing.
- **Snapshot and keyset paging.**
  - At start, the drain reads `maxSeq`.
  - It pages with `WHERE confirmed_at IS NULL AND seq <= :maxSeq AND (attempts, seq) > (:lastAttempts, :lastSeq) ORDER BY attempts, seq LIMIT 100`. Each row is tried at most once per drain, and every drain ends.
  - For `{ entityId, ids }`, it pages over those ids first (§5.5).
  - For `{ all: true }` under the hook gate, it pages one entity at a time, in `entitiesWithPending()` order (rev 4). The 5-consecutive-rejections stop ends only the current entity there; a timeout and `deadlineAt` still end the whole drain. A failure reading the entity list or `maxSeq` returns `transient: true`. A page read with no entity filter can't use the partial index and scans the whole ledger, which made a 60,000-row drain take 88 s instead of 4.3 s.
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

1. **Backstop, inside its own transaction, when a hook is configured.** (Without a hook there is no index to owe a removal to; under force the drain discards.) For selected ids that have no ledger row (soft-deleted before this release, or by a store that never had the marker), it runs `INSERT OR IGNORE INTO {p}vector_removals … SELECT … WHERE NOT EXISTS (…)`. A retry by a host mid-way through #371's documented recovery therefore still sends every id.
2. **After the commit,** while it still holds its lock, it drains `{ entityId, ids: <this call's selected ids> }`. Only those ids, not the entity's whole backlog. The backlog belongs to the drains in §5.7 and §5.9.
3. **Outcome:**
   - It resolves when every selected id is confirmed, or has no ledger row because it's gone or resurrected.
   - Otherwise it throws `WikiExternalDeletionError` (§5.9). The local delete stays committed, and the unconfirmed ids stay owed.
   - Under the no-hook row of §5.3, it resolves, and the obligations stay recorded.
4. **A retry** sends only ids still unconfirmed (closes G1 and G2).
5. **Store whose `setup()` never ran** (the #316 recovery path): the ledger table doesn't exist yet. With a hook configured, forget falls back to calling the hook per selected id, continuing past failures, and throws `WikiExternalDeletionError` for the ids not confirmed. Nothing is recorded, because there is nowhere to record it; the error tells the host to retry. Rev 5: the loop stops at the first timeout, like a drain; ids not tried count as unconfirmed. The same applies to prune's and deliverRemovals' fallbacks, and deliverRemovals' is bounded by `deletionHookTimeoutMs`.
6. **Outcome message when no cause is known** (an id still pending after a shared in-flight call or a transient stop): `forget(<entityId>/<id>) failed: ANN cleanup not confirmed`.

### 5.6 `runPrune()`

1. **Superseded step (G4).** `softDeleteByIds` fires the trigger, so removal is sent at soft-delete time, not 7 days later. `softDeleteByIds` gains `AND deleted_at IS NULL`, so a repeat never re-stamps `deleted_at`.
2. **Backstop.** Prunable rows with no ledger row get `INSERT OR IGNORE`, when the hook is configured.
3. **Drain** `{ entityId, ids: <prunable ids> }`.
4. **Hard delete.** It hard-deletes the prunable rows the §5.3 table allows, and deletes their ledger rows in the same transaction. An unconfirmed row is never hard-deleted while a hook is configured (closes G3).
   - **Rev 4.** The confirmed/pending split is read inside the delete transaction, not before it. Under the hook gate, the ledger delete is limited in SQL to confirmed rows whose fact is gone. An embed-race check that re-owes a removal while prune runs (§5.7) therefore either lands before the transaction, and the fact is kept, or after it, and the new row is delivered later. Under the guard, `bulkDeletePruned` selects the deletable ids in the transaction first, so `deleted`, `remaining`, `failedAt` and the outbox `DELETE` entries name only the rows actually deleted.
   - **Rev 6.** The ids come from `DELETE … RETURNING id`, not a select before or after it, so a selected row that vanished before the statement is not reported or outboxed. An id the DELETE skipped counts as kept only if its row is still pending.
5. **Then it finishes event retention, vacuum and the final sync**, and only then throws `PrunePartialFailureError` if rows remain.
   - The class and fields stay the same, and `deletedEvents` is filled in.
   - `deleted` counts rows hard-deleted, `remaining` counts rows kept, and `failedAt` names the first unconfirmed id in drain order. Rows are no longer contiguous; the JSDoc says so.
   - `cause`: a timeout takes precedence, otherwise the first rejection, sanitized as today.
6. Ids confirmed at forget time aren't sent again.
7. **Invalid `deletionHookTimeoutMs`.** Under gate 'hook', prune validates it once, before any write, and throws the existing `Invalid deletionHookTimeoutMs: must be a positive finite number` error. Nothing is soft-deleted, hard-deleted or pruned. (Before this spec the error came wrapped in `PrunePartialFailureError`; a misconfiguration now fails before any work.)

### 5.7 Drains outside `forget` and `runPrune`

- **After `setup()` (owner ruling 2026-11-11).** When the hook is configured and the ledger has pending rows, `setup()` starts one `{ all: true }` drain.
  - It isn't awaited, uses backoff, and has a 10 s total deadline. Because of the per-call cap in §5.4, its real worst case is 10 s.
  - It emits `background_job_failed` if it throws, and `external_deletion_pending` per entity when it ends with rows pending.
  - `wiki.drain()` awaits it (today `drain()` is "a no-op in 'deferred' mode"; it now joins this drain). `runPendingMaintenance()` awaits it before its own work, but never longer than the call's `deadlineMs`, so a host that opens, maintains and pushes (serverless) never overruns its deadline. If the deadline cuts the wait short, the drain may still be running; serverless hosts set `drainExternalDeletionsOnSetup: false` (the `'externalDeletions'` job honours `deadlineMs`) or call `drain()` before pushing. A second `setup()` while it runs reuses it.
  - Under `forceDeleteIgnoreRankerHook`, the setup drain still runs: it discards pending rows and clears the marker (§5.3). No hook or model call.
  - Hosts turn it off with `WikiOptions.drainExternalDeletionsOnSetup: false`. That option sits beside `vectorRanker`, `deletionHookTimeoutMs` and `forceDeleteIgnoreRankerHook`.
  - **Rev 4: off by default (owner ruling 2026-11-12).** The drain opens short transactions on the connection the host shares. A transaction the host opens on that connection itself, such as the documented `db.withTransactionAsync(tx => wiki.upsertGraph(…, tx))`, is outside the engine's lock, so its `BEGIN` throws "cannot start a transaction within a transaction" while a drain transaction is open (43 of 300 host transactions in the review's test; 0 with the drain off). The engine can't serialize transactions it doesn't own, and a delay or retry only narrows the window. So the drain runs only when `drainExternalDeletionsOnSetup: true`, which is safe for a host that never opens its own transactions on that connection. Otherwise `setup()` still writes the marker and, when rows are pending under the hook gate, emits `external_deletion_pending`. Owed removals are still delivered by `runPendingMaintenance()`, `runExternalDeletions()`, `forget()` and prune. Under force with the option off, the discard happens at the next drain.
- **`runPendingMaintenance()`.** A new job, `'externalDeletions'`, is added to `MaintenanceJob`.
  - It runs first, for entities taken from the ledger (filtered by `entityIds` when given), so fully pruned and wiped entities are included.
  - It honors `deadlineMs`, doesn't draw from `tokenBudget`, and ignores backoff.
  - When `jobs` is given, it runs only if listed.
  - The result gains `externalDeletions: { confirmed: number; pending: number }`.
- **Heal (G5), re-ingest (G6), replace-mode import (G7).** The post-commit `null` loops are replaced by an awaited drain of the ids that call deleted, under the timeout. A rejection still emits `hook_failed` for that id. The removal stays owed. These paths never throw for it.
- **`upsertGraph` (G9).**
  - The trigger enqueues inside the host's transaction, and the enqueue rolls back with it.
  - `syncSearchIndex(entityId?)`, which the host already calls after the commit, drains only the ids that `upsertGraph` superseded. They are kept in a removal stash of their own, independent of the search index strategy (MiniSearch or FTS5) and of the search stash's cap, (non-throwing, backoff ignored). With no `entityId`, it drains the stashed ids of every entity. It never drains an entity's whole backlog, because hosts call it after every write; the backlog belongs to `runPendingMaintenance`, `runExternalDeletions` and the setup drain.
  - The `syncSearchIndex` JSDoc says it calls the removal hook for those ids and can take up to `deletionHookTimeoutMs` per id when the index is slow.
  - The JSDoc says the host's transaction must be opened through the adapter given to `createWiki`.
- **Embed after delete (G10), for `remember()` and `supersede()` only.** Reembed is already safe by lock.
  - `updateEmbeddingBlob` gains `AND deleted_at IS NULL` and returns the change count. On 0 changes `embedFact` skips the hook.
  - After the vector call settles, resolved or rejected, one statement runs: `INSERT OR REPLACE … SELECT … WHERE NOT EXISTS (SELECT 1 FROM {p}entries WHERE id = ? AND deleted_at IS NULL)`. A missing row counts as not live.
  - Then an awaited drain of that id. So the last call the host sees for a deleted id is `null`.
  - **Rev 4.** The check runs in `EmbeddingService.storeFactVector`, after the vector call, so every path that sends a vector has it: remember, supersede, ingest, librarian (both strategies), heal, reembed and import. Import's preserved-blob loop calls the hook directly and runs the same check (`settleAfterVectorCall`) itself. It runs only when a vector call was actually made (the blob was stored and the hook is configured). An embed that ended as `fact_deleted` or failed before the call no longer re-owes a removal already confirmed.
  - **Rev 6.** If the record fails and the direct `null` call fails too, the record is tried once more after the call. A recorded row (even over a confirmed one) is owed again and delivered by the next drain.
  - **Rev 6.** `null` is sent directly only when a successful read showed the fact not live and its row is confirmed or missing. A pending row is left for the next drain. If the read fails, the guarded write runs anyway; if it fails too, nothing is sent.
  - **Rev 7.** On a store without the ledger (`setup()` never ran), a fact a successful read shows not live gets `null` directly after its vector call.
- **`forceDeleteIgnoreRankerHook` scope (behavior change, called out).**
  - Today heal, ingest and import still call the hook when the flag is set, because `notifyEmbeddingPersisted` has no force check. Under this spec, the flag means "the index is decommissioned": no removal calls anywhere, and the ledger is discarded (§5.3).
  - The legacy spec `docs/superpowers/specs/2026-05-07-vectorranker-security-hardening.md` gets an appended Status note.

### 5.8 Locks and concurrency

- `forget` and `runPrune` keep their `JobManager` locks and drain their own ids while holding them, as today. Other drains take no lock.
- The per-id in-flight map prevents duplicate calls within one instance. Two `WikiMemory` instances on one database (SynapseTree) aren't coordinated. The worst case is a duplicate call, which §4.1 covers.

### 5.9 Public API (all additive)

- **`wiki.runExternalDeletions(entityId?: string, opts?: { deadlineMs?: number })`**
  - Returns `Promise<{ confirmed: number; pending: number; failedIds: string[]; timedOut: boolean; transient?: boolean }>`. `transient: true` (rev 4) means a page read or settling write failed, for example because the host held a transaction open on the connection; the rows stay pending.
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
- **`PendingMaintenance.pendingExternalDeletions?: number`** (optional, so hosts that build the type still compile). `getPendingMaintenance()` lists an entity whose only pending work is removals, **only when this process can act on them** (gate 'hook' or 'force'). A hookless process never lists removal-only entities, and a removal-only entity is listed only while at least one of its rows is outside backoff (`last_attempt_at` older than `min(2^attempts, 3600)` s, or never attempted). So the documented "loop until nothing is pending" host code ends after one failed pass even when the hook keeps rejecting.
  - **Rev 4 correction.** That holds only for an entity with at most 5 failing rows. A pass stops after 5 consecutive rejections or one timeout, so rows it never tried stay outside backoff and the entity stays listed: 23 always-rejected rows took 5 passes. With a large backlog, early rows can leave backoff before the sweep ends. The docs tell hosts to bound such a loop and make no termination claim.
- **`MaintenanceJob`** gains `'externalDeletions'` (an input to `jobs`). Output fields that list jobs that hit a lock or a missing search index (`EntityMaintenanceReport.busy`, `.searchUnavailable`) use `Exclude<MaintenanceJob, 'externalDeletions'>`, so hosts that switch over them exhaustively keep compiling. `RunPendingMaintenanceResult` gains `externalDeletions`.
- **`WikiOptions.drainExternalDeletionsOnSetup?: boolean`**, default `true`. Rev 4: default `false` (§5.7).
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
  - Rev 4: the exception is opt-in. The sentence reads "…after `setup()` the engine finishes removals from the host's vector index that the host already requested, when the host turns on `drainExternalDeletionsOnSetup` (off by default)…", and the Amendments section gets a dated 2026-11-12 entry.
  - Rule 7's Status line records the change.
  - The Amendments section gets a dated 2026-11-11 entry.
- **Status notes (appended, never replacing):** `specs/import-followups/spec.md` §6, and the 2026-05-07 vectorranker-security-hardening spec.

## 6. Owner rulings

1. **Ship in its own spec and PR, after #371.** Ruled 2026-11-11 (accepted).
2. **Finish owed removals in the background after `setup()`, in deferred mode too.** Ruled 2026-11-11: allowed. The guardrails are those in §5.7: no model call, hook configured, not awaited, a 10 s deadline, and an opt-out flag.
3. **The setup drain is off by default.** Ruled 2026-11-12, after the rev 4 review showed its transactions collide with the host's own (§5.7). It partly reverses ruling 2: the drain stays available as an opt-in.
4. **Core first; consumers adopt.** Ruled 2026-11-12: core is designed to work as well as it can. If a change breaks Curated Thoughts or another consumer, that consumer is updated to the new pattern; core is not weakened to fit it. O1 therefore lists the consumer follow-ups rather than gating the design.

## 7. Open questions

- **O1.** Does the Curated Thoughts startup schema check accept the new table, index and two triggers on `entries`? Its Rust check runs before the JS engine creates them, so on the first launch of the new version it also sees a store without them. Does it accept both states? To be answered from the Curated Thoughts side. Until then this PR stays draft.
  - **Answered 2026-11-12: yes, in both states.** Evidence: `curated-thoughts` at `3d61117a` (3.11.5), `src-tauri/src/db/schema_guard.rs::verify_llm_wiki_schema`, called at open from `db/connection.rs:952`. For 9 named `llm_wiki_*` tables it checks that each exists and that its `PRAGMA table_info` column set matches exactly. It never lists `sqlite_master` as a whole, never inspects indexes or triggers, and never reads `schema_version` in `llm_wiki_meta`. A run of core 8.0.2's `setup()` and then this branch's on one file adds exactly six objects (the table, `…_pending`, the table's unique autoindex, `sqlite_sequence`, the two triggers) and changes no existing table's columns. No `schema_version` bump is needed. Keeping the ledger out of `entries` was required: a new `entries` column fails that guard.
  - Rev 5 adds a third trigger on `entries` (`AFTER DELETE`). The guard never inspects triggers, so the answer stands.
  - **Consumers checked 2026-11-12.** None configures `vectorRanker.onEmbeddingPersisted`, so none sends removal calls.
    - **Curated Thoughts** (pins 8.0.2): passes the guard. Its Rust code hard-deletes `entries` rows directly (`db/commit.rs`, `db/bundle_apply.rs`, `db/queries.rs`), which the orphan sweep now cleans up after.
    - **clanker** (`^8.0.2`, so it takes minors automatically): prune with a 3-day retention removes ledger rows with their facts.
    - **curated-journal** (pins 8.2.0): prune removes ledger rows with their facts.
    - **SynapseTree** (pins 7.17.1): it opens its own transactions on the shared adapter, including `withTransactionAsync(tx => wiki.upsertGraph(…, tx))`, which is why the setup drain stays off by default (§6.3). It prunes with `retainSoftDeletedFor: null`, so its ledger keeps one row per soft-deleted fact it keeps (O3).
  - Each consumer gets an issue in its own repository for the upgrade.
- **O2.** Is 10 s the right total deadline for the setup drain on mobile?
  - **Closed 2026-11-12 (owner): keep 10 s.** The drain is opt-in, isn't awaited, and leaves undelivered rows owed, so a shorter limit only delays delivery and a longer one buys little on a mobile app that can be suspended. Hosts that want a different bound call `runExternalDeletions(undefined, { deadlineMs })` themselves. No setting added.
- **O3.** Should confirmed ledger rows for facts that are never pruned (`pruneRetainSoftDeletedFor: null`) be purged? Proposed: no. The rows are small, and prune removes them with their fact.
  - **Closed 2026-11-12 (owner): no purge, for confirmed or pending rows of facts that still exist.** Removing a confirmed row of a still-soft-deleted fact makes the next `forget()` retry or prune backstop re-enqueue it, so the index gets a repeat call. Removing a pending row on a hookless store could drop a removal a hook process sharing the store still owes (the reasoning in §5.3 for pre-marker rows). The cost is one small row per fact the store already keeps (SynapseTree's case: pending rows on a hookless store). A host that wants them gone sets a soft-delete retention; prune then removes facts and rows together. Rows whose fact is gone are handled by the setup sweep (§5.3).

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
    - under the same setup as test 17, with `drainExternalDeletionsOnSetup: true` (rev 4: off by default), every id is delivered after `await wiki.drain()`;
    - with `drainExternalDeletionsOnSetup: false`, no call is made and `external_deletion_pending` fires;
    - the drain stops within the deadline when the hook hangs.
19. `clearAll` on 1,000 facts: one statement enqueues them all (adapter spy).
20. Draining entity A never sends entity B's ids.
21. A re-delete while a confirmation is in flight: the id stays pending (`seq` guard).
22. A fact resurrected before its drain: no `null` call, and its ledger row is gone.
23. Schema: fresh and upgraded stores both have the table, the index and the triggers. `setup({ migrations: 'refuse' })` doesn't throw for them.
24. A background drain while the host holds an open transaction on the same connection stops as transient, with rows untouched and no hook calls.
25. Every drain ends: 300 rows, with the hook rejecting every third, finish in one drain with at most 300 calls.

**Rev 4 tests:**

26. A removal re-owed between prune's drain and its delete transaction keeps the fact and its pending row.
27. With the default options, `setup()` with pending rows makes no hook call and emits `external_deletion_pending`. With `drainExternalDeletionsOnSetup: true`, it delivers them.
28. A `{ all: true }` drain reads its pages per entity (adapter spy: every page read has an entity filter).
29. A hookless prune of a marked store deletes the confirmed ledger rows of the pruned facts and keeps the pending ones.
30. A forget during a slow `embed()`, before the vector call: exactly one `null` call, and the row stays confirmed.
31. An ingest embed whose fact is deleted while its vector call is in flight ends with a `null` call.
32. `runExternalDeletions()` returns `transient: true` when the host holds a transaction open.

**Rev 5 tests:**

33. A fact soft-deleted, confirmed, restored, then soft-deleted again through `INSERT … ON CONFLICT DO UPDATE` (and through `importDump` with a tombstone) succeeds, and the fact is pending again.
34. Hard-deleting a live fact on a marked store owes it, and a drain sends `null`. On a store without the marker it leaves no row.
35. Hard-deleting a soft-deleted fact drops its confirmed row. On a store without the marker it drops its pending row too. On a marked store the pending row is kept.
36. A confirm whose fact was hard-deleted meanwhile leaves no row.
37. The never-set-up fallbacks of forget and deliverRemovals stop at the first timeout.
38. When the embed-race enqueue fails, the hook gets `null` directly. Rev 6 (38c): when that call fails too, a retried enqueue re-owes the confirmed row and the next drain sends `null`. Rev 6 (38d): when the liveness read and the write both fail, a live fact gets no `null`. (38e): when only the read fails, the guarded write owes a deleted fact and `null` is delivered.
39. `runExternalDeletions()` and `getPendingExternalDeletions()` on a never-set-up store return zeros.
40. `syncSearchIndex()` that throws keeps its stashed ids for the next call.
41. Under force, importing an unembedded live fact makes no hook call.
42. Rev 6: a prune whose selected row is hard-deleted by the host before the DELETE outboxes only the rows the DELETE removed.
43. Rev 6: a node re-added by `upsertGraph` after its removal was confirmed gets its vector again from the reembed job.
44. Rev 6: a delete inside an open host transaction that is undone sends the live fact no `null`; one that commits is delivered by the next drain (44b).
45. Rev 6: prune does not report a fact restored during its drain as an unconfirmed removal.
46. Rev 7: a restore after a confirmed removal clears the embedding failure markers; one before confirmation keeps them. A store set up before migration 11, and a revision 6 trigger, get the marker clear after `setup()`.
47. Rev 7: on a store without the ledger, a fact deleted during its vector call ends with a `null` call; a live one gets none.

## 9. Follow-ups (not in this PR)

- An optional batch hook, `onEmbeddingsRemoved({ entityId, factIds })`, for indexes with bulk delete.
