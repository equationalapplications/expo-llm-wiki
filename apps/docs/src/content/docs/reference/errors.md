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

## Migration v9 fails on existing duplicates

Schema migrations run in `setup()`. They're additive and safe to re-run. Migration v9
(`add_live_hash_unique_index`) adds a unique index on `(entity_id, source_hash)` for live rows. It
closes a race where two concurrent ingests under different `sourceRef`s could both store the same
content.

A database created before that fix may already have such duplicates. Then `setup()` throws:

```text
Migration v9 (add_live_hash_unique_index) failed: existing live rows violate the new UNIQUE index. …
```

The message lists the offending `(entity_id, source_hash)` groups. Nothing is deleted, the index
isn't created, and the schema version doesn't advance, so it's safe to retry. To fix it, keep one
live row per group: soft-delete the others (or re-ingest them under the correct `sourceRef`), then
run `setup()` again.
