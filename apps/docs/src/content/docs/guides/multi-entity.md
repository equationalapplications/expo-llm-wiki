---
title: Multi-entity & tiered memory
description: Read across several entity namespaces in one pass with tierWeights and tierFloors, and explain the ranking with factScores.
sidebar:
  order: 5
---

Pass an **array** of entity IDs to `read()` to merge them in a single ranking pass. A common
pattern is memory **tiers**:

| Tier | Holds | Weight |
|---|---|---|
| `tier_wisdom` | Curated, reviewed notes | `2` (boosted) |
| `tier_fact` | Normal extracted facts | `1` |
| `tier_working` | Scratch and short-term context | `0.25` (demoted) |

```ts
const memory = await wiki.read(['tier_wisdom', 'tier_fact', 'tier_working'], 'deploy process', {
  maxResults: 8,
  tierWeights: { tier_wisdom: 2, tier_fact: 1, tier_working: 0.25 },
  tierFloors: { tier_wisdom: 1, tier_fact: 1 },
});

memory.factScores; // { [factId]: weightedScore }, for explaining the ranking
memory.metadata;   // { query, entityIds, tierWeights, tierFloors }
```

## How scoring works

1. Each fact is scored normally (semantic, keyword, or hybrid).
2. The score is multiplied by its entity's weight: `final = score × tierWeights[entity]`.
3. Floors reserve the top N results of each listed entity.
4. Everything is merged, and the **global** `maxResults` cut is applied.

### Weight rules

- A missing weight means `1.0`. Negative weights clamp to `0`. Non-finite weights become `1.0`.
- A weight of `0` **skips** that entity entirely, at no compute cost, unless you pass
  `includeZeroWeightEntities: true`. In that case its facts fill in at the bottom.

### Floor rules

- A floor guarantees **at least N** results from that entity, if it has that many matches.
- Floors apply after weighting and after `preFilterLimit`, so a floor can't bring back a row the
  pre-filter excluded.
- These combinations throw `WikiInvalidReadOptions`: floors that sum to more than `maxResults`,
  a floor on an entity that isn't in the list, or a floor on a zero-weight entity.

## Caps on tasks and events

Multi-entity bundles cap tasks at `min(20 × entities, 200)` and events at
`min(10 × entities, 100)`. Equal representation per entity isn't guaranteed.

## Show provenance in the prompt

```ts
formatContext(memory, { includeEntityIds: true, includeFactScores: true });
// - **Uses blue/green deploys** (certain) {entity_id=tier_wisdom} {score=1.8400}
//   We deploy with blue/green and a 10-minute bake.
```

## Librarian synthesis helpers

For "answer from tiered memory" flows, core exports prompt helpers:

```ts
import {
  DEFAULT_LIBRARIAN_SYNTHESIS_PROMPT, hydrateLibrarianPrompt,
  mapLibrarianOptionsToReadOptions, validateLibrarianPromptTemplate, formatContext,
} from '@equationalapplications/core-llm-wiki';

const memory = await wiki.read(['tier_wisdom', 'tier_fact'], query, {
  ...mapLibrarianOptionsToReadOptions({ entityWeights: { tier_wisdom: 2, tier_fact: 1 } }),
  maxResults: 8,
});

const prompt = hydrateLibrarianPrompt(DEFAULT_LIBRARIAN_SYNTHESIS_PROMPT, {
  query,
  context: formatContext(memory, { includeEntityIds: true, includeFactScores: true }),
  tasks: formatContext({ facts: [], tasks: memory.tasks, events: [] }, { format: 'plain' }),
});
```

`validateLibrarianPromptTemplate(template, { custom, taskCount })` returns warnings for a custom
template that's missing `{{context}}` or `{{query}}`, or that's missing `{{tasks}}` when tasks were
retrieved.
