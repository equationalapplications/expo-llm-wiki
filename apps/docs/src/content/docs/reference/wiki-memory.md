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
| `remember(entityId, { title, body, tags?, confidence?, source_type?, okf_type?, valid_from? })` | `Promise<WikiFact>` | [Direct fact writes](#remember) |
| `supersede(entityId, oldId, { title, body, … }, { validFrom? }?)` | `Promise<{ newId }>` | [Temporal](/expo-llm-wiki/guides/temporal-facts/) |
| `importDump(dump, { merge? }?)` | `Promise<void>` | [OKF](/expo-llm-wiki/guides/okf/) |

### remember

```ts
const fact = await wiki.remember('user-123', {
  title: 'Prefers merge commits',
  body: 'Kurt wants PRs merged with merge commits, never squashed.',
  tags: ['git'],
  okf_type: 'Preference',
  valid_from: Date.parse('2026-03-01'),
});
fact.id; // 'fact_…'
```

Stores one mutable fact in one transaction, with no text-generation (LLM) call, and returns the stored row (`WikiFact`, with timestamps, defaults, `isStale` and `trustTier`). Use it when the host already knows the fact. To replace a fact, use [`supersede()`](/expo-llm-wiki/guides/temporal-facts/) so history is kept.

| Field | Type | Default |
|---|---|---|
| `title` | `string`, required, non-empty after trim | |
| `body` | `string`, required (`''` allowed) | |
| `tags` | `string[]` | `[]` |
| `confidence` | `'certain' \| 'inferred' \| 'tentative'` | `'certain'` |
| `source_type` | `'user_stated' \| 'user_confirmed'` | `'user_stated'` |
| `okf_type` | `string \| null` | `null` |
| `valid_from` | epoch ms, finite and >= 0 | since `created_at` |

- **Validation.** Throws `TypeError` before anything is written. An explicit `null` for `confidence` or `source_type` is rejected; omit the field to take the default. Nothing is clipped; length limits are the host's.
- **`okf_type`.** Follows the `upsertGraph` rule: the manifest's canonical slug when known, `WikiStrictOntologyViolation` under strict mode otherwise, and `null` otherwise.
- **Embedding.** When `llmProvider.embed` is configured it awaits one embedding call; failures surface as `embedding_failed` with `operation: 'remember'`, not a throw. Without `embed` the fact is keyword-only, and `getPendingMaintenance().reembedPending` picks it up once an `embed` exists.
- **No maintenance.** Never starts the librarian or heal and writes no event, in `'auto'` and `'deferred'` mode alike.
- **Not idempotent.** Two identical calls store two facts. Hosts that expose retries own the idempotency key.
- **Transactions.** Opens its own transaction. Do not call it inside `withTransactionAsync`.

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
