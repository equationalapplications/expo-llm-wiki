---
title: Entities & namespaces
description: How entity IDs partition memory, and how to design an entity scheme for users, agents, and memory tiers.
sidebar:
  order: 2
---

Every API call takes an `entityId`. An entity is an independent "brain": its events, facts,
tasks, edges, and ontology are kept separate from every other entity's in the same database.

```ts
await wiki.write('user-alice', { event_type: 'observation', summary: 'Allergic to peanuts.' });
await wiki.read('user-bob', 'allergies'); // → nothing from Alice
```

## Common schemes

| Scheme | Example IDs | When to use |
|---|---|---|
| Per user | `user:123` | Personal assistants and consumer apps |
| Per agent | `agent:planner`, `agent:coder` | Multi-agent systems where each agent keeps its own notes |
| Per tier | `tier_wisdom`, `tier_fact`, `tier_working` | Ranking curated knowledge above scratch memory |
| Per repo or project | `repo:myproject` | Coding agents (the [MCP server](/expo-llm-wiki/packages/mcp-server/) uses this convention) |
| Compound | `tenant:42:user:7` | Multi-tenant SaaS |

Entity IDs are opaque strings to the engine, so pick whatever structure suits your app. Use a
consistent prefix so you can list entities with `listEntityIds({ prefix })`.

## Reading across entities

`read()` accepts an array of entity IDs and merges results in one ranking pass. Use weights to
boost or demote namespaces:

```ts
const memory = await wiki.read(['tier_wisdom', 'tier_fact', 'tier_working'], 'deploy process', {
  maxResults: 8,
  tierWeights: { tier_wisdom: 2, tier_fact: 1, tier_working: 0.25 },
  tierFloors: { tier_wisdom: 1 }, // always include ≥1 curated fact if one matches
});
```

Full details: [Multi-entity & tiered memory](/expo-llm-wiki/guides/multi-entity/).

## Discovering entities

```ts
const all = await wiki.listEntityIds();                     // every entity with any row
const tiers = await wiki.listEntityIds({ prefix: 'tier_' });
```

The list includes entities whose rows are all soft-deleted, so that prune jobs can reclaim them.

:::caution[Entities are not an auth boundary]
The engine scopes every query by `entityId`, but deciding **which** entity a caller may access is
your app's job. Authenticate the caller first, then pass the entity ID they're allowed to use.
:::
