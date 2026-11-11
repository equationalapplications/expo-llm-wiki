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
- **Delivered after commit.** An operation that throws delivers no diagnostics, because the
  exception is the signal. `upsertGraph` runs in your transaction, so ignore its diagnostics if
  you roll back.
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
| `event_created_at_clamped` | `importDump` stored future-dated events at the current time (`detail.count`) |

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
