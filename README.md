# expo-llm-wiki

[![GitHub Tag](https://img.shields.io/github/v/tag/equationalapplications/expo-llm-wiki?label=github%20tag)](https://github.com/equationalapplications/expo-llm-wiki/tags)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/LICENSE)

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fexpo-llm-wiki?label=@equationalapplications/expo-llm-wiki)](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fexpo-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki)<br>
[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Freact-llm-wiki?label=@equationalapplications/react-llm-wiki)](https://www.npmjs.com/package/@equationalapplications/react-llm-wiki) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Freact-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/react-llm-wiki)<br>
[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fcore-llm-wiki?label=@equationalapplications/core-llm-wiki)](https://www.npmjs.com/package/@equationalapplications/core-llm-wiki) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fcore-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/core-llm-wiki)<br>
[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fcore-llm-tools?label=@equationalapplications/core-llm-tools)](https://www.npmjs.com/package/@equationalapplications/core-llm-tools) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fcore-llm-tools?label=downloads)](https://www.npmjs.com/package/@equationalapplications/core-llm-tools)<br>
[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fcore-okf?label=@equationalapplications/core-okf)](https://www.npmjs.com/package/@equationalapplications/core-okf) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fcore-okf?label=downloads)](https://www.npmjs.com/package/@equationalapplications/core-okf)<br>
[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fschema-org-llm-wiki?label=@equationalapplications/schema-org-llm-wiki)](https://www.npmjs.com/package/@equationalapplications/schema-org-llm-wiki) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fschema-org-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/schema-org-llm-wiki)<br>
[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fschema-software-org?label=@equationalapplications/schema-software-org)](https://www.npmjs.com/package/@equationalapplications/schema-software-org) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fschema-software-org?label=downloads)](https://www.npmjs.com/package/@equationalapplications/schema-software-org)<br>
[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fmcp-server?label=@equationalapplications/mcp-server)](https://www.npmjs.com/package/@equationalapplications/mcp-server) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fmcp-server?label=downloads)](https://www.npmjs.com/package/@equationalapplications/mcp-server)

**[📖 Docs](https://equationalapplications.github.io/expo-llm-wiki/)** · **[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

## Persistent, episodic memory for AI agents

Core LLM Wiki is a family of cross-platform TypeScript packages for long-term LLM memory, built on SQLite. It turns raw conversation logs and documents into a structured knowledge base of facts, tasks and graph edges, with fact extraction, semantic search and memory pruning. It runs wherever your app runs: Expo, React Native, the browser, or Node.js.

> Inspired by [Andrej Karpathy's LLM Wiki memory spec](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Supports [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) import and export.

**📖 Full documentation: [equationalapplications.github.io/expo-llm-wiki](https://equationalapplications.github.io/expo-llm-wiki/)**. It has quickstarts, guides, recipes and the complete API reference.

## Why Core LLM Wiki?

- **Bring your own inference.** You provide one `generateText` function. The library builds the prompts, parses the JSON and writes to the database. Works with OpenAI, Gemini, Claude or a local model.
- **Just SQLite.** Facts, vectors and graph edges live in prefixed tables (`llm_wiki_` by default) in your own database. No vector database, no Neo4j.
- **Offline first.** Keyword search runs in-process. Semantic search turns on when you provide `embed()` and falls back to keyword search when the network is down.
- **GraphRAG built in.** Optional seeded ontologies make the model emit typed edges, and `traverseGraph()` walks them with a single recursive SQL query.
- **Multi-entity.** Many independent "brains" in one database, with weighted reads across them.
- **Trust and provenance.** Document facts are protected from rewriting, unreviewed facts can be held as drafts, and opt-in grounding checks that facts quote their source.
- **No silent failures.** An optional `onDiagnostic` hook reports what would otherwise be dropped, with typed, content-free reports.

## Quick start

Pick the package for your platform:

```bash
# Expo / React Native
npx expo install expo-sqlite expo-crypto
npm install @equationalapplications/expo-llm-wiki

# React (web)
npm install @equationalapplications/react-llm-wiki sql.js

# Node.js or any other JavaScript runtime
npm install @equationalapplications/core-llm-wiki better-sqlite3   # or sql.js
```

Use `npx expo install` for the Expo packages so Expo picks native builds that match your SDK. `expo-llm-wiki` wires up `expo-crypto` for you, so Hermes needs no `crypto` polyfill. `core-llm-wiki` and `react-llm-wiki` require Node.js 20 or later.

Then, three lines to memory:

```ts
import { formatContext } from '@equationalapplications/core-llm-wiki'; // also exported by the expo and react packages

await wiki.write('user-123', { event_type: 'observation', summary: 'Loves hiking on weekends.' });
const memory = await wiki.read('user-123', 'what should we do on Saturday?');
const context = formatContext(memory); // → paste into your system prompt
```

Follow the quickstart for your platform to create `wiki`: [Expo](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-expo/) · [React](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-react/) · [Node.js](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-node/)

## Packages

| Package | Purpose | Docs |
|---|---|---|
| [`@equationalapplications/core-llm-wiki`](packages/core) | The memory engine. Any SQLite driver, any platform. | [core](https://equationalapplications.github.io/expo-llm-wiki/packages/core/) |
| [`@equationalapplications/expo-llm-wiki`](packages/expo) | Core plus `expo-sqlite`, `expo-crypto` and React hooks | [expo](https://equationalapplications.github.io/expo-llm-wiki/packages/expo/) |
| [`@equationalapplications/react-llm-wiki`](packages/react) | React hooks and provider for web apps | [react](https://equationalapplications.github.io/expo-llm-wiki/packages/react/) |
| [`@equationalapplications/core-llm-tools`](packages/core-llm-tools) | Gemini tool schemas and a capability-scoped injector | [core-llm-tools](https://equationalapplications.github.io/expo-llm-wiki/packages/core-llm-tools/) |
| [`@equationalapplications/core-okf`](packages/okf) | Zero-dependency OKF v0.1 and v0.2 primitives | [core-okf](https://equationalapplications.github.io/expo-llm-wiki/packages/core-okf/) |
| [`@equationalapplications/schema-org-llm-wiki`](packages/schema-org) | Curated schema.org ontology manifest (data only) | [ontologies](https://equationalapplications.github.io/expo-llm-wiki/packages/ontologies/) |
| [`@equationalapplications/schema-software-org`](packages/schema-software-org) | Software-organization ontology manifest (data only) | [ontologies](https://equationalapplications.github.io/expo-llm-wiki/packages/ontologies/) |
| [`@equationalapplications/prisma-outbox`](packages/prisma-outbox) | Sync SQLite outbox events to a Prisma database | [guide](https://equationalapplications.github.io/expo-llm-wiki/guides/prisma-outbox/) |
| [`@equationalapplications/mcp-server`](packages/mcp-server) | MCP server giving coding agents a SynapseTree memory | [mcp-server](https://equationalapplications.github.io/expo-llm-wiki/packages/mcp-server/) |

Not sure which one you need? See [Choose a package](https://equationalapplications.github.io/expo-llm-wiki/start/choose-a-package/).

## Live demos

- **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** exercises every `react-llm-wiki` hook in the browser.
- **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** is a client-side playground for `core-llm-tools` scopes and memory.

Both run on sql.js with no backend. You bring your own LLM key.

## More documentation

- [How memory works](https://equationalapplications.github.io/expo-llm-wiki/concepts/how-it-works/) · [Retrieval](https://equationalapplications.github.io/expo-llm-wiki/concepts/retrieval/) · [GraphRAG](https://equationalapplications.github.io/expo-llm-wiki/guides/graphrag/) · [API reference](https://equationalapplications.github.io/expo-llm-wiki/reference/wiki-memory/)
- [Security](https://equationalapplications.github.io/expo-llm-wiki/project/security/), including the prompt-injection trust boundary and GDPR deletion. To report a vulnerability, see [SECURITY.md](SECURITY.md).
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)
- [SynapseTree integration guide](docs/synapsetree-integration.md) for tenant-aware hosts
- [Benchmarks](docs/benchmarks.md)

## Ecosystem

Built on Core LLM Wiki:

- **[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)**: a privacy-first desktop second brain (Tauri, React, Rust) with a built-in MCP server.
- **[Curated Thoughts Integrations](https://github.com/equationalapplications/curated-thoughts-integrations)**: wires Curated Thoughts into Claude Code, OpenCode, Hermes, and other agent harnesses. A software agency in a box.
- **[Curated Journal](https://github.com/equationalapplications/curated-journal)**: a fully offline Expo journal, and the reference app for `expo-llm-wiki`.
- **[SynapseTree](https://synapsetree.dev)**: hosted cloud memory on the same engine. Its MCP server is [`@equationalapplications/mcp-server`](packages/mcp-server).

## License

MIT

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
