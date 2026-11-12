---
title: Errors
description: Every typed error class Core LLM Wiki throws, when it is thrown, and what to do about it.
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
| `WikiBusyError` | A conflicting job (librarian, heal, ingest, prune, reembed, import, forget, or ontology backfill) is already running for the entity | `operation`, `entityId` | Retry later. It's usually safe to swallow. |
| `WikiTransactionError` | A driver error escaped a transaction | `cause`, `sqliteErrorCode` | Alert, grouping by `sqliteErrorCode` |
| `PrunePartialFailureError` | A deletion hook failed partway through `runPrune` | `deleted`, `failedAt`, `remaining`, `deletedTasks`, `deletedEvents`, `cause` | Fix the hook, then run prune again |
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
(`add_source_ref_index`) adds a `source_ref_index` table with a unique `(entity_id, source_hash)`
constraint on live rows, so each content hash belongs to at most one `sourceRef` per entity. It
closes a race where two concurrent ingests under different `sourceRef`s could both store the same
content. (One document's facts all share a hash, which is fine. The rule is about `sourceRef`s.)

A database created before that fix may already have a hash held under two or more live
`sourceRef`s. Then `setup()` throws:

```text
Migration v9 (add_source_ref_index) failed: existing live rows have multiple sourceRefs sharing a hash. Found N duplicate (entity_id, source_hash) groups. …
```

The message counts the groups and shows up to five. Nothing is deleted, the backfill doesn't
run, and the schema version doesn't advance, so it's safe to retry. (Under the default
`migrations: 'allow'` policy, `setup()` has already created an empty `source_ref_index`.)

The message names hashes, not `sourceRef`s. List each group's `sourceRef`s with this read-only
query:

```sql
SELECT entity_id, source_hash, GROUP_CONCAT(DISTINCT source_ref) AS source_refs
FROM llm_wiki_entries
WHERE deleted_at IS NULL AND source_hash IS NOT NULL
GROUP BY entity_id, source_hash
HAVING COUNT(DISTINCT source_ref) > 1;
```

Pick the `sourceRef` to keep in each group, forget every other one *within that group*, then run
`setup()` again:

```ts
// once per losing sourceRef in each group; sourceHash scopes the delete to that group
await wiki.forget(entityId, { sourceRef: loser, sourceHash: group.source_hash });
await wiki.setup();
```

`forget()` soft-deletes the rows (and records outbox `DELETE` events when `enableOutbox` is on),
like any other forget. Three cautions:

- Always pass the group's `sourceHash`. Without it, `forget()` removes every live row of that
  `sourceRef` in the entity, across all hashes, so a ref that loses one group but is the keeper
  of another would lose its kept rows too. The error message shows only a 12-character hash
  prefix; take the full `source_hash` from the listing query.
- `forget()` normalizes the `sourceRef` you pass (to letters, digits, `.`, `_`, `-` and space).
  Legacy rows on a pre-v9 store may not be normalized yet, because the normalize pass runs only
  after migrations succeed. If a listed `sourceRef` contains any other character (a `/`, say), it
  may match nothing (`deleted.entries` is `0`) or match a *different* ref. Use the SQL fallback
  below for those rows.
- `GROUP_CONCAT` joins refs with commas, so a legacy ref containing a comma is ambiguous in the
  listing. Check such groups with `SELECT DISTINCT source_ref …` instead.
Before the release that fixed [#316](https://github.com/equationalapplications/expo-llm-wiki/issues/316),
`forget()` worked here only after some `setup()` under `'allow'` had opened the database; it
now works on any open, including one refused under `'refuse'` or `'auto'`.

If you don't have a `WikiMemory` instance, delete each losing `sourceRef`'s live rows directly
instead, once per losing `(entityId, sourceRef, sourceHash)` in each group, then run `setup()`:

```sql
BEGIN;
DELETE FROM llm_wiki_entries
WHERE entity_id = :entityId AND source_ref = :sourceRef AND source_hash = :sourceHash
  AND deleted_at IS NULL;
COMMIT;
```

This hard-deletes the rows and emits no outbox events. The prefix in your database may differ
from `llm_wiki_`, so match the table names in your schema. Either way, the kept `sourceRef` is
untouched and v9's duplicate check passes on the next `setup()`.
