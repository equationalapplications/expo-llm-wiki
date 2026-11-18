---
title: Deleting data
description: Forget facts, tasks, documents, or whole entities — with dry runs, soft-delete retention, and external index cleanup.
sidebar:
  order: 16
---

## Forget

```ts
await wiki.forget('user-123', { entryId: 'fact_abc' });     // one fact
await wiki.forget('user-123', { taskId: 'task_xyz' });      // one task
await wiki.forget('user-123', { sourceRef: 'doc.md' });     // every fact from one document
// → { deleted: { entries, tasks } }
await wiki.forget('user-123', { clearAll: true });          // the whole entity
// → { deleted: { entries, tasks }, metadataReset: true }
```

`clearAll` soft-deletes every fact and task, deletes the entity's graph edges, and removes the
entity summary. It keeps the entity's events unless you add `includeEvents: true` (below).

Preview it first:

```ts
const preview = await wiki.forget('user-123', { sourceRef: 'doc.md' }, { dryRun: true });
// no writes; same result shape
```

`forget()` **soft-deletes** facts and tasks and is idempotent: calling it again returns zero counts.
(`clearAll` hard-deletes edges and, with `includeEvents`, events; there is nothing to soft-delete there.)
Forgotten facts disappear from reads immediately.

## Hard delete: prune

Soft-deleted rows stay on disk until `runPrune()` removes them after the retention window
(`pruneRetainSoftDeletedFor`, 7 days by default):

```ts
await wiki.runPrune('user-123', { retainSoftDeletedFor: 0, vacuum: true });
```

`vacuum: true` rewrites the database file so the freed pages are actually released. It can be
slow on mobile. With `vacuum: true`, an incomplete post-VACUUM checkpoint throws
`CheckpointIncompleteError` after the deletes land; persistent reader connections make this
routine.

## Erase: verified erasure

`forget()` removes facts from recall, and `runPrune()` removes the rows from the table. Neither
guarantees the bytes are gone from the database *file* — SQLite marks freed pages for reuse
without overwriting them, so deleted text can linger until the pages happen to be reused.
`erase()` closes that gap. On the connection it runs on, deleted content left in the database
*file* is overwritten with zeros (`secure_delete` is verified `ON` before any step), and after a
successful final checkpoint the WAL is truncated to zero bytes. Each step's outcome is verified
from the pragma state, the checkpoint result and the step's own completion, and the erasure
report names each step's outcome, skipped entities and holds, and whether erasure is verified.
What this guarantee does **not** cover: storage-level remnants outside the database file and its
WAL — unlinked rollback journals, `VACUUM` temporary copies on disk, filesystem snapshots and
backups. Nothing in this document claims the bytes are unrecoverable at the storage layer.

```ts
await wiki.forget('user-123', { entryId: 'fact_abc' });
await wiki.erase();
```

A failed erase throws `EraseStepError` carrying the report with `verified: false`; it, the `EraseReport` type and `CheckpointIncompleteError` are importable from the package. A hold (an external removal that could not be confirmed) also leaves `verified: false`. Failures *before* the pipeline starts — `erase()` refusing because another operation holds a conflicting lock — throw a plain `WikiBusyError` with no report.

That is the whole recipe. **Do not add a standalone `runPrune()` step.** `erase()`'s first step
already prunes the facts it is about to erase with `retainSoftDeletedFor: 0` and
`retainEventsFor: null` — so erase keeps every event. A standalone prune with default options
would delete events older than 30 days first, contradicting that.

### Erasure happens at erase time, not forget time

`forget()` is an instruction, not destruction: the fact leaves recall immediately, but the
guaranteed erasure is what `erase()` delivers. One consequence of the timing: facts that
step-1 prune *soft-deletes during this erase* (for example, rows caught by
`pruneSupersededAfter`) are hard-deleted at your **next** `erase()`, not this one — and only
for entities that erase enumerated. Run erase again if you need those rows gone in the same
session.

### Stored source documents survive erase

Documents you stored with `storeSource()` are your property, not the engine's: `erase()` never
touches them. Their erasure path is `forget({ sourceRef })`, which hard-deletes the stored text
(and its passages) at forget time. On an erasure request, call
`forget({ sourceRef })` for every stored document of the subject — see
[Handling an erasure request](#handling-an-erasure-request) below.

### The pragma requirement

`erase()` verifies erasure with SQLite's `secure_delete` pragma, which makes SQLite overwrite
deleted content with zeros. The engine sets `PRAGMA secure_delete=ON` when it opens the
database and reads it back to confirm — but the pragma is **per-connection**: if your app opens
its own connection and writes to the wiki tables with raw SQL, that connection must set the
pragma itself. `erase()` checks the pragma of its own connection before it starts; if
`secure_delete` is off there, erasure fails with an `erase_secure_delete_off` diagnostic and is
marked unverified — never a false success.

When FTS5 init fails on an open and the engine falls back to its unavailable-strategy mode
(FTS tables still present), `erase()` refuses (unverified) until the pending FTS ledgers
(`fts_pending` and `source_passages_fts_pending`) are empty, because text the engine could not
drain from the full-text index cannot be claimed erased.

On runtimes without the FTS5 module, or with `indexStrategy: 'minisearch'`, a store that earlier
ran FTS5 keeps orphaned full-text tables. `erase()` clears them itself, lists every cleared table
in `report.ftsOrphansCleared`, and completes verified. If it cannot, the step fails honestly with
`erase_fts_orphan_probe_failed` (the orphan probe errored), `erase_fts_orphan_clear` (a clear
failed), or `erase_fts_index_unavailable` (the index is unavailable, so the tables are left
untouched).

Full zeroing is `secure_delete=ON`, and the engine keeps it on unconditionally: there is no
opt-out.

### Copy census: what erase does and doesn't reach

`erase()` zeroes the store file (and its WAL/journal surfaces). In WAL mode the WAL is
checkpointed and the zeroed surfaces are covered; in rollback-journal mode the journal is
unlinked rather than zeroed. These copies are yours to handle:

1. **Events.** Erase deletes none of them — events follow the host's `retainEventsFor`
   setting. Each host publishes its own value; the engine doesn't pick one for you. If you need
   events gone, that's `clearAll({ includeEvents: true })` (see
   [Wipe an entity completely](#wipe-an-entity-completely)).
2. **The outbox.** With `enableOutbox: true`, unacknowledged outbox rows still hold fact text.
   Drain the outbox before erasing.
3. **Stored source documents.** They survive erase unless you call `forget({ sourceRef })` per
   document.
4. **The ontology manifest.** It stays. Write an empty manifest to reset it (see the wipe
   section below).
5. **Exports.** Dump files live outside the store; erasing doesn't touch them, and re-importing
   an export brings the data back. Erase the exported files themselves if the request covers
   them.

### The VACUUM residue window

`erase()` runs `VACUUM` as part of its recipe, and VACUUM builds its temporary copy of the
database *outside* the main file while it works — a short window where content pages exist in a
temp file. The host can close it: run the erase call on a connection with
`PRAGMA temp_store=MEMORY`, so the temporary copy lives in RAM instead of on disk. This is
build-dependent, not a hard guarantee: a SQLite build compiled with `SQLITE_TEMP_STORE=0`
overrides the connection setting and keeps the temporary copy on disk. Treat the pragma as
advice that removes the window on stock builds, not as a safeguard every build honors.

### Handling an erasure request

When a subject asks you to erase their data (a GDPR Art. 17 request), the sequence is:

1. **Stop writes to the subject's entities.** Quiesce the whole store, not just the subject's
   entities: erase refuses while any maintenance op or ingest is active store-wide, and step 5
   needs store-wide write quiescence.
2. **Deal with the subject's retained events.** This is a prerequisite, not a convenience
   follow-up: events follow your `retainEventsFor` value, and `erase()` deletes none of them, so a
   host claiming erasure must first remove the event rows it keeps. `forget()` has no per-event
   selector; the way to delete an entity's events on request is
   `clearAll({ includeEvents: true })` (see [Wipe an entity completely](#wipe-an-entity-completely)).
3. **`forget({ sourceRef })` for every stored document of the subject** (see
   [the source store guide](/expo-llm-wiki/guides/source-store/)).
4. **Drain the outbox** and handle your exports (copy census above).
5. **`forget()` the facts, then `erase()`** — no standalone prune step.

Check the erasure report's verified flag before you confirm anything to the subject, and see
[the diagnostics guide](/expo-llm-wiki/guides/diagnostics/) for the `erase_*` codes. For the
vocabulary — forget, prune, erase, expire and the fact states — see
[the Glossary](/expo-llm-wiki/reference/glossary/).

## Right to be forgotten (GDPR)

If you use an external vector index through `VectorRanker.onEmbeddingPersisted`, deletion has
to reach that index too:

- `read()` never returns a forgotten fact, whatever your index holds: ranker hits are checked
  against live rows. What the hook controls is whether the vector stays in *your* index.
- When a delete commits, the engine records every affected fact id in the same transaction. It keeps
  calling `onEmbeddingPersisted({ entityId, factId, vector: null })` until your hook resolves once for
  that id. That holds across retries, restarts and crashes. It doesn't send a confirmed id again.
- One failing id doesn't block the others. `runPrune()` never hard-deletes a fact whose removal is
  unconfirmed while a hook is configured.
- `deletionHookTimeoutMs` (default 30 s) caps how long each hook call can take. A reasonable
  setting is about 5 s for interactive UX and 60 s for background jobs.

```ts
createWiki(db, { llmProvider, vectorRanker, deletionHookTimeoutMs: 5_000 }); // options beside llmProvider
```

### What stays with you

The engine can't do these for you:

1. **Your hook must tolerate a repeat, and must not resolve without removing.** Delivery is at
   least once. A crash between your hook resolving and the engine recording it means one repeat.
   So does a timed-out call that is still running when a later drain resends it. The engine can't
   tell "already gone" from a real failure, so a hook that throws on "not found" keeps that id
   pending. Make deleting a missing id succeed.
2. **The app has to run again.** An uninstalled or never-reopened app can't call a remote index.
   A hard deadline needs a server-side delete.
3. **Every process that drains uses the same hook.** A process without the hook leaves owed
   removals untouched, so they wait for one that has it.
4. **Copies your hook doesn't reach** stay: index backups, outbox consumers (`enableOutbox`) and
   your other systems.
5. **Deadlines.** The engine delivers eventually while the app runs. You monitor the pending count.

### A restored fact is embedded again

When a fact whose removal your index already confirmed comes back (`upsertGraph` re-adds a node,
an import brings back a live version, or your own SQL sets `deleted_at` back to `NULL`), the engine
clears its stored vector. The reembed job (`runPendingMaintenance()` or `runReembed()`) then embeds
it and sends the vector to your hook again, and any embedding failure recorded for it is cleared
so the job doesn't skip it. That costs one embedding call per restored fact. A fact restored
before its removal was confirmed keeps its vector, because your index was never told to drop it.

One window remains: if the removal call is already in flight when the fact comes back, your index
can drop the vector while the store keeps its copy, so the reembed job won't send it again. That
costs recall, not privacy. When recall matters, run `runReembed(entityId)` after a restore: it
embeds every fact of that entity again (one embedding call each) and sends each vector to your hook.

### Run and watch the removals

- `forget()` drains its own ids after the commit. If your index didn't confirm every one, it
  throws `WikiExternalDeletionError`. The local delete stays committed and the unconfirmed ids
  stay owed. Retry later, or let a drain below finish them.
- `runPrune()` drains the ids it is about to hard-delete. It keeps rows that aren't confirmed, then
  finishes its other work and throws `PrunePartialFailureError` if rows remain.
- By default `setup()` makes no removal call. When a hook is configured and removals are owed, it
  emits `external_deletion_pending`. `runPendingMaintenance()` and `runExternalDeletions()` deliver
  them; `forget()` and `runPrune()` deliver only the ids they touch. Under
  `forceDeleteIgnoreRankerHook` with the drain off, owed rows and the store's "external index in use"
  record stay until the next of these calls discards them.
- `drainExternalDeletionsOnSetup: true` (beside `vectorRanker`) makes `setup()` start one background
  drain of the owed removals, or, under `forceDeleteIgnoreRankerHook`, discard them. It makes no
  model call, isn't awaited by `setup()`, uses backoff and stops after 10 s. `wiki.drain()` waits for
  it. Turn it on **only if your app never opens its own transactions** on the connection you gave
  `createWiki`, such as `db.withTransactionAsync(tx => wiki.upsertGraph(…, tx))`. The drain's short
  transactions use that connection too, and your `BEGIN` throws "cannot start a transaction within a
  transaction" while one of them is open.
- `runPendingMaintenance()` has an `'externalDeletions'` job. It runs first, doesn't use
  `tokenBudget`, and its result carries `externalDeletions: { confirmed, pending }`.
- `runExternalDeletions(entityId?, { deadlineMs? })` delivers now, for one entity or all of them. It
  ignores backoff and returns `{ confirmed, pending, failedIds, timedOut }`, plus `transient: true`
  when it couldn't read or write the ledger (for example, you held a transaction open). Those rows
  stay pending.
- `getPendingExternalDeletions(entityId?)` returns `{ count, oldestEnqueuedAt, maxAttempts }`
  without calling your hook.

```ts
const owed = await wiki.getPendingExternalDeletions('user-123');
if (owed.count > 0) {
  const r = await wiki.runExternalDeletions('user-123', { deadlineMs: 10_000 });
  // r.pending > 0 means your hook still hasn't removed some ids.
}

try {
  await wiki.forget('user-123', { sourceRef: 'doc.md' });
} catch (err) {
  if (err instanceof WikiExternalDeletionError) {
    err.unconfirmedIds;   // at most 100
    err.unconfirmedCount; // the full count
    err.timedOut;
  }
}
```

`WikiExternalDeletionError` has `code = 'WIKI_EXTERNAL_DELETION'`, `entityId`, `unconfirmedIds`
(at most 100), `unconfirmedCount`, `timedOut` and `cause`. `cause` is sanitized, and absent on a timeout or when no cause is known.

Two [diagnostics](/expo-llm-wiki/guides/diagnostics/), both with `operation: 'externalDeletion'` and
no fact content:

- `external_deletion_pending`: removals are still owed for the entity. `detail` has `count`,
  `oldestEnqueuedAt` and `maxAttempts`. When a store has never used a hook, it stays quiet.
- `external_deletion_discarded`: owed removals were dropped without a call, because of
  `forceDeleteIgnoreRankerHook`. `detail.count` says how many.

If you loop "while `getPendingMaintenance()` is non-empty, call `runPendingMaintenance()`", bound
the iterations. Each pass stops delivering after 5 rejections in a row or one timeout, so a hook that
keeps failing can keep an entity listed for several passes, and with a large backlog for much
longer.

### If your app writes to the wiki tables itself

The removal record is kept by SQLite triggers on the entries table, so deletes your own SQL makes
are recorded too:

- A soft delete (`UPDATE … SET deleted_at`) is owed like any other.
- A hard delete of a live fact (`DELETE FROM … entries` without a soft delete first) is owed on a
  store that has used a removal hook, and ignored on one that never has.
- A hard delete of a soft-deleted fact drops the records nothing can still owe: confirmed ones
  always, and all of them on a store that has never had a removal hook.

 Don't drop the `llm_wiki_vector_removals` table (your `tablePrefix` + `vector_removals`) while its triggers
exist: every soft delete then fails with `no such table` until the next `setup()` recreates it.

### Adding an index to an existing store

The engine records every delete, with or without a hook, and it can't tell a delete made before
your store had an index from one another process owes your index. For example, a server without a
hook may share the store with your app. So the first time you configure a hook, every soft-deleted
fact that prune hasn't removed yet is owed a `null` call, including ids your new index never held.
Your hook must treat an unknown id as success.

That first `setup()` emits `external_deletion_pending` with the count, before any call is made. A
count with `maxAttempts: 0` and an old `oldestEnqueuedAt` is this backlog. The engine sends no
separate "inherited" signal, because it can't tell these rows apart from removals another process
owes.

On a store with many soft-deleted facts, that's a burst of calls to your index provider. Check
`getPendingExternalDeletions()` before you turn the hook on. If the count is large, deliver them with
`runExternalDeletions(undefined, { deadlineMs })` in bounded batches, or have your hook batch its
requests. If you're sure nothing else ever wrote to an index from this store, you can discard them
first by opening it once with `forceDeleteIgnoreRankerHook: true` and calling
`runExternalDeletions()`. Don't do that if any other process with a hook shares the store: its owed
removals would be dropped too.

### `forceDeleteIgnoreRankerHook`

Set it **only** when the external index is decommissioned for good. It means: make no removal calls
anywhere (forget, prune, heal, ingest, import), and discard the owed removals. A drain with this
flag clears the record that the store used an external index, and emits
`external_deletion_discarded`.

## Wipe an entity completely

```ts
await wiki.forget(entityId, { clearAll: true, includeEvents: true });
// → { deleted: { entries, tasks, events }, metadataReset: true }
await wiki.runPrune(entityId, { retainSoftDeletedFor: 0, retainEventsFor: 0, vacuum: true });
```

`includeEvents: true` hard-deletes every event of the entity, whether the librarian has read it or
not, and resets the librarian's position. It's allowed only with `clearAll: true`. The prune then
hard-deletes the soft-deleted facts and tasks, and `vacuum` reclaims the space. `dryRun` reports
the event count without deleting anything.

- **Stop writes to the entity first.** An event written after the wipe is a new event.
- **Without `includeEvents`, events stay.** Under the default `'ops'` strategy or `'deferred'`
  maintenance, `runPrune()` keeps events the librarian hasn't read and emits
  `event_retention_held`. A later maintenance run then reads them into facts again. Under
  `'legacy'`, the librarian re-reads the newest events on every pass.
- **Re-importing an old export brings the data back**, events included.
- **Drain the outbox.** With `enableOutbox: true`, outbox rows your worker hasn't acknowledged
  still hold the entity's fact text. They leave the database only through `markOutboxEventsProcessed()`, so
  run your worker (or acknowledge them) before the prune and vacuum.
- **The ontology manifest stays.** The wipe leaves the entity's ontology manifest and mode. Under
  `'emergent'`, the manifest holds node and edge types learned from the entity's facts. To reset
  it, write an empty one:
  `await wiki.setOntologyManifest(entityId, { node_types: [], edge_types: [] }, { mode: 'off' })`.
