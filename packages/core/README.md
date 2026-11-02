# @equationalapplications/core-llm-wiki

Platform-agnostic TypeScript engine for hybrid LLM memory. Features episodic fact extraction, semantic vector search, and multi-agent architectures over SQLite. Bring your own adapter.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fcore-llm-wiki?label=core)](https://www.npmjs.com/package/@equationalapplications/core-llm-wiki) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fcore-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/core-llm-wiki)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/LICENSE)

**[📖 Docs](https://equationalapplications.github.io/expo-llm-wiki/)** · **[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

> Inspired by [Andrej Karpathy's LLM Wiki memory spec](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).


**📖 Documentation: [equationalapplications.github.io/expo-llm-wiki/packages/core](https://equationalapplications.github.io/expo-llm-wiki/packages/core/)**. Start with the [Node.js quickstart](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-node/), or go straight to the [API reference](https://equationalapplications.github.io/expo-llm-wiki/reference/wiki-memory/).

## Features

- **Any SQLite driver.** Pure TypeScript with no native code. You pass a small [`SQLiteAdapter`](https://equationalapplications.github.io/expo-llm-wiki/guides/sqlite-adapter/) for `better-sqlite3`, `sql.js`, `expo-sqlite` or anything else.
- **Bring your own inference.** One `generateText` function, plus an optional `embed` for semantic search. The engine owns prompts, JSON parsing and database writes.
- **Hybrid retrieval.** Vector cosine ranking with a keyword fallback (SQLite FTS5 or in-memory MiniSearch), [tunable](https://equationalapplications.github.io/expo-llm-wiki/guides/tune-retrieval/) per call.
- **Multi-entity reads.** Search several namespaces in one pass with `tierWeights` and `tierFloors`.
- **GraphRAG.** Per-entity [seeded ontologies](https://equationalapplications.github.io/expo-llm-wiki/guides/ontologies/) (Strict, Emergent or Off) and SQL-only [graph traversal](https://equationalapplications.github.io/expo-llm-wiki/guides/graphrag/).
- **Background maintenance.** Librarian, heal, reembed and prune jobs, run inline or [deferred](https://equationalapplications.github.io/expo-llm-wiki/guides/maintenance/).
- **Temporal facts, drafts and grounding** for [trust and provenance](https://equationalapplications.github.io/expo-llm-wiki/concepts/trust-and-provenance/).
- **OKF v0.1 and v0.2** [import and export](https://equationalapplications.github.io/expo-llm-wiki/guides/okf/).
- **Diagnostics.** An optional `onDiagnostic` hook with typed, content-free reports.

## Installation

```bash
npm install @equationalapplications/core-llm-wiki
npm install better-sqlite3   # Node.js, or sql.js for the browser
```

Requires Node.js 20 or later. Using Expo or React? Install [`expo-llm-wiki`](https://equationalapplications.github.io/expo-llm-wiki/packages/expo/) or [`react-llm-wiki`](https://equationalapplications.github.io/expo-llm-wiki/packages/react/) instead. Both re-export core.

## Quick look

```ts
import { createWiki, formatContext } from '@equationalapplications/core-llm-wiki';

const wiki = createWiki(adapter, { llmProvider }); // your SQLiteAdapter and LLMProvider
await wiki.setup();

await wiki.write('user-123', { event_type: 'observation', summary: 'Loves hiking on weekends.' });
await wiki.runLibrarian('user-123'); // extract facts from events
const context = formatContext(await wiki.read('user-123', 'weekend plans'));
```

The [Node.js quickstart](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-node/) shows a complete `adapter` and `llmProvider`.

## Monorepo Ecosystem

| Package | Purpose |
| ----- | ----- |
| [**@equationalapplications/core-llm-wiki**](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [@equationalapplications/expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [@equationalapplications/react-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
| [@equationalapplications/prisma-outbox](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/prisma-outbox/README.md) | Sync SQLite outbox events to Prisma |
| [@equationalapplications/core-llm-tools](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/README.md) | Gemini tool schemas and capability injector |
| [@equationalapplications/core-okf](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/okf/README.md) | Zero-dependency Open Knowledge Format (OKF) v0.1 + v0.2 primitives — parse and produce interoperable knowledge bundles. |
| [@equationalapplications/schema-org-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-org/README.md) | Curated schema.org warm-agent ontology manifest |
| [@equationalapplications/schema-software-org](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-software-org/README.md) | Software-organization executive ontology manifest — 17 node types, 40 edges, warm-agent superset, data-only |
| [@equationalapplications/mcp-server](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/mcp-server/README.md) | MCP server exposing SynapseTree memory tools to coding agents |

## License

MIT

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
