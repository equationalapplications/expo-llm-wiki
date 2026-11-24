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

How it behaves in detail:

- **One level, checked everywhere.** The manifest is validated whenever it's saved *and* whenever
  it's read. `setOntologyManifest` rejects a chain up front. The depth check also catches 2-cycles
  (`a → b → a`).
- **Absent is fine, blank isn't.** Leaving out `parent_type` means "no parent". A key that is
  present must be a non-empty string.
- **Parents are real types.** A fact can be classified as the bare parent (`creativework`). There's
  no `abstract` flag. To steer the model toward the children, say so in the parent's description.
- **Matching works on both ends, one hop.** A child satisfies an edge declared on its parent as
  either the source or the target. Matching never walks further than one level.
- **The trade-off.** An edge declared to `creativework` admits every child of `creativework`, and
  there's no way to say "the parent only". A type that needs exact-only targets must not have
  children.
- **Emergent mode.** The model may propose `parent_type` in `ontology_updates`. Those proposals are
  treated as untrusted: an invalid `parent_type` is dropped rather than failing the ingest. To
  change an existing type's parent, call `setOntologyManifest`.
- **No migration needed.** `parent_type` is optional, and manifests without it validate exactly as
  before.

The full design is in the
[ontology parent field spec](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/superpowers/specs/2026-08-28-ontology-parent-field-spec.md).

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
let previousRemaining = Infinity;
do {
  r = await wiki.runOntologyBackfill(entityId);
  // { scanned, typed, failedValidation, edgesAdded, remaining, deferred, skipped }
  if (r.remaining >= previousRemaining) break; // no progress: stop, retry on the next trigger
  previousRemaining = r.remaining;
} while (r.remaining > 0);
```

- **Host-loop guidance:** loop `runOntologyBackfill` while `remaining > 0 && !budgetStop`; a
  `budgetStop` result means a token budget ended the pass early, so a fixed budget never
  converges (see the `budgetStop` doc comment on the result type).
- **Stop when a pass doesn't lower `remaining`.** A fact whose provider call keeps throwing (a
  `call_error`, or a thrown `classify`) gets no cooldown stamp and stays eligible, so a bare
  `while (remaining > 0)` loop can spin on it forever. The guard above stops on no progress;
  the next trigger retries.
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
  config: { systemOne: { typing: 'auto', minConfidence: { typing: 0.5 } } },
});

await wiki.runOntologyBackfill('user-1');                        // uses classify
await wiki.runOntologyBackfill('user-1', { classifier: 'llm' }); // force the generative path
```

- Each untyped fact gets one `choice` question over the manifest's node types plus a reserved
  `none_of_these` sentinel, so the classifier can decline instead of guessing. An abstain is an
  omission: the fact stays untyped, is retried after the cooldown, and is reported in the new
  `abstained` counter with a `classification_abstained` diagnostic.
- Answers below the floor (`systemOne.minConfidence.typing`, then `ontology.classifyMinConfidence`,
  default `0.5`) stay untyped. Set `systemOne.onLowConfidence: 'llm'` to escalate low-confidence
  and abstain outcomes to the generative step of the same pass — a cost/quality setting, not a
  safety mechanism.
- **Classifier mode proposes no edges.** Use `classifier: 'llm'` when you want edges.
- More than 254 node types (the sentinel needs a slot), a manifest that carries the reserved
  `none_of_these` slug, or no `classify` function means the generative path is used. The slug
  cannot be declared: `setOntologyManifest` rejects it and emergent merges drop it.

### Type on write

The classifier can also type a fact at the moment the librarian writes it, instead of waiting for
a backfill pass. Opt in with `systemOne.typeOnWrite: 'auto'` (default `'llm'`, which changes
nothing):

```ts
createWiki(db, {
  llmProvider: { generateText, classify },
  config: { systemOne: { typeOnWrite: 'auto' } },
});
```

It applies to the librarian only, both strategies (ingest has its own key, below), and engages only when the provider has a
`classify` function, the entity's ontology mode is `strict` or `emergent`, and the manifest has
1 to 254 node types and no `none_of_these` slug. Otherwise the librarian runs exactly as before.
When engaged, each fact the librarian is about to insert gets the same `choice` question the
backfill asks, metered against the same token budget as the pass's other calls, and the ontology
block is **not** sent in the librarian's prompt for that pass. An answer is applied only at or
above the `systemOne.minConfidence.typing` floor; a decline, a low-confidence answer, an invalid
answer or a failed call writes the fact untyped (no cooldown stamp), so the backfill still reaches
it. `systemOne.onLowConfidence` is not read here.

Three things to know before turning it on:

- **No manifest-drawn edges.** A fact typed on write carries no edges. The classifier is asked no
  edge question, the engaged prompt carries no manifest so the model proposes none, and because a
  typed fact never re-enters the backfill pool, backfill will not add outgoing edges to it later
  either. It can still be the *target* of edges drawn from other facts. Use `typeOnWrite: 'llm'`
  (and the generative backfill) when you want outgoing edges.
- **Extraction quality is unmeasured.** While engaged, the model extracts facts without seeing the
  ontology block. The engine makes no claim that it extracts the same facts either way. Compare
  extraction on your own data, with your own model, before and after.
- **Cost is unmeasured.** The prompt gets shorter and the pass gains one classify call per fact
  (including a call spent on a fact that is then updated in place or skipped as a duplicate). The
  net cost may go either way; no number is claimed.

In `emergent` mode the engaged librarian sends no `ontology_updates` invitation, so it proposes no
new types for that pass; the backfill's generative path still does. Receipts reuse existing
diagnostics (`node_type_assigned` with `writer: 'classifier'` and a `confidence`,
`classification_abstained`, `classification_low_confidence`, `classification_invalid`,
`context_overflow_skipped`), and `runPendingMaintenance` reports `typedOnWrite` per entity beside
the backfill's `typed`.

#### Ingest

`ingestDocument()` has its own opt-in, `systemOne.typeOnIngest: 'auto'` (default `'llm'`, which
changes nothing). It is a separate key from `typeOnWrite`: setting one does not turn on the other,
and a host that wants both sets both. It engages under the same conditions (the key set to `'auto'`, a `classify`
function, mode `strict` or `emergent`, a representable manifest) and reads the same
`systemOne.minConfidence.typing` floor. When engaged, the call extracts every chunk without the
ontology block in the prompt, then asks `classify` one `choice` question per extracted fact that
the model did not already type with a valid slug, before anything is written. An accepted answer
types the row as it is created; a decline, a low-confidence answer, an invalid answer or a failed
call writes the fact untyped (no cooldown stamp) so the backfill still reaches it. The result
gains a `typing` counters object. Receipts are the same diagnostics as above, with `operation:
'ingest'` and `detail.sourceRef`. Separately, and for every host, a fact the model types itself at
ingest now also gets a `node_type_assigned` receipt with `writer: 'llm'`.

`ingestDocument()` carries no token budget, so ingest-time classify calls are exactly as unmetered
as the call's chunk calls: there is no `budget_exhausted` here, and the spend scales with the
facts the model extracted, not with the document's chunks. Each call is reported through the
`llm_usage` diagnostic (`operation: 'ingest'`) when `reportLlmUsage` is on. If a budget is ever
added to `ingestDocument()`, the classify fan-out under `chunkConcurrency` will share the
overshoot tracked in #475 (see [Maintenance](/expo-llm-wiki/guides/maintenance/)).

The three disclosures above apply to ingest, sharper for documents:

- **No manifest-drawn edges, and ingest is where document edges come from.** A fact the classifier
  types at ingest carries no outgoing edges, and backfill never adds them later. It can still be an
  edge *target*, including for sibling facts the model typed itself in the same ingest. A host that
  wants edges between a document's own facts keeps `typeOnIngest: 'llm'`.
- **Extraction quality is unmeasured, more so for documents.** The ontology block is the
  extractor's guide to what counts as a fact; engaged, the model extracts without it. Compare
  extraction on your own documents, with your own model, before and after.
- **Cost is unmeasured.** Shorter chunk prompts, plus one classify call per extracted fact
  (including a call spent on a fact then skipped as a duplicate on a retry; a full write whose hash another live sourceRef already holds spends none, because the engine checks before asking), with no budget. The net
  cost may go either way; no number is claimed.

In `emergent` mode an engaged ingest sends no `ontology_updates` invitation, so documents propose
no new types for that call; the backfill's generative path still does.

[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts) uses this with a
Jev classifier on Cloudflare Workers AI (`typesafe/jev`), behind its **Type untyped facts** button.

`classify` receives `{ state, questions }`, where each question is `choice`, `binary`, or
`score`. It returns `{ answers }`, which the engine validates as untrusted input: off-list choices
and out-of-range probabilities count toward `failedValidation`, and a `classify` call that throws
counts toward `skipped` and is retried on the next pass. Answers below the confidence floor are
retried after the cooldown.
