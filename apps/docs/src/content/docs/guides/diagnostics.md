---
title: Diagnostics & observability
description: Receive typed, content-free reports of everything the engine drops or fails on, and route them to your telemetry.
sidebar:
  order: 12
---

Pass `onDiagnostic` (beside `llmProvider`, not inside `config`) to receive a report each time
the engine drops something or a background job fails:

```ts
const wiki = createWiki(db, {
  llmProvider,
  onDiagnostic: (d) => {
    // d.code, d.severity ('info'|'warn'|'error'), d.operation, d.trigger ('call'|'auto'),
    // d.entityId, d.at, d.message, d.detail?
    telemetry.record(d);
  },
});
```

## Guarantees

- **Content-free.** Diagnostics carry IDs, indexes, counts, ontology slugs, and reason slugs.
  They never carry fact text, LLM output, provider error messages, or content hashes, so they're
  safe to send to third-party telemetry.
- **Isolated.** The hook is called synchronously, and a throwing hook never affects the operation.
- **Delivered after commit.** Diagnostics describe work that really happened. Most are delivered
  after the transaction commits, and an operation that throws before it commits delivers none.
  `upsertGraph` runs in your transaction, so ignore its diagnostics if you roll back. Some calls
  deliver diagnostics and then still throw, and those diagnostics are accurate:
  - `importDump` commits each entity separately. If an entity throws, the entities already
    committed have delivered theirs, and so may the entity that threw, if it threw after its own
    commit.
  - Ingest delivers its LLM-pass diagnostics when a duplicate-hash race rolls back its write.
  - `llm_usage` is delivered as each model call returns.
- **Forward-compatible.** New codes are added in minor releases. Ignore codes you don't recognize.

## Codes

| Code | Raised when |
|---|---|
| `ingest_chunk_failed` | A chunk's response couldn't be parsed |
| `fact_rejected` / `task_rejected` | An item in the model output was invalid |
| `fact_deduplicated` | A duplicate fact in one ingest was skipped |
| `edge_dropped` | An edge failed ontology validation or its target wasn't found |
| `embedding_failed` | `embed()` failed for a fact |
| `hook_failed` | A host hook (for example `onEmbeddingPersisted`) failed |
| `background_job_failed` | An auto-run librarian or heal job failed |
| `external_deletion_pending` | Removals are still owed to your vector index (`operation: 'externalDeletion'`; `detail.count`, `detail.oldestEnqueuedAt`, `detail.maxAttempts`). On the first `setup()` with a hook, a count with `maxAttempts: 0` and an old `oldestEnqueuedAt` is usually the backlog from before the store had an index; see [Adding an index to an existing store](/expo-llm-wiki/guides/deleting-data/#adding-an-index-to-an-existing-store). See also [Deleting data](/expo-llm-wiki/guides/deleting-data/#run-and-watch-the-removals) |
| `external_deletion_discarded` | Owed removals were dropped without a call because of `forceDeleteIgnoreRankerHook` (`detail.count`) |
| `heal_skipped` | Heal skipped work |
| `grounding_missing` / `grounding_failed` | [Grounding](/expo-llm-wiki/guides/drafts-and-grounding/#grounding) didn't pass |
| `classification_low_confidence` / `classification_invalid` | A classifier backfill answer was rejected |
| `librarian_gate` / `librarian_op_rejected` / `resolve_failed` / `contradicts_document` | Outcomes of the ops librarian |
| `source_pointer_unresolved` | A stored librarian fact carries no source pointer because the model answer could not yield one |
| `source_pointer_invalid` | A dump import met a malformed source pointer value and stored a null pointer (OKF frontmatter reports malformed pointers differently: check `dropped_pointer_values` on the `parseOkfBundle` result) |
| `llm_usage` | Token usage per LLM call (requires `config.reportLlmUsage: true`) |
| `read_budget` | How many facts a `tokenBudget` read packed |
| `event_retention_held` | Prune kept events because the librarian hasn't processed them yet. To delete them on request, see [Wipe an entity completely](/expo-llm-wiki/guides/deleting-data/#wipe-an-entity-completely) |
| `import_tombstone_skipped` | `importDump` skipped live dump rows whose ids were forgotten locally (forget wins) (`detail.count`) |
| `prune_checkpoint_incomplete` (`warn`) | A prune ran with a partial failure and the post-VACUUM WAL checkpoint was also incomplete; deleted bytes may remain in the WAL |
| `event_created_at_clamped` | `importDump` re-dated future-dated events just after the current time, or after the librarian position if later (`detail.count`) |
| `event_created_at_restamped` | `importDump` re-dated events that would have sorted behind the librarian position or had an unusable `created_at`, or cleared an unusable `occurred_at` (`detail.count`, `detail.reason`) |
| `source_store_source_too_large` | A source document exceeded the per-document size cap and was not stored |
| `source_store_budget_exceeded` | Storing a source document would exceed the store UTF-16 code-unit budget and it was not stored |
| `source_store_hash_mismatch` | A source document text did not match its recorded hash and was not stored |
| `source_store_duplicate_hash` | A source document duplicated the hash of one already stored and was not stored |
| `source_store_text_not_storable` | A source document text could not be stored as given |
| `erase_secure_delete_off` (`error`) | secure_delete could not be confirmed ON on the connection; erasure is unverified and the erase was stopped. See [Deleting data](/expo-llm-wiki/guides/deleting-data/#the-pragma-requirement) |
| `erase_entity_skipped` (`warn`) | Erase skipped an entity because another operation held its prune lock |
| `erase_registry_sweep_skipped` (`info`) | Erase skipped the source_ref_index tombstone sweep because the table does not exist (pre-v9 store) |
| `erase_retired_vtab_undroppable` (`warn`) | A retired FTS table could not be dropped on a runtime without FTS5; its shadow tables were emptied and the name stays listed until an FTS5-capable open drops it |
| `erase_retired_remaining` (`error`) | Erase stopped: retired FTS tables still exist after reclamation; the erase is incomplete |

The five `source_store_*` codes are all `warn`. `storeSource` refusals carry them in the returned
`{ stored: false, diagnostics }` and fire them on the hook with `operation: 'sourceStore'`;
`importDump` fires them with `operation: 'importDump'` for stored sources it skipped — check
`skippedSources` on the [import result](/expo-llm-wiki/guides/source-store/#delete-and-dump).
See [Source text store](/expo-llm-wiki/guides/source-store/).

## A practical router

```ts
onDiagnostic: (d) => {
  if (d.code === 'llm_usage') return meter.record(tenantId, d);
  if (d.severity === 'error') return Sentry.captureMessage(d.message, { extra: d });
  logger[d.severity](d.code, d);
},
```

## Other signals

| Callback | Fires when |
|---|---|
| `onRetrievalFallback(error)` | An embedding attempt failed and `read()` fell back to keyword search |
| `onVectorRankerFallback({ error, policy })` | Your `VectorRanker` rejected and a fallback policy was applied |
| `subscribeEntityStatus` | A job started or finished for an entity |
