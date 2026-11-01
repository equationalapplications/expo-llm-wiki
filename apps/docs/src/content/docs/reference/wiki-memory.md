---
title: WikiMemory API
description: Every public method on WikiMemory, grouped by task, with signatures and links to the guides.
sidebar:
  order: 1
---

```ts
import { createWiki, WikiMemory } from '@equationalapplications/core-llm-wiki';

const wiki = createWiki(adapter, options);   // ≡ new WikiMemory(adapter, options)
await wiki.setup();                          // await before any other call
```

In Expo, `createWiki` takes an `expo-sqlite` database instead of an adapter.

## Lifecycle

| Method | Returns | Notes |
|---|---|---|
| `setup(opts?: { migrations?: 'allow' \| 'refuse' \| 'auto' })` | `Promise<void>` | Creates tables and runs migrations. Idempotent. [Leases →](/expo-llm-wiki/guides/serverless-hosting/#long-migrations-inside-a-lease) |
| `drain()` | `Promise<void>` | Waits for background jobs in auto mode |
| `clearVectorCache()` | `void` | Frees cached parsed vectors |
| `syncSearchIndex(entityId?)` | `Promise<void>` | Re-syncs the keyword index after `upsertGraph`. With no argument, it also retries a failed FTS5 init. |

## Write

| Method | Returns | Guide |
|---|---|---|
| `write(entityId, { event_type, summary, occurred_at?, related_entry_id? })` | `Promise<void>` | [How it works](/expo-llm-wiki/concepts/how-it-works/) |
| `ingestDocument(entityId, { sourceRef, sourceHash, documentChunk, maxChunkLength?, chunkOverlap?, chunkConcurrency?, promptOverride? }, { onDuplicateHash? }?)` | `Promise<IngestResult>` | [Ingest](/expo-llm-wiki/guides/ingest-documents/) |
| `upsertGraph(entityId, { sourceRef, sourceHash, nodes, edges }, tx)` | `Promise<{ nodesWritten, edgesWritten, superseded }>` | [GraphRAG](/expo-llm-wiki/guides/graphrag/#seed-a-graph-without-an-llm) |
| `supersede(entityId, oldId, { title, body, … }, { validFrom? }?)` | `Promise<{ newId }>` | [Temporal](/expo-llm-wiki/guides/temporal-facts/) |
| `importDump(dump, { merge? }?)` | `Promise<void>` | [OKF](/expo-llm-wiki/guides/okf/) |

## Read

| Method | Returns | Guide |
|---|---|---|
| `read(entityId \| entityId[], query, ReadOptions?)` | `Promise<MemoryBundle>` | [Retrieval](/expo-llm-wiki/concepts/retrieval/) |
| `traverseGraph(entityId, GraphTraversalOptions)` | `Promise<{ nodes, edges }>` | [GraphRAG](/expo-llm-wiki/guides/graphrag/) |
| `history(entityId, factId)` | `Promise<WikiFact[]>` | [Temporal](/expo-llm-wiki/guides/temporal-facts/) |
| `getMemoryBundle(entityId)` | `Promise<MemoryBundle>` | Everything that isn't deleted |
| `exportDump(entityIds?)` | `Promise<MemoryDump>` | [OKF](/expo-llm-wiki/guides/okf/) |
| `getEntitySummary(entityId)` | `Promise<string \| null>` | |

## Change detection & inventory

| Method | Returns |
|---|---|
| `hasChanged(entityId, sourceRef, sourceHash)` | `Promise<boolean>` |
| `hasChanged(entityId, [{ sourceRef, sourceHash }])` | `Promise<{ sourceRef, changed, duplicateOf? }[]>` |
| `pendingSources(entityId, [{ sourceRef, sourceHash }])` | `Promise<{ sourceRef, status: 'new' \| 'changed' \| 'partial' \| 'current' }[]>` |
| `listSourceRefs(entityId)` | `Promise<{ sourceRef, sourceHash, factCount, lastIngestedAt }[]>` |
| `findSourceRefsByHash(entityId, sourceHash)` | `Promise<string[]>` |
| `listEntityIds({ prefix? }?)` | `Promise<string[]>` |

## Maintenance

| Method | Returns | Guide |
|---|---|---|
| `runLibrarian(entityId, { promptOverride? }?)` | `Promise<void>` | [Maintenance](/expo-llm-wiki/guides/maintenance/) |
| `runHeal(entityId, { promptOverride?, batchSize? }?)` | `Promise<HealResult>` | |
| `runReembed(entityId?, { skipExisting?, force? }?)` | `{ embedded, skipped, failed, deferred, permanentlyFailed }` | |
| `runPrune(entityId, { retainSoftDeletedFor?, retainEventsFor?, vacuum? }?)` | `{ entries, tasks, events }` | |
| `runOntologyBackfill(entityId, { batchSize?, promptOverride?, classifier? }?)` | `{ scanned, typed, failedValidation, edgesAdded, remaining, deferred, skipped }` | [Ontologies](/expo-llm-wiki/guides/ontologies/#backfill-untyped-facts) |
| `getPendingMaintenance(entityIds?)` | `PendingMaintenance[]` | [Deferred](/expo-llm-wiki/guides/maintenance/#deferred-maintenance) |
| `runPendingMaintenance({ entityIds?, tokenBudget?, deadlineMs?, jobs? }?)` | `{ perEntity, tokensUsed, estimated, remaining, stoppedReason }` | |
| `getEntityStatus(entityId)` | `{ ingesting, librarian, heal }` | |
| `subscribeEntityStatus(entityId, cb)` | `() => void` (unsubscribe) | |

## Delete

| Method | Returns |
|---|---|
| `forget(entityId, { entryId? \| taskId? \| sourceRef? \| sourceHash? \| clearAll? }, { dryRun? }?)` | `Promise<{ deleted: { entries, tasks } }>` |

## Ontology

| Method | Returns |
|---|---|
| `getOntologyManifest(entityId)` | `Promise<{ mode, manifest } \| null>` |
| `setOntologyManifest(entityId, manifest, { mode? }?)` | `Promise<void>` |
| `setOntologyManifests([{ entityId, manifest, mode? }], { ifAbsent? }?)` | `Promise<{ written, skipped }>` |

## Review, trust & health

| Method | Notes |
|---|---|
| `listDrafts(entityId, { limit?, cursor? }?)` | Returns `{ facts, nextCursor }` |
| `promoteDraft(entryId, entityId, { by })` | Makes the fact `stable`. `by: 'human:*'` gives the human-reviewed trust tier. |
| `setLifecycleStatus(entryId, entityId, 'draft' \| 'stable' \| 'deprecated')` | |
| `writeOkfTrust`, `writeOkfSources`, `setStaleAfter`, `setGeneratedBy` | OKF v0.2 trust and provenance fields. Each has a `…Task` variant. |
| `lint(entityId)` | `{ danglingEdges, manifestViolations, untypedFacts, drafts, unverifiedInferred, sample }` |
| `getInstructions(entityId)` | `{ ingest, librarian, heal, ontologyBackfill }` effective system prompts |

## Outbox

| Method | Notes |
|---|---|
| `getUnprocessedOutboxEvents(limit = 100)` | Requires `enableOutbox: true` |
| `markOutboxEventsProcessed(eventIds)` | Deletes acknowledged events |

Used by [`prisma-outbox`](/expo-llm-wiki/guides/prisma-outbox/), or by your own sync worker.
