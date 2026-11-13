# @equationalapplications/mcp-server

SynapseTree memory for coding agents: an MCP server that lets Claude Code, Cursor, Windsurf, Claude Desktop, or any MCP client search, remember, supersede, ingest, log events, and walk the knowledge graph in your [SynapseTree](https://synapsetree.dev) database.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fmcp-server?label=mcp-server)](https://www.npmjs.com/package/@equationalapplications/mcp-server)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/mcp-server/LICENSE)

**[📖 Docs](https://equationalapplications.github.io/expo-llm-wiki/)** · **[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

## What it is

A small Node program your MCP client launches on your own machine over stdio. It exposes eight SynapseTree memory operations as tools and forwards each call to `https://api.synapsetree.dev` with your API key. It stores nothing but that key, a base URL, and a default namespace. It never runs in anyone's cloud, and it never sees your conversation with the model — only tool calls.

## Install

```bash
npm install -g @equationalapplications/mcp-server
```

Node 20 or newer. One command is installed: `synapsetree-mcp`.

To run from source instead:

```bash
git clone https://github.com/equationalapplications/expo-llm-wiki && cd expo-llm-wiki
pnpm install && pnpm --filter @equationalapplications/mcp-server build
cd packages/mcp-server && pnpm link --global   # puts synapsetree-mcp on PATH
```

## Get a key

**From the dashboard.** Sign in at https://synapsetree.dev/dashboard, open *API keys*, issue a key next to your database, then:

```bash
synapsetree-mcp auth --key stree_…
```

The `--key` form puts the secret in your shell history and process list. To
keep it out of both, read it silently and export it for the session:

```bash
read -rs SYNAPSETREE_API_KEY && export SYNAPSETREE_API_KEY
```

`synapsetree-mcp status` picks it up and `auth --revoke` still works.

**By email, from the terminal** (the [auth.md](https://synapsetree.dev/auth.md) flow):

```bash
synapsetree-mcp auth --email you@example.com
```

A six-digit code is printed. SynapseTree emails you an approval link within about a minute; the page shows the same code. Approve only if the codes match. The link expires after 15 minutes. The first poll after approval receives the only copy of the key and stores it.

The key is stored in `credentials.json` under your config directory with mode `0600` and is never printed again; `status` shows the last four characters.

## Set a namespace

Every memory tool needs a namespace. Set a default once per machine, or pass `namespace` on each call:

```bash
synapsetree-mcp config set namespace repo:myproject
```

Convention: `repo:<directory name>`. The server never invents a namespace.

## Connect your client

Claude Code:

```bash
claude mcp add synapsetree -- synapsetree-mcp
```

Cursor (`.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "synapsetree": { "command": "synapsetree-mcp" } } }
```

## Tools

| Tool | What it does |
|---|---|
| `memory_search` | Hybrid search over facts; also returns pending tasks and recent events. Keyword-only until the account owner registers an embeddings provider (`diagnostics.keyword_only`). |
| `memory_remember` | Store one fact (title, body, tags, confidence, type). Works with no provider. |
| `memory_supersede` | Replace a fact with a corrected one; history is kept. Never deletes. |
| `memory_ingest` | Store a whole document and let SynapseTree extract facts. Needs an extraction provider registered in the dashboard (BYOK). |
| `memory_log_event` | Record an observation, decision, action, or outcome. |
| `graph_traverse` | Walk the knowledge graph from a fact or node, up to three hops. |
| `namespaces_list` | List namespaces, optionally by prefix. |
| `whoami` | Account, database, scope, plan, subscription status. |

## Environment variables

| Variable | Effect |
|---|---|
| `SYNAPSETREE_API_KEY` | Use this key instead of the stored one. |
| `SYNAPSETREE_BASE_URL` | API base URL (default `https://api.synapsetree.dev`). |
| `SYNAPSETREE_NAMESPACE` | Default namespace, overriding `config.json`. |
| `SYNAPSETREE_CONFIG_DIR` | Where `credentials.json` and `config.json` live. |

Default config directory: macOS `~/Library/Application Support/synapsetree`, Linux `$XDG_CONFIG_HOME/synapsetree` or `~/.config/synapsetree`, Windows `%APPDATA%\synapsetree`. On Windows the `0600`/`0700` file modes are best-effort.

## What it never does

- Export, delete, or run maintenance on your memory. Those are owner actions in the dashboard, and this server does not expose them even if your key could.
- Print your key, or the claim token used during email registration.
- Run anywhere but your machine. Memories go only to SynapseTree; SynapseTree calls an inference provider only if the account owner registered one.

## Verify

```bash
synapsetree-mcp status
npx @modelcontextprotocol/inspector synapsetree-mcp
```

## Release checklist (maintainers)

Before publishing a version, run the whole sequence against the SynapseTree
**test** stage with a dashboard key and an isolated config directory, so no
step can touch your real credentials:

```bash
unset SYNAPSETREE_API_KEY                            # an inherited key would take
                                                     # precedence over the isolated
                                                     # credentials file below
export SYNAPSETREE_BASE_URL=https://test-stage…      # the test stage, for EVERY step below
export SYNAPSETREE_CONFIG_DIR=$(mktemp -d)           # isolated credentials
export SYNAPSETREE_LIVE_TESTS=1                      # opts the live chain into `pnpm test`
cd "$(git rev-parse --show-toplevel)"                 # back to the repo root: all paths below are repo-root paths
CLI="$(pwd)/packages/mcp-server/dist/cli.js"    # the CLI built from this checkout, not a global install
pnpm build
```

1. `node "$CLI" auth --key …` then `node "$CLI" status`.
2. `SYNAPSETREE_API_KEY=… pnpm --filter @equationalapplications/mcp-server test` — runs the live chain (`whoami` → remember → search → supersede → search → log event → list). The suite is excluded unless `SYNAPSETREE_LIVE_TESTS=1` is set.
3. `npx @modelcontextprotocol/inspector node "$CLI" serve` and run one `memory_search`.
4. `node "$CLI" auth --email …` once, approve the email, then `node "$CLI" auth --revoke`.

The vendored contract in `contract/` is generated in the SynapseTree repository and must not be hand-edited; the unit tests fail if it drifts from what the tools send or if it ever contains an owner-only operation.

## Monorepo Ecosystem

| Package | Purpose |
| ----- | ----- |
| [@equationalapplications/core-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [@equationalapplications/expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [@equationalapplications/react-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
| [@equationalapplications/prisma-outbox](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/prisma-outbox/README.md) | Sync SQLite outbox events to Prisma |
| [@equationalapplications/core-llm-tools](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/README.md) | Gemini tool schemas and capability injector |
| [@equationalapplications/core-okf](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/okf/README.md) | Zero-dependency Open Knowledge Format (OKF) v0.1 + v0.2 primitives — parse and produce interoperable knowledge bundles. |
| [@equationalapplications/schema-org-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-org/README.md) | Curated schema.org warm-agent ontology manifest |
| [@equationalapplications/schema-software-org](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-software-org/README.md) | Software-organization executive ontology manifest — 21 node types, 42 edges, warm-agent superset, data-only |
| [**@equationalapplications/mcp-server**](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/mcp-server/README.md) | MCP server exposing SynapseTree memory tools to coding agents |

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
