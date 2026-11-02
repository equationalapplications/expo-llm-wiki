---
title: core-llm-wiki
description: The platform-agnostic memory engine. Zero runtime dependencies, any SQLite driver.
sidebar:
  order: 1
---

`@equationalapplications/core-llm-wiki` · [npm](https://www.npmjs.com/package/@equationalapplications/core-llm-wiki) · [source](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/core)

The engine every other package builds on. Pure TypeScript with **zero runtime dependencies**. You
bring a [SQLite adapter](/expo-llm-wiki/guides/sqlite-adapter/) and an
[LLM provider](/expo-llm-wiki/guides/llm-provider/).

```bash
npm install @equationalapplications/core-llm-wiki
```

```ts
import { createWiki, formatContext } from '@equationalapplications/core-llm-wiki';

const wiki = createWiki(adapter, { llmProvider });   // same as: new WikiMemory(adapter, { llmProvider })
await wiki.setup();
```

## Main exports

| Export | Kind | See |
|---|---|---|
| `createWiki`, `WikiMemory` | Factory and class | [WikiMemory API](/expo-llm-wiki/reference/wiki-memory/) |
| `formatContext`, `formatGraphContext`, `formatMemoryDump` | Prompt formatters | [Tune retrieval](/expo-llm-wiki/guides/tune-retrieval/#format-for-your-prompt) |
| `formatOkfBundle`, `parseOkfBundle` | OKF adapters | [OKF](/expo-llm-wiki/guides/okf/) |
| `chunkText`, `safeSlice`, `DEFAULT_MAX_CHUNK_LENGTH`, `DEFAULT_CHUNK_OVERLAP` | Chunking utilities | [Ingest](/expo-llm-wiki/guides/ingest-documents/#chunking-options) |
| `validateManifest` | Ontology validation | [Ontologies](/expo-llm-wiki/guides/ontologies/) |
| `configureRandomSource` | Platform setup | [Adapter](/expo-llm-wiki/guides/sqlite-adapter/#random-ids-on-react-native) |
| `hydrateLibrarianPrompt`, `mapLibrarianOptionsToReadOptions`, `validateLibrarianPromptTemplate`, `DEFAULT_LIBRARIAN_SYNTHESIS_PROMPT` | Prompt helpers | [Multi-entity](/expo-llm-wiki/guides/multi-entity/#librarian-synthesis-helpers) |
| `Wiki*Error` classes | Errors | [Errors](/expo-llm-wiki/reference/errors/) |
| All types (`WikiFact`, `MemoryBundle`, `WikiConfig`, …) | Types | [Types](/expo-llm-wiki/reference/types/) |
