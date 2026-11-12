---
title: Upgrading to 8.0.0
description: What changes in 8.0.0, how to keep the 7.x behavior, and the tool-name mapping.
---

8.0.0 changes two engine defaults and removes three deprecated tool names. All packages release in
lockstep, so every package moves to 8.0.0.

## What changes

| Setting | 7.x default | 8.0.0 default |
|---|---|---|
| `librarian.strategy` | `'legacy'` | `'ops'` |
| `maintenance` | `'auto'` | `'deferred'` |

**`maintenance: 'deferred'`.** `write()` only records the event. The librarian and heal no longer
start from `write()`, so no facts appear from events and no model is called until you run
maintenance yourself:

```ts
const pending = await wiki.getPendingMaintenance();
await wiki.runPendingMaintenance();
```

An app that set only `autoLibrarianThreshold` or `autoHealThreshold` stops getting automatic runs.
Those settings apply only in `'auto'` mode. The engine logs a console warning at construction when
it sees one without an explicit `maintenance` value. It also warns when `librarian.strategy` is
pinned to `'legacy'` with no `maintenance` value and no auto-run threshold. Each warning is logged once per process. Until the librarian has processed an entity's
events, `runPrune()` keeps them and emits `event_retention_held`, so the event log grows if nothing
runs maintenance. A wipe that must remove events too uses
`forget(entityId, { clearAll: true, includeEvents: true })` (see
[Deleting data](/expo-llm-wiki/guides/deleting-data/#wipe-an-entity-completely)).

**`librarian.strategy: 'ops'`.** The librarian works through events since its last pass, skips
candidates an embedding gate finds identical, and supersedes changed facts instead of overwriting
them. `prompts.librarianSystemPrompt` and the `promptOverride` argument of `runLibrarian()` aren't
used by this strategy. The engine logs a warning at construction when a custom librarian prompt is
set without an explicit strategy. `getInstructions()` and the `instructions_get` tool now report the
ops extract prompt as `librarian`.

These defaults haven't been benchmarked against the 7.x defaults, so test on your own workload.

## Keep the 7.x behavior

Set both options. Don't set only one:

```ts
const wiki = new WikiMemory(db, {
  llmProvider,
  config: {
    librarian: { strategy: 'legacy' },
    maintenance: 'auto',
  },
});
```

`'deferred'` with `'legacy'` is unsafe: the legacy strategy reads only the newest 50 events per pass
and advances past them, so a larger backlog is never extracted.

If you set `maintenance: 'auto'` and keep the default `'ops'` strategy, use 8.0.5 or later.
Earlier 8.0.x releases skipped the first batch of events. See
[Maintenance](/expo-llm-wiki/guides/maintenance/#librarian-strategies).

`'auto'` isn't safe on serverless or request-scoped hosts, because its background promises can be
frozen or killed partway through. See
[Serverless & multi-tenant hosting](/expo-llm-wiki/guides/serverless-hosting/).

## Tool names

`@equationalapplications/core-llm-tools` removes the deprecated names, along with
`LEGACY_TOOL_NAMES` and `canonicalToolName`.

| Removed export (tool name) | Use instead |
|---|---|
| `wikiTraverseGraphManifest` (`wiki_traverse_graph`) | `graphTraverseManifest` (`graph_traverse`) |
| `wikiGetOntologyManifest` (`wiki_get_ontology`) | `ontologyGetManifest` (`ontology_get`) |
| `wikiGetInstructionsManifest` (`wiki_get_instructions`) | `instructionsGetManifest` (`instructions_get`) |

Dispatch on the new names, and update any stored prompt that tells a model to call an old one.

## Check before upgrading

Find every place you construct `WikiMemory` or call `createWiki`, including factories such as a
`makeWikiOptions` helper, and decide on both settings there. An app pinned to a 7.x version isn't
affected until it upgrades. Curated Thoughts is one such app today: it's pinned to 7.13.0, and
`makeWikiOptions` in `src/lib/wiki.ts` sets neither option, so it needs this decision when it moves
to 8.x.
