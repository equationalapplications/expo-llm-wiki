# @equationalapplications/react-llm-wiki

In-browser LLM memory for React web apps. Bring your own SQLite adapter (e.g., [`sql.js`](https://github.com/sql-js/sql.js) WebAssembly) for a complete, zero-server RAG experience.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Freact-llm-wiki?label=react)](https://www.npmjs.com/package/@equationalapplications/react-llm-wiki) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Freact-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/react-llm-wiki)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/LICENSE)

**[📖 Docs](https://equationalapplications.github.io/expo-llm-wiki/)** · **[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

> Inspired by [Andrej Karpathy's LLM Wiki memory spec](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

**📖 Documentation: [equationalapplications.github.io/expo-llm-wiki/packages/react](https://equationalapplications.github.io/expo-llm-wiki/packages/react/)**. Start with the [React quickstart](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-react/), or see the [hooks reference](https://equationalapplications.github.io/expo-llm-wiki/reference/hooks/).

## Features

- **Runs in the browser.** SQLite compiled to WebAssembly ([`sql.js`](https://github.com/sql-js/sql.js)) means no server is needed. Any other `SQLiteAdapter` works too.
- **Reactive reads.** `useMemoryRead` refetches when the entity, query or options change.
- **Mutation hooks.** `useWikiWrite`, `useWikiIngest`, `useWikiForget`, `useWikiMaintenance`, `useWikiExport` and more.
- **GraphRAG.** `useWikiTraversal` plus `formatGraphContext` for prompt-ready graph context, and `useOntologyManifest` / `useSetOntologyManifest` for [seeded ontologies](https://equationalapplications.github.io/expo-llm-wiki/guides/ontologies/).
- **Live job status** with `useEntityStatus`.
- **Everything in core**, re-exported in full.

## Installation

```bash
npm install @equationalapplications/react-llm-wiki sql.js
```

Peer dependency: `react >=17`. Requires Node.js 20 or later for tooling and server-side use.

## Quick look

```tsx
import { WikiProvider, useMemoryRead } from '@equationalapplications/react-llm-wiki';

function Preferences() {
  const { data, isPending, error } = useMemoryRead('user-123', 'preferences');
  if (isPending) return <p>Loading…</p>;
  if (error) return <p>{error.message}</p>;
  return <ul>{data?.facts.map((f) => <li key={f.id}>{f.title}</li>)}</ul>;
}
```

The [React quickstart](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-react/) shows the sql.js adapter and `WikiProvider` setup. Not using React? See [vanilla JavaScript](https://equationalapplications.github.io/expo-llm-wiki/start/quickstart-react/#not-using-react).

## Monorepo Ecosystem

| Package | Purpose |
| ----- | ----- |
| [@equationalapplications/core-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [@equationalapplications/expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [**@equationalapplications/react-llm-wiki**](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
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
