---
title: MCP server
description: A local stdio MCP server that gives coding agents SynapseTree-backed memory tools.
sidebar:
  order: 7
---

`@equationalapplications/mcp-server` · [source](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/mcp-server)

:::note[In development]
This is the upcoming MCP server for [SynapseTree](https://synapsetree.dev). It isn't released yet.
Want local agent memory today? [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
ships an MCP server and [harness integrations](https://github.com/equationalapplications/curated-thoughts-integrations).
See the [coding agents recipe](/expo-llm-wiki/recipes/coding-agent-mcp/).
:::

A small Node program (Node 20+) that your MCP client launches on your machine. It exposes eight
memory tools and forwards each call to `https://api.synapsetree.dev` with your API key. It
never sees your conversation, only the tool calls.

## Install

:::caution[Not yet on npm]
Publishing is waiting on release gates. For now, build from source:
:::

```bash
git clone https://github.com/equationalapplications/expo-llm-wiki && cd expo-llm-wiki
pnpm install && pnpm --filter @equationalapplications/mcp-server build
cd packages/mcp-server && pnpm link --global
synapsetree-mcp --help
```

## Configure

```bash
synapsetree-mcp auth --email you@example.com        # or: auth --key stree_…
synapsetree-mcp config set namespace repo:myproject
claude mcp add synapsetree -- synapsetree-mcp       # Claude Code
```

The key is stored with mode `0600` in your config directory and is never printed again.

## Tools

| Tool | What it does |
|---|---|
| `memory_search` | Hybrid search over facts, plus pending tasks and recent events |
| `memory_remember` | Store one fact |
| `memory_supersede` | Replace a fact with a corrected one, keeping history |
| `memory_ingest` | Store a document and extract facts from it (requires a BYOK extraction provider) |
| `memory_log_event` | Record an observation, decision, action, or outcome |
| `graph_traverse` | Walk the graph up to three hops |
| `namespaces_list` | List namespaces |
| `whoami` | Account, database, scope, and plan |

## Environment variables

| Variable | Effect |
|---|---|
| `SYNAPSETREE_API_KEY` | Use this key instead of the stored one |
| `SYNAPSETREE_BASE_URL` | API base URL |
| `SYNAPSETREE_NAMESPACE` | Default namespace |
| `SYNAPSETREE_CONFIG_DIR` | Where credentials and config are stored |

It never exports, deletes, or runs maintenance on your memory. Those actions belong to the owner
in the dashboard.
