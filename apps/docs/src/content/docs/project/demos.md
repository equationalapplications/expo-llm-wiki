---
title: Live demos
description: Try LLM Wiki in your browser — the WikiDemo playground and the ScopeLab tool-scope explorer.
---

Both demos run entirely in the browser on sql.js, with no backend. You bring your own LLM key.

| Demo | What it shows | Source |
|---|---|---|
| [**WikiDemo**](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/) | Every `react-llm-wiki` hook: write, read, ingest, maintenance, and export | [`apps/wiki-demo`](https://github.com/equationalapplications/expo-llm-wiki/tree/main/apps/wiki-demo) |
| [**ScopeLab**](https://equationalapplications.github.io/expo-llm-wiki/scopelab/) | A client-side LLM tool playground for `core-llm-tools` scopes and memory | [`apps/scopelab`](https://github.com/equationalapplications/expo-llm-wiki/tree/main/apps/scopelab) |

Run them locally from the repository root:

```bash
pnpm install
pnpm --filter llm-wiki-playground dev
```
