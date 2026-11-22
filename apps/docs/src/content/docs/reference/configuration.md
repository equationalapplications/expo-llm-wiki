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
| `systemOne.typing` | `'llm'` | Typing mode: `'auto'` uses `llmProvider.classify` (no edges proposed unless `systemOne.edges: 'auto'`); `'llm'` always uses `generateText`. Wins over `ontology.backfillClassifier` when both are set (a one-time warning names the disagreement) |
| `systemOne.minConfidence.typing` | `0.5` | Minimum classifier confidence to apply a node type. Finite, in [0, 1]. Wins over `ontology.classifyMinConfidence` |
| `systemOne.edges` | `'llm'` | Requires `systemOne.typing: 'auto'`; otherwise inert. Edge-suggestion mode for the ontology backfill: `'auto'` has `llmProvider.classify` screen per-fact edge questions; `'llm'` leaves edges to `generateText`. Under `'auto'` an explicit `systemOne.minConfidence.edges` is required — if it is missing, a one-time warning is logged and edges resolve `'llm'`. Uncertain or invalid edge answers fall through to the generative step |
| `systemOne.minConfidence.edges` | none (required under `edges: 'auto'`) | Confidence floor for classifier edge answers. Finite, in [0.5, 1]; missing or out-of-domain warns once and the site resolves `'llm'`. A confident "yes" (`p > 0.5` and `p ≥ floor`) applies the edge; a confident "no" (`p < 0.5` and `1 − p ≥ floor`) is terminal; anything else, including `p = 0.5`, falls through to the generative step |
| `systemOne.healScreen` | `'llm'` | Heal screen mode: `'auto'` withholds model-directed heal deletes and downgrades whose reported `confidence` is below `systemOne.minConfidence.healScreen`. Both keys are required to engage; without the floor, heal resolves `'llm'` and applies every admitted verdict. No `'off'` mode |
| `systemOne.minConfidence.healScreen` | none (required under `healScreen: 'auto'`) | Confidence floor for heal verdicts. Finite, in [0.5, 1]; no default floor. A verdict with no valid `confidence` is applied and counted as unscreened. A withheld verdict leaves the fact unchanged and emits a `heal_deleted` / `heal_downgraded` receipt with reason `'below_floor'` |
| `systemOne.onLowConfidence` | `'leave'` | `'llm'` escalates classifier low-confidence and abstain outcomes to the generative step of the same pass. A cost/quality setting, not a safety mechanism — it cannot catch a confidently wrong classifier. No-op when typing resolves `'llm'` |

Invalid values for these keys warn once (distinct `[core-llm-wiki] systemOne:` prefix) and are treated as unset.

### Heal clocks and auditability

Heal's moves are auditable only while your retention clocks keep the evidence. These are the knobs a host sets:

- `orphanAfterDays`: unset means 30 days (not disabled); `null` disables the orphan pass.
- `staleInferredAfterDays`: unset means 60 days (not disabled); `null` disables the stale-inferred pass.
- `pruneEventsAfter` and `pruneRetainSoftDeletedFor`: how long event rows and soft-deleted rows survive. Heal receipts (`heal_deleted`, `heal_downgraded`) are delivered only through your `onDiagnostic` hook and are not written to the event table, so `pruneEventsAfter` does not affect them — receipt persistence depends on how your host stores diagnostics. Retention itself remains host policy.
- `pruneSupersededAfter`: the superseded-history clock. It defaults to `null`, which keeps history forever.
- `event_retention_held`: the diagnostic emitted when retention holds a write.

Heal may forget when the host runs it (owner ruling, 2026-11-20). Auditability of heal is bounded by your retention clocks and by how your host persists diagnostics: set `pruneEventsAfter` and `pruneRetainSoftDeletedFor` long enough to cover your audit window, or heal's moves forget themselves.

A `prompts.healSystemPrompt` override replaces the default prompt, including its `{ "id", "confidence" }` entry schema. If your override still returns bare id strings, the screen cannot gate those verdicts: they are applied and a one-time warning names `healSystemPrompt`.

Withheld delete plus restatement: if heal deletes a fact and restates it in `newFacts`, and the delete is withheld as `'below_floor'`, the fact stays live and the restatement may be skipped as a duplicate (`fact_deduplicated`) — the fuzzy dedupe runs only when both titles carry enough tokens to qualify, so a short-titled fact's restatement is not checked against it. When the dedupe does fire, the correction is dropped; the `'below_floor'` receipt plus the dedupe diagnostic make that auditable.

## Prompts

| Field | Applies to |
|---|---|
| `prompts.ingestSystemPrompt` | `ingestDocument()` |
| `prompts.guidance` | Host guidance appended to ingest, librarian (both strategies), ops extract and `getInstructions`. Never heal or ontology backfill. Max 2,000 UTF-16 code units; no `{{…}}` |
| `prompts.healSystemPrompt` | Heal runs, manual and auto |
| `prompts.ontologyBackfillSystemPrompt` | `runOntologyBackfill()` |

`prompts.librarianSystemPrompt` was removed in 9.0.0; use `prompts.guidance`.

See [Customize prompts](/expo-llm-wiki/guides/prompts/).
