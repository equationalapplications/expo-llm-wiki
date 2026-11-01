---
title: Knowledge graph & ontology
description: How facts become nodes, how ontologies constrain the edges an LLM can create, and how the graph lives in plain SQLite.
sidebar:
  order: 4
---

Every fact is a potential **node**. When an **ontology** is turned on for an entity, the
librarian and ingest passes also emit typed **edges** between facts. The edges are stored in the
`llm_wiki_edges` table and walked by [`traverseGraph()`](/expo-llm-wiki/guides/graphrag/).

```text
 [person] Alice ──worksFor──▶ [organization] Acme
       │
       └──knows──▶ [person] Bob ──homeLocation──▶ [place] Seattle
```

There's no Neo4j or separate graph store: a traversal is one recursive CTE over two SQLite tables.

## What an ontology is

An **ontology manifest** lists the node types and edge types the model may use:

```ts
const manifest = {
  node_types: [
    { type: 'person', description: 'An individual.' },
    { type: 'project', description: 'An ongoing initiative.' },
  ],
  edge_types: [
    { type: 'contributes_to', source_type: 'person', target_type: 'project', description: 'Works on a project.' },
  ],
};
```

The manifest is included in the model's prompt, and the output is validated against it. A short,
curated manifest keeps prompts small and the graph clean. Without one, a model will invent new
relationship names on every call.

Don't want to write your own? Use a published one:
[schema.org warm-agent (9 types, 28 edges)](/expo-llm-wiki/packages/ontologies/) or
[software organization (17 types, 40 edges)](/expo-llm-wiki/packages/ontologies/#software-organization).

## Three modes

| Mode | Behavior |
|---|---|
| **`off`** (default) | No guidance. Facts are untyped (`okf_type: null`) and maintenance creates no edges. |
| **`strict`** | The model may only use types in the manifest. An invalid `okf_type` makes the fact untyped, and invalid edges are dropped. |
| **`emergent`** | Like strict, but the model may propose new types via `ontology_updates`. These are appended to the manifest. |

The mode is resolved **per entity**, in this order: a persisted DB row, then
`seedManifests[entityId].mode`, then the global `ontology.mode`, then `'off'`.

## One-level inheritance

A node type can declare a `parent_type`, which lets edges defined on the parent also match the
child:

```ts
{ type: 'design_spec', parent_type: 'creativework', description: 'A technical design document.' }
```

An edge declared `about: creativework → person` now also accepts a `design_spec` source.
Inheritance is **one level only**. Chains, cycles, self-parents, and unknown parents are rejected
when the manifest is validated.

## Facts without types

Facts that skip the librarian (imported dumps, or data from before you turned on an ontology) have
no type and no edges, so traversal can't reach them.
[`runOntologyBackfill()`](/expo-llm-wiki/guides/ontologies/#backfill-untyped-facts) fixes that.

## Next

- [Guide: Ontologies](/expo-llm-wiki/guides/ontologies/): seeding, per-entity modes, React hooks, backfill.
- [Guide: GraphRAG](/expo-llm-wiki/guides/graphrag/): traversal options and prompt formatting.
