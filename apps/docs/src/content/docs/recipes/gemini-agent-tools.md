---
title: Gemini agent with scoped memory tools
description: Give a Gemini model memory tools it is authorized to use, and dispatch its function calls to Core LLM Wiki.
sidebar:
  order: 5
---

**Goal:** let a Gemini agent read the knowledge graph through function calling, but only if the
user has granted `memory:read`.

```ts
import { GoogleGenAI } from '@google/genai';
import {
  buildAuthorizedToolsArray,
  escalateToCloudManifest,
  graphTraverseManifest,
  ontologyGetManifest,
  instructionsGetManifest,
} from '@equationalapplications/core-llm-tools';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Scopes come from your auth system, per user.
const grantedScopes = ['memory:read'];

const tools = buildAuthorizedToolsArray(
  [escalateToCloudManifest, graphTraverseManifest, ontologyGetManifest, instructionsGetManifest],
  grantedScopes,
);

const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: 'What projects is Alice connected to?',
  config: { tools },
});

// Dispatch any function calls to the wiki.
// The tool schemas include an `entityId` argument. Ignore it and use the session's entity.
for (const call of response.functionCalls ?? []) {
  const { entityId: _ignored, ...args } = (call.args ?? {}) as Record<string, any>;
  let result: unknown;
  switch (call.name) {
    case 'graph_traverse':
      result = await wiki.traverseGraph(entityId, { ...args, sourceId: args.sourceId });
      break;
    case 'ontology_get':
      result = await wiki.getOntologyManifest(entityId);
      break;
    case 'instructions_get':
      result = await wiki.getInstructions(entityId);
      break;
  }
  // …send result back as a functionResponse part
}
```

## Why scopes?

`buildAuthorizedToolsArray` drops every tool the user hasn't granted, so the model never even
**sees** a tool it can't use. Tools in the `core` scope, such as `escalate_to_cloud_agent`, are always included.

:::caution
Take `entityId` from the authenticated session. Never trust the model's `entityId` argument.
:::

See [core-llm-tools](/expo-llm-wiki/packages/core-llm-tools/) for defining your own manifests
and built-in tools like Google Search grounding.
