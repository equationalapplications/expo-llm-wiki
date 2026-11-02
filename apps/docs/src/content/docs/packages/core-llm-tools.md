---
title: core-llm-tools
description: Zero-dependency Gemini function-calling schemas with capability-scoped tool injection, for browser, mobile, and server.
sidebar:
  order: 4
---

`@equationalapplications/core-llm-tools` · [npm](https://www.npmjs.com/package/@equationalapplications/core-llm-tools) · [source](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/core-llm-tools)

Shared, strictly typed **tool schemas** for Gemini function calling, kept separate from the code
that runs the tools. Edge models (in the browser or on device) and cloud agents can use the
**same** schemas. A scope model similar to OAuth means a model only sees tools the user granted.

It's standalone: there's no SQLite or framework dependency, and it runs on Node, browsers, and Hermes.

```bash
npm install @equationalapplications/core-llm-tools
```

## Define a tool

```ts
import type { AgentToolManifest } from '@equationalapplications/core-llm-tools';

export const getCalendarEventsManifest: AgentToolManifest = {
  name: 'get_calendar_events',
  scope: 'calendar:read',
  schema: {
    name: 'get_calendar_events',
    description: "Fetch the user's schedule for a given date.",
    parameters: { type: 'object', properties: { date: { type: 'string' } } },
  },
};
```

## Inject only authorized tools

```ts
import { buildAuthorizedToolsArray, escalateToCloudManifest, googleSearchManifest } from '@equationalapplications/core-llm-tools';

const tools = buildAuthorizedToolsArray(
  [escalateToCloudManifest, getCalendarEventsManifest, googleSearchManifest],
  ['calendar:read'], // the user's granted scopes
);
// → [{ functionDeclarations: [get_calendar_events, escalate_to_cloud_agent] }, { google_search: {} }]
//   (escalate_to_cloud_agent and google_search are in the always-on 'core' scope)

await ai.models.generateContent({ model: 'gemini-2.5-flash', contents, config: { tools } });
```

- Tools in the `core` scope are always included.
- All authorized function tools are collapsed into **one** `functionDeclarations` group.
- Built-in tools (`kind: 'built_in'`, such as Google Search) each add their own entry. Use the
  `AnyAgentToolManifest` type when you mix both kinds.

## Built-in manifests

| Manifest | Tool name | Scope |
|---|---|---|
| `escalateToCloudManifest` | `escalate_to_cloud_agent` | core |
| `getCurrentTimeManifest` | `get_current_time` | core |
| `googleSearchManifest` | `google_search` (built-in) | core |
| `graphTraverseManifest` | `graph_traverse` | `memory:read` |
| `ontologyGetManifest` | `ontology_get` | `memory:read` |
| `instructionsGetManifest` | `instructions_get` | `memory:read` |

The memory manifests are schema-only. Dispatch them to `traverseGraph`,
`getOntologyManifest`, and `getInstructions`. See the
[Gemini agent recipe](/expo-llm-wiki/recipes/gemini-agent-tools/).

:::caution[Deprecated: the `wiki_*` names]
`wikiTraverseGraphManifest` (`wiki_traverse_graph`), `wikiGetOntologyManifest`
(`wiki_get_ontology`) and `wikiGetInstructionsManifest` (`wiki_get_instructions`) are still
exported, identical to their replacements except for the name, and are removed at the next major.
Migrate by switching to the new manifests and routing your `switch` through
`canonicalToolName(call.name)` in the same change. It maps an old name to the new one
(`LEGACY_TOOL_NAMES` holds the map) and returns any other name unchanged. Never send the old and
new manifest for one tool to the same model.
:::
