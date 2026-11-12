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
- `forget()` and `runPrune()` call the hook with `vector: null` after their delete commits, and
  **reject** if a call fails or times out.
- `deletionHookTimeoutMs` (default 30 s) caps how long each hook call can take. A reasonable
  setting is about 5 s for interactive UX and 60 s for background jobs.
- `forceDeleteIgnoreRankerHook` skips hook failures. Use it **only** when the external index has
  been decommissioned for good.

```ts
createWiki(db, { llmProvider, vectorRanker, deletionHookTimeoutMs: 5_000 }); // options beside llmProvider
```

:::caution[Current limits of external cleanup]
External cleanup is attempted once per call and is not yet durable:

- `forget()` and `runPrune()` stop at the first id whose hook fails. The ids after it are not
  sent until a retry gets past it.
- A retry calls the hook again for ids it already removed. Make your delete idempotent: deleting
  an id that isn't in the index must succeed, or the retry fails at the same id every time.
- Nothing records an unfinished cleanup. If the app is killed after `forget()` commits and before
  the hooks finish, a later `forget()` of the same target is the only way to resend them.
- Heal, re-ingest and `importDump` in replace mode call the hook but only report a failure as
  `hook_failed`; they don't retry. A fact soft-deleted by a merge import, or superseded through
  `upsertGraph`, never reaches the hook.

To recover, retry the same `forget()` until it resolves, then run `runPrune()`. A durable
removal queue that retries until every hook call succeeds is planned.
:::

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
