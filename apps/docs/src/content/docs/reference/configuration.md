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
| `deletionHookTimeoutMs` | `30000` | Timeout for each deletion hook call |
| `forceDeleteIgnoreRankerHook` | `false` | The index is decommissioned: no removal calls on any path, and owed removals are discarded. Use only then. |
| `drainExternalDeletionsOnSetup` | `false` | `true` makes `setup()` start one background drain of owed removals (no model call, 10 s deadline). Turn it on only if your app never opens its own transactions on the wiki's connection: the drain's transactions make yours throw while one is open. |

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
| `maxTraversalNodes` | `20` | Default traversal cap |
| `minTraversalConfidence` | `'tentative'` | `'certain'`, `'inferred'`, or `'tentative'` |
| `traversalDirection` | `'both'` | `'inbound'`, `'outbound'`, or `'both'` |
| `excludeSourceTypes` | `[]` | Source types skipped in traversal |

## Ingest

| Field | Default | Description |
|---|---|---|
| `maxChunkLength` | `12000` | Characters per chunk |
| `chunkOverlap` | `400` | Characters of overlap |
| `chunkConcurrency` | `1` | Parallel LLM calls per ingest |
| `grounding` | `{ mode: 'off' }` | [Grounding](/expo-llm-wiki/guides/drafts-and-grounding/#grounding) |
| `sourceStore` | `{ maxCharsPerSource: 200_000, maxTotalChars: 5_000_000 }` | Source text store limits in UTF-16 code units ([guide](/expo-llm-wiki/guides/source-store/#limits)). Refusal guards, not targets: exceeding a cap refuses the `storeSource` call — nothing already stored is clipped. Added in 9.2.0 |

## Maintenance

| Field | Default | Description |
|---|---|---|
| `maintenance` | `'deferred'` | `'deferred'` means you call `runPendingMaintenance()` yourself. `'auto'` starts the librarian and heal from `write()` |
| `librarian` | `{ strategy: 'ops' }` | `{ strategy: 'ops' \| 'legacy', gate: { k, dupThreshold, novelThreshold }, guidanceForEntity?: (entityId) => string \| undefined }`. `guidanceForEntity` returns per-entity [host guidance](/expo-llm-wiki/guides/prompts/#host-guidance); a non-empty result overrides `prompts.guidance` for that entity |
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
| `ontology.backfillClassifier` | `'llm'` | `'auto'` uses `llmProvider.classify`. Superseded by `systemOne.typing`, which wins when both are set |
| `ontology.classifyMinConfidence` | `0.5` | Classifier answers below this are left untyped. Superseded by `systemOne.minConfidence.typing` |

## System-One

| Field | Default | Description |
|---|---|---|
| `systemOne.typing` | `'llm'` | Typing mode: `'auto'` uses `llmProvider.classify` (no edges proposed); `'llm'` always uses `generateText`. Wins over `ontology.backfillClassifier` when both are set (a one-time warning names the disagreement) |
| `systemOne.minConfidence.typing` | `0.5` | Minimum classifier confidence to apply a node type. Finite, in [0, 1]. Wins over `ontology.classifyMinConfidence` |
| `systemOne.onLowConfidence` | `'leave'` | `'llm'` escalates classifier low-confidence and abstain outcomes to the generative step of the same pass. A cost/quality setting, not a safety mechanism — it cannot catch a confidently wrong classifier. No-op when typing resolves `'llm'` |

Invalid values for these keys warn once (distinct `[core-llm-wiki] systemOne:` prefix) and are treated as unset.

## Prompts

| Field | Applies to |
|---|---|
| `prompts.ingestSystemPrompt` | `ingestDocument()` |
| `prompts.guidance` | Host guidance appended to ingest, librarian (both strategies), ops extract and `getInstructions`. Never heal or ontology backfill. Max 2,000 UTF-16 code units; no `{{…}}` |
| `prompts.healSystemPrompt` | Heal runs, manual and auto |
| `prompts.ontologyBackfillSystemPrompt` | `runOntologyBackfill()` |

`prompts.librarianSystemPrompt` was removed in 9.0.0; use `prompts.guidance`.

See [Customize prompts](/expo-llm-wiki/guides/prompts/).
