# @equationalapplications/core-llm-tools

Platform-agnostic Gemini tool schemas and a capability-based scope injector.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fcore-llm-tools?label=core-llm-tools)](https://www.npmjs.com/package/@equationalapplications/core-llm-tools)
[![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fcore-llm-tools?label=downloads)](https://www.npmjs.com/package/@equationalapplications/core-llm-tools)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> A universal registry bridging the gap between Edge AI (Expo/React Native) and Cloud Agents (Cloud Run).

## Overview

`core-llm-tools` provides a shared, strictly-typed repository of JSON Function Declarations (Tools) for Gemini models. By decoupling the **Tool Interface** (the schema) from the **Tool Implementation** (the executing code), this package allows client-side triage agents and heavy backend cloud agents to share the exact same capabilities without importing Node.js server dependencies into the browser or mobile environments.

It also introduces a robust **Capability-Based Scope Model** (similar to OAuth 2.0), ensuring that Large Language Models are only injected with tools the user has explicitly authorized.

## Features

- **Platform-Agnostic** — Zero runtime dependencies. Pure TypeScript. Compiles safely for Node.js, the browser, and the React Native Hermes engine.
- **Capability-Based Security** — Tools are locked behind specific scopes (e.g., `calendar:read`, `messages:send`). The injector ensures models cannot hallucinate calls to unauthorized tools.
- **Strict Typings** — Provides rigid interfaces (`AgentToolSchema`, `AgentToolManifest`) to prevent malformed Gemini API requests.
- **Harmonized Edge/Cloud Routing** — Enables lightweight edge models (like Gemini Nano) to triage intents using the exact same schemas the heavy Cloud Run backend uses to execute them.

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
import { AgentToolManifest } from '@equationalapplications/core-llm-tools';

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

At runtime, use `buildAuthorizedSchemaArray` to filter your tool library against the user's granted permissions before passing them to the LLM.

```typescript
import { buildAuthorizedSchemaArray, escalateToCloudManifest } from '@equationalapplications/core-llm-tools';

// 1. Gather all manifests known to your app
const allAppTools = [escalateToCloudManifest, getCalendarEventsManifest];

// 2. Fetch the user's authorized scopes from your DB (e.g., SQLite/Postgres)
const userGrantedScopes = ['calendar:read'];

// 3. The injector automatically includes 'core' tools and authorized scoped tools
const schemasForLlm = buildAuthorizedSchemaArray(allAppTools, userGrantedScopes);

// 4. Pass safely to Gemini
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: userInput,
  tools: [{ functionDeclarations: schemasForLlm }],
});
```

## Helpful Resources & Links

- [Google Gen AI: Function Calling Tutorial](https://ai.google.dev/gemini-api/docs/function-calling) — Official docs on how the JSON schemas in this package interact with Gemini models.
- [JSON Schema Specification](https://json-schema.org/understanding-json-schema/) — Structural foundation for `AgentToolSchema.parameters`.
- [OAuth 2.0 Scope Concepts](https://oauth.net/2/scope/) — Inspiration behind the capability-based `AgentScope` permission hierarchy.
- [@google/adk (Agent Development Kit)](https://github.com/google/adk-python) — Server-side framework used by Cloud Run backends to wrap and execute the schemas defined in this package.
