# @equationalapplications/core-llm-tools

Zero-dependency Gemini function-calling schemas and capability-scoped tool injection for edge AI agents. Works in Node.js, browser, and React Native (Hermes).

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fcore-llm-tools?label=core-llm-tools)](https://www.npmjs.com/package/@equationalapplications/core-llm-tools)
[![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fcore-llm-tools?label=downloads)](https://www.npmjs.com/package/@equationalapplications/core-llm-tools)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/LICENSE)

**[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

> A universal registry bridging the gap between Edge AI (Expo/React Native) and Cloud Agents (Cloud Run).

## Overview

`core-llm-tools` provides a shared, strictly-typed repository of JSON Function Declarations (Tools) for Gemini models. By decoupling the **Tool Interface** (the schema) from the **Tool Implementation** (the executing code), this package allows client-side triage agents and heavy backend cloud agents to share the exact same capabilities without importing Node.js server dependencies into the browser or mobile environments.

It also introduces a robust **Capability-Based Scope Model** (similar to OAuth 2.0), ensuring that Large Language Models are only injected with tools the user has explicitly authorized.

## Features

- **Platform-Agnostic** — Zero runtime dependencies. Pure TypeScript. Compiles safely for Node.js, the browser, and the React Native Hermes engine.
- **Capability-Based Security** — Tools are locked behind specific scopes (e.g., `calendar:read`, `messages:send`). The injector ensures models cannot hallucinate calls to unauthorized tools.
- **Strict Typings** — Provides rigid interfaces (`AgentToolSchema`, `AgentToolManifest`) to prevent malformed Gemini API requests.
- **Harmonized Edge/Cloud Routing** — Enables lightweight edge models (like Gemini Nano) to triage intents using the exact same schemas the heavy Cloud Run backend uses to execute them.
- **GraphRAG tool schemas** — `wikiTraverseGraphManifest` and `wikiGetOntologyManifest` are pre-built Gemini tool schemas for the GraphRAG retrieval API; see [root README: GraphRAG](../../README.md#graphrag-sql-only-graph-retrieval).

## Installation

```bash
npm install @equationalapplications/core-llm-tools
# or
pnpm add @equationalapplications/core-llm-tools
```

## Quick Start

### 1. Defining a Tool Manifest

Tools are defined by wrapping a standard Gemini JSON schema with a required security scope.

```typescript
import type { AgentToolManifest } from '@equationalapplications/core-llm-tools';

export const getCalendarEventsManifest: AgentToolManifest = {
  name: 'get_calendar_events',
  scope: 'calendar:read', // Security scope required to use this tool
  schema: {
    name: 'get_calendar_events',
    description: 'Fetch the user\'s schedule for a given date.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string' }
      }
    }
  }
};
```

### 2. Injecting Authorized Tools

At runtime, use `buildAuthorizedToolsArray` to filter your tool library against the user's granted permissions. It returns the full Gemini `tools[]` array: at most one `functionDeclarations` group containing every authorized function tool's schema, plus one entry per authorized built-in tool (e.g. Google Search grounding).

```typescript
import { buildAuthorizedToolsArray, escalateToCloudManifest } from '@equationalapplications/core-llm-tools';

// 1. Gather all manifests known to your app
const allAppTools = [escalateToCloudManifest, getCalendarEventsManifest];

// 2. Fetch the user's authorized scopes from your DB (e.g., SQLite/Postgres)
const userGrantedScopes = ['calendar:read'];

// 3. The injector automatically includes 'core' tools and authorized scoped tools,
//    collapsing all authorized function tools into a single functionDeclarations group
const tools = buildAuthorizedToolsArray(allAppTools, userGrantedScopes);
// => [{ functionDeclarations: [get_calendar_events, escalate_to_cloud] }]

// 4. Pass safely to Gemini
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: userInput,
  tools,
});
```

### 3. Built-In Tools (Grounding)

Some Gemini capabilities, like [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search),
are built-in tools executed server-side by Google rather than function declarations your code
implements. These are declared with `kind: 'built_in'` and flow through the same
capability-scope model as function tools, via `buildAuthorizedToolsArray`.
Use `AnyAgentToolManifest` when mixing function and built-in manifests;
`AgentToolManifest` remains the function-only type for existing callers:

```typescript
import type { AnyAgentToolManifest } from '@equationalapplications/core-llm-tools';
import { buildAuthorizedToolsArray, googleSearchManifest, escalateToCloudManifest } from '@equationalapplications/core-llm-tools';

const allAppTools: AnyAgentToolManifest[] = [escalateToCloudManifest, googleSearchManifest];
const userGrantedScopes: string[] = [];

// Returns the full Gemini tools[] array: a functionDeclarations group (if any
// function tools are authorized) plus one entry per authorized built-in tool.
const tools = buildAuthorizedToolsArray(allAppTools, userGrantedScopes);
// => [{ functionDeclarations: [...] }, { google_search: {} }]

const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: userInput,
  tools,
});
```

> **Note:** When the model uses `google_search`, Gemini returns a `groundingMetadata` object
> (search queries, source citations, etc.) on the response. Parsing that metadata is the
> caller's responsibility — this package only handles the request-side tool declaration.

## Helpful Resources & Links

- [Google Gen AI: Function Calling Tutorial](https://ai.google.dev/gemini-api/docs/function-calling) — Official docs on how the JSON schemas in this package interact with Gemini models.
- [JSON Schema Specification](https://json-schema.org/understanding-json-schema/) — Structural foundation for `AgentToolSchema.parameters`.
- [OAuth 2.0 Scope Concepts](https://oauth.net/2/scope/) — Inspiration behind the capability-based `AgentScope` permission hierarchy.
- [@google/adk (Agent Development Kit)](https://github.com/google/adk-python) — Server-side framework used by Cloud Run backends to wrap and execute the schemas defined in this package.

## Monorepo Ecosystem

| Package | Purpose |
| ----- | ----- |
| [@equationalapplications/core-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [@equationalapplications/expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [@equationalapplications/react-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
| [@equationalapplications/prisma-outbox](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/prisma-outbox/README.md) | Sync SQLite outbox events to Prisma |
| [**@equationalapplications/core-llm-tools**](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/README.md) | Gemini tool schemas and capability injector |
| [@equationalapplications/core-okf](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/okf/README.md) | Zero-dependency Open Knowledge Format (OKF) v0.1 + v0.2 primitives — parse and produce interoperable knowledge bundles. |
| [@equationalapplications/schema-org-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-org/README.md) | Curated schema.org warm-agent ontology manifest |
| [@equationalapplications/schema-software-org](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-software-org/README.md) | Software-organization executive ontology manifest — 17 node types, 40 edges, warm-agent superset, data-only |

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
