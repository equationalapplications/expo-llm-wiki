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
slow on mobile.

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

### Run and watch the removals

- `forget()` drains its own ids after the commit. If your index didn't confirm every one, it
  throws `WikiExternalDeletionError`. The local delete stays committed and the unconfirmed ids
  stay owed. Retry later, or let a drain below finish them.
- `runPrune()` drains the ids it is about to hard-delete. It keeps rows that aren't confirmed, then
  finishes its other work and throws `PrunePartialFailureError` if rows remain.
- `setup()` starts one background drain of the owed removals when a hook is configured. It makes no
  model call, isn't awaited by `setup()`, uses backoff and stops after 10 s. `wiki.drain()` waits for
  it. Turn it off with `drainExternalDeletionsOnSetup: false` (beside `vectorRanker`); `setup()` then
  only emits `external_deletion_pending`.
- `runPendingMaintenance()` has an `'externalDeletions'` job. It runs first, doesn't use
  `tokenBudget`, and its result carries `externalDeletions: { confirmed, pending }`.
- `runExternalDeletions(entityId?, { deadlineMs? })` delivers now, for one entity or all of them. It
  ignores backoff and returns `{ confirmed, pending, failedIds, timedOut }`.
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
(at most 100), `unconfirmedCount`, `timedOut` and a sanitized `cause`.

Two [diagnostics](/expo-llm-wiki/guides/diagnostics/), both with `operation: 'externalDeletion'` and
no fact content:

- `external_deletion_pending`: removals are still owed for the entity. `detail` has `count`,
  `oldestEnqueuedAt` and `maxAttempts`. When a store has never used a hook, it stays quiet.
- `external_deletion_discarded`: owed removals were dropped without a call, because of
  `forceDeleteIgnoreRankerHook`. `detail.count` says how many.

If you loop "while `getPendingMaintenance()` is non-empty, call `runPendingMaintenance()`", bound
the iterations. A hook that always rejects keeps its removals pending, so the loop would not end.

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
