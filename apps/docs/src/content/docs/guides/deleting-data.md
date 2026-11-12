---
title: Deleting data
description: Forget facts, tasks, documents, or whole entities — with dry runs, soft-delete retention, and GDPR-safe external index cleanup.
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

`forget()` is a **soft delete** and is idempotent: calling it again returns zero counts.
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

- `forget()` and `runPrune()` **reject** if the deletion hook fails or times out, so a
  "forgotten" fact can't stay retrievable elsewhere.
- `deletionHookTimeoutMs` (default 30 s) caps how long each hook call can take. A reasonable
  setting is about 5 s for interactive UX and 60 s for background jobs.
- `forceDeleteIgnoreRankerHook` skips hook failures. Use it **only** when the external index has
  been decommissioned for good.

```ts
createWiki(db, { llmProvider, vectorRanker, deletionHookTimeoutMs: 5_000 }); // options beside llmProvider
```

Retry hook failures, or queue them for reconciliation. Don't swallow them.

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
- **The ontology manifest stays.** The wipe leaves the entity's ontology manifest and mode. Under
  `'emergent'`, the manifest holds node and edge types learned from the entity's facts. To reset
  it, write an empty one:
  `await wiki.setOntologyManifest(entityId, { node_types: [], edge_types: [] }, { mode: 'off' })`.
