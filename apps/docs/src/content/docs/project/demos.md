---
title: Live demos
description: Try LLM Wiki in your browser — the WikiDemo playground and the ScopeLab tool-scope explorer.
---

Both demos run entirely in the browser on sql.js, with no backend. You bring your own LLM key.

| Demo | What it shows | Source |
|---|---|---|
| [**WikiDemo**](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/) | Every `react-llm-wiki` hook: write, read, ingest, maintenance, and export | [`apps/wiki-demo`](https://github.com/equationalapplications/expo-llm-wiki/tree/main/apps/wiki-demo) |
| [**ScopeLab**](https://equationalapplications.github.io/expo-llm-wiki/scopelab/) | A client-side LLM tool playground for `core-llm-tools` scopes and memory | [`apps/scopelab`](https://github.com/equationalapplications/expo-llm-wiki/tree/main/apps/scopelab) |

## Real-world apps

These open-source apps are the best end-to-end examples. See [Ecosystem](/expo-llm-wiki/start/ecosystem/).

| App | Platform | Built on |
|---|---|---|
| [Curated Journal](https://github.com/equationalapplications/curated-journal) | iOS and Android (Expo), fully offline | `expo-llm-wiki`, `core-okf` |
| [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts) | macOS, Linux, Windows (Tauri + Rust) | `react-llm-wiki`, ontology packages |
| [Curated Thoughts Integrations](https://github.com/equationalapplications/curated-thoughts-integrations) | Claude Code, OpenCode, Hermes, … | Curated Thoughts MCP |

## Run the demos locally

Run them from the repository root:

```bash
pnpm install
pnpm --filter llm-wiki-playground dev
```

## Benchmarks

Supersession results and run-level token totals for the 7.8.0 release versus the legacy baseline
are in [`docs/benchmarks.md`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/benchmarks.md).
