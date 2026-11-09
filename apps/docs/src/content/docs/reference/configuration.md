---
title: Configuration
description: Every WikiOptions and WikiConfig field with its default.
sidebar:
  order: 2
---

```ts
createWiki(db, {
  llmProvider,          // required — see "Connect your LLM provider"
  config: { /* WikiConfig, all optional */ },
  // host callbacks & integrations (beside config, NOT inside it):
  onDiagnostic, onRetrievalFallback,
  vectorRanker, vectorRankerFallback, onVectorRankerFallback,
  sanitizeRankerErrors, deletionHookTimeoutMs, forceDeleteIgnoreRankerHook,
});
```

## `WikiOptions`

| Option | Default | Description |
|---|---|---|
| `llmProvider` | **required** | [`LLMProvider`](/expo-llm-wiki/guides/llm-provider/) |
| `config` | `{}` | `WikiConfig`, below |
| `onDiagnostic(d)` | — | [Diagnostics](/expo-llm-wiki/guides/diagnostics/) |
| `onRetrievalFallback(err)` | — | Called when an embedding failed and keyword search was used |
| `vectorRanker` | — | [Pluggable vector search](/expo-llm-wiki/guides/vector-ranker/) |
| `vectorRankerFallback` | `'js-cosine'` | `'js-cosine'`, `'keyword'`, `'empty'`, or `'throw'` |
| `onVectorRankerFallback(info)` | — | |
| `sanitizeRankerErrors` | `true` | Scrub credentials from ranker errors |
| `deletionHookTimeoutMs` | `30000` | Timeout for the per-row deletion hook |
| `forceDeleteIgnoreRankerHook` | `false` | Skips deletion-hook failures. Use only after the index is decommissioned. |

## `WikiConfig`: storage & setup

| Field | Default | Description |
|---|---|---|
| `tablePrefix` | `'llm_wiki_'` | Must match `^[A-Za-z][A-Za-z0-9_]{0,30}_$` |
| `indexStrategy` | `'auto'` | `'fts5'`, `'minisearch'`, or `'auto'`. [Details →](/expo-llm-wiki/concepts/retrieval/#keyword-index-backends) |
| `migrations` | `'allow'` | `'allow'`, `'refuse'`, or `'auto'` |
| `setupBudgetMs` | `1500` | Wall-time budget for each keyword-index work quantum |
| `enableOutbox` | `false` | Write outbox events for [external sync](/expo-llm-wiki/guides/prisma-outbox/) |

## Retrieval

| Field | Default | Description |
|---|---|---|
| `maxResults` | `10` | Facts per read |
| `hybridWeight` | unset | `0` = keyword … `1` = semantic. Unset means pure semantic. |
| `preFilterLimit` | unset | Keyword top-K before cosine scoring |
| `excludeDrafts` | `false` | Default for reads and traversal |
| `maxEmbedChars` | `6000` | Characters sent to `embed()` (hard ceiling 16000) |
| `maxTraversalNodes` | — | Default traversal cap |
| `minTraversalConfidence` | — | `'certain'`, `'inferred'`, or `'tentative'` |
| `traversalDirection` | — | `'inbound'`, `'outbound'`, or `'both'` |
| `excludeSourceTypes` | — | Source types skipped in traversal |

## Ingest

| Field | Default | Description |
|---|---|---|
| `maxChunkLength` | `12000` | Characters per chunk |
| `chunkOverlap` | `400` | Characters of overlap |
| `chunkConcurrency` | `1` | Parallel LLM calls per ingest |
| `grounding` | `{ mode: 'off' }` | [Grounding](/expo-llm-wiki/guides/drafts-and-grounding/#grounding) |

## Maintenance

8.0.0 changes the defaults for `maintenance` to `'deferred'` and `librarian.strategy` to `'ops'`. From 7.18.0, a host that leaves either unset gets one console warning per process. Set both explicitly to keep today's behavior: `maintenance: 'auto'` and `librarian: { strategy: 'legacy' }`.

| Field | Default | Description |
|---|---|---|
| `maintenance` | `'deferred'` | `'deferred'` means you call `runPendingMaintenance()` yourself. `'auto'` starts the librarian and heal from `write()` |
| `librarian` | `{ strategy: 'ops' }` | `{ strategy: 'ops' \| 'legacy', gate: { k, dupThreshold, novelThreshold } }` |
| `autoLibrarianThreshold` | `20` | `'auto'` maintenance only: events before the librarian auto-runs |
| `autoLibrarianTokenThreshold` | — | `'auto'` maintenance only: also triggers on pending text size (about N tokens) |
| `autoHealThreshold` | `100` | `'auto'` maintenance only: events before heal auto-runs. Also the `healDue` rule in `getPendingMaintenance()` |
| `orphanAfterDays` | `30` | Heal flags facts with no source. `null` turns it off. |
| `staleInferredAfterDays` | `60` | Heal downgrades old inferred facts. `null` turns it off. |
| `pruneRetainSoftDeletedFor` | `7` | Days before soft-deleted rows are hard-deleted |
| `pruneEventsAfter` | `30` | Days before events are hard-deleted |
| `pruneSupersededAfter` | `null` | Days after `valid_to` before expired facts are retired |
| `reportLlmUsage` | `false` | Emit `llm_usage` diagnostics |

## Ontology

| Field | Default | Description |
|---|---|---|
| `ontology.mode` | `'off'` | Global default: `'off'`, `'strict'`, or `'emergent'` |
| `ontology.seedManifests` | — | `{ [entityId]: { manifest, mode? } }` |
| `ontology.backfillClassifier` | `'llm'` | `'auto'` uses `llmProvider.classify` |
| `ontology.classifyMinConfidence` | `0.5` | Classifier answers below this are left untyped |

## Prompts

| Field | Applies to |
|---|---|
| `prompts.ingestSystemPrompt` | `ingestDocument()` |
| `prompts.librarianSystemPrompt` | Librarian runs, manual and auto (legacy strategy only) |
| `prompts.healSystemPrompt` | Heal runs, manual and auto |
| `prompts.ontologyBackfillSystemPrompt` | `runOntologyBackfill()` |

See [Customize prompts](/expo-llm-wiki/guides/prompts/).
