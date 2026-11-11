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
| `heal_skipped` | Heal skipped work |
| `grounding_missing` / `grounding_failed` | [Grounding](/expo-llm-wiki/guides/drafts-and-grounding/#grounding) didn't pass |
| `classification_low_confidence` / `classification_invalid` | A classifier backfill answer was rejected |
| `librarian_gate` / `librarian_op_rejected` / `resolve_failed` / `contradicts_document` | Outcomes of the ops librarian |
| `llm_usage` | Token usage per LLM call (requires `config.reportLlmUsage: true`) |
| `read_budget` | How many facts a `tokenBudget` read packed |
| `event_retention_held` | Prune kept events because the librarian hasn't processed them yet |
| `event_created_at_clamped` | `importDump` re-dated future-dated events just after the current time, or after the librarian position if later (`detail.count`) |
| `event_created_at_restamped` | `importDump` re-dated events that would have sorted behind the librarian position or had an unusable `created_at`, or cleared an unusable `occurred_at` (`detail.count`, `detail.reason`) |

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
