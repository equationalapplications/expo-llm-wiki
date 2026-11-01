---
title: Question answering over a graph
description: Combine vector search to find an anchor with graph traversal for context, so the model can answer relationship questions.
sidebar:
  order: 4
---

**Goal:** answer questions like *"Who on Alice's team works in Seattle?"* that need connected facts.

**Pattern:** use `read()` to find the anchor, `traverseGraph()` to expand it, and inject **both**
into the prompt.

```ts
import { formatContext, formatGraphContext } from '@equationalapplications/core-llm-wiki';

export async function answer(wiki, entityId: string, question: string) {
  // 1. Semantic search finds the most relevant starting fact
  const hits = await wiki.read(entityId, question, { maxResults: 5 });
  if (hits.facts.length === 0) return generate(question, '');

  // 2. Expand the top hit into its neighbourhood
  const graph = await wiki.traverseGraph(entityId, {
    sourceId: hits.facts[0].id,
    maxDepth: 2,
    direction: 'both',
    minTraversalConfidence: 'inferred',
    maxTraversalNodes: 25,
    excludeDrafts: true,
  });

  // 3. Give the model both views
  const context = [
    '## Relevant facts', formatContext(hits, { maxTasks: 0, maxEvents: 0 }),
    '## Connected facts', formatGraphContext(graph),
  ].join('\n\n');

  return generate(question, context);
}
```

## Prerequisites

The graph only has edges if an ontology was active when facts were written. The quickest setup:

```ts
import { schemaOrgWarmAgentManifest } from '@equationalapplications/schema-org-llm-wiki';
await wiki.setOntologyManifest(entityId, schemaOrgWarmAgentManifest, { mode: 'strict' });
await wiki.runOntologyBackfill(entityId, { classifier: 'llm' }); // types older facts + proposes edges
```

## Tips

- Filter with `edgeTypes` (for example `['worksFor', 'memberOf']`) for focused questions.
- Run `lint(entityId)` occasionally. A high `danglingEdges` count suggests stale references.
