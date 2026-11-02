---
title: react-llm-wiki
description: React hooks and a context provider for Core LLM Wiki, for any React app with any SQLite adapter.
sidebar:
  order: 3
---

`@equationalapplications/react-llm-wiki` · [npm](https://www.npmjs.com/package/@equationalapplications/react-llm-wiki) · [source](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/react)

```bash
npm install @equationalapplications/react-llm-wiki sql.js
```

Adds `WikiProvider`, `useWiki`, and a set of hooks on top of core. Core is re-exported in full.

| Hook | Purpose |
|---|---|
| `useMemoryRead` | Reactive `read()` |
| `useWikiWrite` | Log events |
| `useWikiIngest` | Ingest documents |
| `useWikiForget` | Delete |
| `useWikiMaintenance` | Librarian, heal, reembed, prune |
| `useWikiHasChanged` | Change detection |
| `useWikiExport` | Export a `MemoryDump` |
| `useEntityStatus` | Live job status |
| `useOntologyManifest` / `useSetOntologyManifest` | Read and set ontologies |
| `useWikiTraversal` | Reactive graph traversal |

Full signatures: [React hooks reference](/expo-llm-wiki/reference/hooks/). Start with the
[React quickstart](/expo-llm-wiki/start/quickstart-react/).
