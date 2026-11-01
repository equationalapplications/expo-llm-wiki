---
title: Memory for coding agents (MCP)
description: Give Claude Code, Cursor, Windsurf, or Claude Desktop persistent project memory with the SynapseTree MCP server.
sidebar:
  order: 6
---

**Goal:** let your coding agent remember project decisions between sessions.

`@equationalapplications/mcp-server` is a small stdio program that runs **on your machine** and
exposes memory tools that are backed by a hosted SynapseTree store.

:::note
The package isn't on npm yet. Until it's published, build it from source. See
[MCP server](/expo-llm-wiki/packages/mcp-server/#install).
:::

## 1. Authenticate and pick a namespace

```bash
synapsetree-mcp auth --email you@example.com
synapsetree-mcp config set namespace repo:myproject
```

## 2. Connect your client

```bash
claude mcp add synapsetree -- synapsetree-mcp
```

For Cursor, Windsurf, or Claude Desktop:

```json
{ "mcpServers": { "synapsetree": { "command": "synapsetree-mcp" } } }
```

## 3. Tell the agent how to use it

Add something like this to your project's `CLAUDE.md` or `AGENTS.md`:

```md
## Memory
- At the start of a task, call `memory_search` for the area you're touching.
- When you make a decision that future sessions should know, call `memory_remember`.
- When a remembered fact is wrong, call `memory_supersede`. Never delete.
```

## Verify

```bash
synapsetree-mcp status
npx @modelcontextprotocol/inspector synapsetree-mcp
```
