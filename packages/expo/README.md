# @equationalapplications/expo-llm-wiki

Local-first LLM memory for Expo and React Native. Combines the core semantic search and extraction engine with [`expo-sqlite`](https://docs.expo.dev/versions/latest/sdk/sqlite/) and ready-to-use React hooks.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fexpo-llm-wiki?label=npm)](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki)
[![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fexpo-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/LICENSE)

**[📖 Docs](https://equationalapplications.github.io/expo-llm-wiki/)** · **[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

> Inspired by [Andrej Karpathy's LLM Wiki memory spec](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

**📖 Documentation: [equationalapplications.github.io/expo-llm-wiki/packages/expo](https://equationalapplications.github.io/expo-llm-wiki/packages/expo/)**. Start with the [Expo quickstart](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-expo/).

## Features

- **Expo-ready.** Core plus an `expo-sqlite` adapter, so there's nothing to wire up.
- **Hermes-ready.** Secure record IDs through [`expo-crypto`](https://docs.expo.dev/versions/latest/sdk/crypto/), registered automatically on import. No `crypto` polyfill needed.
- **React hooks.** `WikiProvider`, `useMemoryRead`, `useWikiTraversal` and the rest of [`react-llm-wiki`](https://equationalapplications.github.io/expo-llm-wiki/reference/hooks/), re-exported.
- **Everything in core.** Semantic and keyword search, multi-entity reads, seeded ontologies and [GraphRAG](https://equationalapplications.github.io/expo-llm-wiki/guides/graphrag/), background maintenance, and OKF import and export.

## Installation

```bash
npx expo install expo-sqlite expo-crypto
npm install @equationalapplications/expo-llm-wiki
```

Use `npx expo install` so Expo picks native builds that match your SDK.

| Peer dependency | Range |
|---|---|
| `expo-sqlite` | `^14 \|\| ^15 \|\| ^55 \|\| ^56 \|\| ^57 \|\| ^58` |
| `expo-crypto` | `>=12` |
| `react` | `>=17` |

## Quick look

```tsx
import * as SQLite from 'expo-sqlite';
import { createWiki, WikiProvider, useMemoryRead } from '@equationalapplications/expo-llm-wiki';

const db = await SQLite.openDatabaseAsync('app.db');
const wiki = createWiki(db, { llmProvider }); // pass the expo-sqlite database directly
await wiki.setup();

function App() {
  const { data, isPending } = useMemoryRead('user-123', 'preferences');
  // ...
}

// <WikiProvider wiki={wiki}><App /></WikiProvider>
```

See the [Expo quickstart](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-expo/) for a complete app, including the `llmProvider`. On React Native, give `embed` an absolute URL.

## Monorepo Ecosystem

| Package | Purpose |
| ----- | ----- |
| [@equationalapplications/core-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [**@equationalapplications/expo-llm-wiki**](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [@equationalapplications/react-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
| [@equationalapplications/prisma-outbox](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/prisma-outbox/README.md) | Sync SQLite outbox events to Prisma |
| [@equationalapplications/core-llm-tools](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/README.md) | Gemini tool schemas and capability injector |
| [@equationalapplications/core-okf](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/okf/README.md) | Zero-dependency Open Knowledge Format (OKF) v0.1 + v0.2 primitives — parse and produce interoperable knowledge bundles. |
| [@equationalapplications/schema-org-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-org/README.md) | Curated schema.org warm-agent ontology manifest |
| [@equationalapplications/schema-software-org](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-software-org/README.md) | Software-organization executive ontology manifest — 21 node types, 42 edges, warm-agent superset, data-only |
| [@equationalapplications/mcp-server](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/mcp-server/README.md) | MCP server exposing SynapseTree memory tools to coding agents |

## License

MIT

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
