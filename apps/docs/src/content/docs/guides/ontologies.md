---
title: Ontologies
description: Seed per-entity ontology manifests, choose strict or emergent mode, manage them from React, and backfill untyped facts.
sidebar:
  order: 7
---

Read [Knowledge graph & ontology](/expo-llm-wiki/concepts/knowledge-graph/) first for the
background. This page covers the practical side.

## Seed at construction time

```ts
createWiki(db, {
  llmProvider,
  config: {
    ontology: {
      mode: 'strict', // global default for entities with no override
      seedManifests: {
        'team-alpha': {
          mode: 'emergent', // per-entity override
          manifest: {
            node_types: [
              { type: 'person', description: 'An individual or user.' },
              { type: 'project', description: 'An ongoing initiative.' },
            ],
            edge_types: [
              { type: 'contributes_to', source_type: 'person', target_type: 'project', description: 'Works on a project.' },
            ],
          },
        },
      },
    },
  },
});
```

A seed is written to the database the first time the entity's ontology is resolved inside a
transaction (on ingest or heal). Until then, `getOntologyManifest()` still reports it.

## Read and set at runtime

```ts
await wiki.getOntologyManifest('team-alpha'); // { mode, manifest } or null

await wiki.setOntologyManifest('team-alpha', manifest, { mode: 'strict' }); // upsert

// Many entities in one transaction. With ifAbsent, an existing row is left alone.
const { written, skipped } = await wiki.setOntologyManifests(
  [
    { entityId: 'tier_fact', manifest, mode: 'strict' },
    { entityId: 'tier_wisdom', manifest, mode: 'strict' },
  ],
  { ifAbsent: true },
);
```

:::caution[Pick one seeding route per entity]
`ifAbsent` checks for a **persisted row**, not for a configured seed. An entity seeded only
through `seedManifests` has no row yet, so `ifAbsent` will overwrite the seed. Seed each entity
through config **or** through the API, not both.
:::

`validateManifest(manifest)` is exported if you want to check a manifest before saving it.

## What the model returns

In strict and emergent modes the extraction JSON may include a type and inline edges:

```json
{
  "facts": [{
    "title": "Jane reports to Bob",
    "body": "Jane reports to Bob Smith.",
    "tags": [], "confidence": "certain",
    "okf_type": "person",
    "edges": [{ "edge_type": "reports_to", "target_title": "Bob Smith" }]
  }]
}
```

- `okf_type` is matched case-insensitively and stored with the manifest's casing.
- Edges are resolved by `target_title` within the same transaction.
- An invalid `okf_type` stores the fact untyped and drops its edges. An invalid individual edge is
  dropped (and reported as an `edge_dropped` diagnostic).
- In **emergent** mode the model may add `ontology_updates.node_types` and `edge_types`. These are
  append-only and deduplicated by type. A malformed `parent_type` in a proposal is dropped, not thrown.

## Inheritance

```ts
node_types: [
  { type: 'creativework', description: 'Books, articles, specs…' },
  { type: 'design_spec', parent_type: 'creativework', description: 'A technical design.' },
]
```

Edges declared on `creativework` now also match `design_spec`. When several edges could match a
target, the **exact** type wins over the parent. Validation rejects any of the following:

| Problem | Error message |
|---|---|
| Unknown parent | `Parent type not found: <slug>` |
| Self-parent | `Self-parent: <type>` |
| Two or more levels | `Parent chain too deep: a → b → c` |
| Blank or non-string `parent_type` | `Ontology parent_type must be a non-empty string when present` |

## In React

```tsx
import { useOntologyManifest, useSetOntologyManifest } from '@equationalapplications/react-llm-wiki';

function OntologySettings({ entityId }: { entityId: string }) {
  const { manifest, mode, refetch } = useOntologyManifest(entityId);
  const { execute, isPending } = useSetOntologyManifest();

  const save = async (next) => {
    await execute(entityId, next, { mode: 'strict' });
    refetch(); // the read hook doesn't refresh on its own
  };
  // …
}
```

## Backfill untyped facts

Facts that bypassed the librarian (imports, or data from before ontologies) have no type and no
edges. `runOntologyBackfill()` types them **in place**:

```ts
let r;
do {
  r = await wiki.runOntologyBackfill(entityId);
  // { scanned, typed, failedValidation, edgesAdded, remaining, deferred, skipped }
} while (r.remaining > 0);
```

- **You own the trigger.** Running it after each sync or import is a good default. It's safe to
  swallow a `WikiBusyError`, since the next run retries.
- **It only adds.** It never creates, deletes, or rewrites facts, never overwrites an existing
  type, and never changes `updated_at`.
- **Cost:** a single `SELECT` when there's nothing to do. Otherwise it scans up to 25 facts per
  run (`batchSize`), in sub-batches sized from `maxOutputTokens`. Sub-batches that fail are
  halved and retried.
- Facts it can't classify are retried after 7 days (reported as `deferred`).
- Customize the prompt with `options.promptOverride` or `config.prompts.ontologyBackfillSystemPrompt`.

### Classifier mode

A non-generative classifier can do the typing at lower cost. Add `classify` to the provider and opt in:

```ts
createWiki(db, {
  llmProvider: { generateText, classify },
  config: { ontology: { backfillClassifier: 'auto', classifyMinConfidence: 0.5 } },
});

await wiki.runOntologyBackfill('user-1');                        // uses classify
await wiki.runOntologyBackfill('user-1', { classifier: 'llm' }); // force the generative path
```

- Each untyped fact gets one `choice` question over the manifest's node types.
- Answers below `classifyMinConfidence` stay untyped.
- **Classifier mode proposes no edges.** Use `classifier: 'llm'` when you want edges.
- More than 255 node types, or no `classify` function, means the generative path is used.

`classify` receives `{ state, questions }`, where each question is `choice`, `binary`, or
`score`. It returns `{ answers }`, which the engine validates as untrusted input.
