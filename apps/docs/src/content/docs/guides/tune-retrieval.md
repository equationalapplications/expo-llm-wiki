---
title: Tune retrieval
description: Use maxResults, hybridWeight, preFilterLimit, and tokenBudget to balance quality, latency, and cost.
sidebar:
  order: 4
---

`maxResults`, `hybridWeight` and `preFilterLimit` can be set **globally** in `config`, or **per
call** in `read()` options. A per-call value wins. `tokenBudget` is per call only.

```ts
// Global defaults
createWiki(db, { llmProvider, config: { maxResults: 10, hybridWeight: 0.7, preFilterLimit: 50 } });

// Per call (e.g. from a search-settings screen)
await wiki.read('user-123', 'weekend plans', { maxResults: 5, hybridWeight: 0.5 });
```

## `hybridWeight`: semantic vs keyword

| Value | Ranking | Cost |
|---|---|---|
| unset | Pure semantic, using the full cosine range | 1 `embed()` per read |
| `1.0` | All-semantic, with negative scores clamped to 0 | 1 `embed()` |
| `0.7` | 70% semantic, 30% keyword. A good starting point. | 1 `embed()` |
| `0.5` | Balanced | 1 `embed()` |
| `0.0` | Pure keyword. **Skips `embed()` entirely.** | none |

Keyword ranking helps with names, IDs, and exact phrases that embeddings blur together.

## `preFilterLimit`: scale to thousands of facts

Without it, every fact's vector is scored. With `preFilterLimit: 50`, only the top 50 keyword
matches are scored, so the work drops from O(N) to O(50). We recommend it once an entity has
more than about 500 facts.

```ts
await wiki.read('user-123', 'query', { preFilterLimit: 50 });
await wiki.read('user-123', 'query', { preFilterLimit: null }); // turn off a global setting for one call
```

:::caution
The pre-filter can drop a semantically relevant fact that shares no keywords with the query.
Use it for scale, not on small entities.
:::

Need more scale than that? Plug in an ANN index with a
[`VectorRanker`](/expo-llm-wiki/guides/vector-ranker/).

## `tokenBudget`: fit the prompt

```ts
const bundle = await wiki.read('user-123', 'what should I cook?', { tokenBudget: 800 });
const prompt = formatContext(bundle, { compact: true }); // compact drops confidence, tags, ids, and scores
```

The engine keeps the most relevant facts per token that fit in about 800 tokens, estimated at
characters ÷ 4. The top fact is always included, truncated if needed. Tasks and events aren't
affected. A `read_budget` diagnostic reports how many facts were packed.

## Format for your prompt

`formatContext()` turns a bundle into prompt-ready text, ordering facts by a weighted score of
confidence, access count, and recency:

```ts
import { formatContext } from '@equationalapplications/core-llm-wiki';

const context = formatContext(bundle, {
  format: 'markdown',      // or 'plain'
  maxFacts: 10, maxTasks: 10, maxEvents: 10,
  includeConfidence: true, // "(certain)"
  includeTags: true,       // "[tag1, tag2]"
  includeEntityIds: false, // provenance for multi-entity reads
  factWeights: { confidence: 1.0, accessCount: 0.3, recency: 0.5 },
});

const systemPrompt = `You are a helpful assistant.\n\n${context}`;
```

An empty bundle formats to an empty string, so it's safe to include unconditionally.
