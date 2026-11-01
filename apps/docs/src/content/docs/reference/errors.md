---
title: Errors
description: Every typed error class LLM Wiki throws, when it is thrown, and what to do about it.
sidebar:
  order: 4
---

All errors are exported from the core package (and re-exported by React and Expo), so you can
use `instanceof`:

```ts
import { WikiBusyError } from '@equationalapplications/core-llm-wiki';

try {
  await wiki.runPrune(entityId);
} catch (e) {
  if (e instanceof WikiBusyError) return; // another job is running; retry later
  throw e;
}
```

| Error | Thrown when | Useful fields | What to do |
|---|---|---|---|
| `WikiBusyError` | A conflicting job (librarian, heal, ingest, prune, or reembed) is already running for the entity | `operation`, `entityId` | Retry later. It's usually safe to swallow. |
| `WikiTransactionError` | A driver error escaped a transaction | `cause`, `sqliteErrorCode` | Alert, grouping by `sqliteErrorCode` |
| `WikiIngestEmptyError` | **Every** chunk of an ingest failed | `parseFailures`, `sourceRef`, `chunks` | Check the provider's output format |
| `WikiDuplicateHashError` | The same content is held under another live `sourceRef` | `canonical`, `sourceHash`, `entityId` | Skip, or use `onDuplicateHash: 'skip'` |
| `WikiSourceRefHashCollision` | `upsertGraph` hash collision | `existingSourceRef`, `sourceHash` | Use the existing ref, or change the content |
| `WikiGraphNodeOwnershipConflict` | A node ID belongs to another entity | `code` (no identifiers, by design) | Use entity-qualified IDs |
| `WikiStrictOntologyViolation` | A strict-mode graph write used a type outside the manifest | `kind`, `type`, `entityId` | Fix the data or the manifest |
| `WikiInvalidReadOptions` | `read()` options can't be satisfied (for example, floors that sum to more than `maxResults`) | `field`, `reason` | Fix the options |
| `WikiDraftNotFound` | `promoteDraft` found no live draft with that ID | `code` | Refresh the draft list |
| `WikiSupersedeError` | `supersede()` was refused | `reason` | See [Temporal → Rules](/expo-llm-wiki/guides/temporal-facts/#rules) |
| `WikiMigrationRequiredError` | `setup({ migrations: 'refuse' })` found pending work | `pendingWork` | Run `setup()` outside the lease |
| `WikiSearchUnavailableError` | The keyword index failed to initialize | `cause` | Writes still work. Call `syncSearchIndex()` to retry. |
| `WikiParseError` | The model's output couldn't be parsed | `tier`, `position` | Usually surfaces as `parseFailures` rather than a throw |

Errors you throw from your own callbacks pass through with their type unchanged.
