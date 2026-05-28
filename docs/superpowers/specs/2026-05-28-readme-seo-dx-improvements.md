# README SEO & DX Improvements

**Date:** 2026-05-28  
**Scope:** All 6 READMEs (root + 5 packages) + all 5 `package.json` files

---

## Goals

1. Fix broken relative links on the npm registry (no `repository.directory` set)
2. Add nav bar links for GitHub, Playground, Changelog, Issues
3. Improve `keywords` + `description` in `package.json` for npm search discoverability
4. Add Monorepo Ecosystem cross-link table to each package README
5. Improve opening taglines with key search terms (RAG, episodic memory, multi-agent, multi-tiered)
6. Link external dependencies inline at first reference

---

## Section 1 — Nav Bar

Added immediately after the badge block in each README:

```markdown
**[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[Playground](https://equationalapplications.github.io/expo-llm-wiki/playground/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**
```

- `core-llm-tools`: omit Playground link (playground uses `react-llm-wiki`, not tools)
- All other packages: include all four links

---

## Section 2 — package.json Fields

### Repository / bugs / homepage

Add to all 5 package `package.json` files:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/equationalapplications/expo-llm-wiki.git",
  "directory": "packages/<name>"
},
"bugs": {
  "url": "https://github.com/equationalapplications/expo-llm-wiki/issues"
},
"homepage": "https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/<name>#readme"
```

`directory` and `homepage` values per package:

| Package | `directory` | `homepage` |
|---------|------------|-----------|
| `core-llm-wiki` | `packages/core` | `.../tree/main/packages/core#readme` |
| `expo-llm-wiki` | `packages/expo` | `.../tree/main/packages/expo#readme` |
| `react-llm-wiki` | `packages/react` | `.../tree/main/packages/react#readme` |
| `prisma-outbox` | `packages/prisma-outbox` | `.../tree/main/packages/prisma-outbox#readme` |
| `core-llm-tools` | `packages/core-llm-tools` | `.../tree/main/packages/core-llm-tools#readme` |

### description improvements

| Package | New description |
|---------|----------------|
| `core-llm-wiki` | "Platform-agnostic TypeScript engine for hybrid LLM memory. Features episodic fact extraction, semantic vector search, and multi-agent architectures over SQLite. Bring your own adapter." |
| `expo-llm-wiki` | "Local-first LLM memory for Expo and React Native. Combines the core semantic search and extraction engine with expo-sqlite and ready-to-use React hooks." |
| `react-llm-wiki` | "In-browser LLM memory for React web apps. Wraps the core engine with sql.js WebAssembly SQLite for a complete, zero-server RAG experience." |
| `prisma-outbox` | "Sync core-llm-wiki SQLite outbox events to your Prisma-backed database using the transactional outbox pattern — at-least-once delivery with ordering guarantees." |
| `core-llm-tools` | "Zero-dependency Gemini function-calling schemas and capability-scoped tool injection for edge AI agents. Works in Node.js, browser, and React Native (Hermes)." |

### keywords

| Package | Keywords |
|---------|----------|
| `core-llm-wiki` | `llm-memory`, `ai-memory`, `rag`, `sqlite`, `vector-search`, `episodic-memory`, `semantic-memory`, `multi-agent`, `typescript`, `gemini`, `openai` |
| `expo-llm-wiki` | above + `expo`, `react-native`, `expo-sqlite`, `mobile-ai`, `local-first` |
| `react-llm-wiki` | core set + `react`, `react-hooks`, `web-ai`, `sql.js`, `wasm`, `in-browser` |
| `prisma-outbox` | `prisma`, `outbox-pattern`, `transactional-outbox`, `event-sync`, `sqlite-sync`, `at-least-once` |
| `core-llm-tools` | `gemini`, `function-calling`, `tool-schemas`, `llm-tools`, `capability-scopes`, `react-native`, `edge-ai`, `typescript` |

---

## Section 3 — Absolute URL Fixes

Relative links break on npm when `repository.directory` is not set (and even with it, some paths still resolve incorrectly for monorepos). All relative links replaced with absolute GitHub URLs.

| Relative pattern | Absolute form |
|-----------------|---------------|
| `LICENSE` (badge target) | `https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/<pkg>/LICENSE` |
| `SECURITY.md` | `https://github.com/equationalapplications/expo-llm-wiki/blob/main/SECURITY.md` |
| `docs/superpowers/specs/<file>` | `https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/superpowers/specs/<file>` |
| `packages/core/README.md#<anchor>` | `https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md#<anchor>` |
| `#<issue-number>` | `https://github.com/equationalapplications/expo-llm-wiki/issues/<number>` |

---

## Section 4 — Monorepo Ecosystem Section

Added near the bottom of each package README (before footer line). Current package bolded + not linked. Siblings linked to npm.

```markdown
## Monorepo Ecosystem

| Package | Description |
|---------|-------------|
| **`@equationalapplications/core-llm-wiki`** | Pure TypeScript core — DB-agnostic, bring your own SQLite adapter |
| [`@equationalapplications/expo-llm-wiki`](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki) | Expo / React Native adapter with `expo-sqlite` |
| [`@equationalapplications/react-llm-wiki`](https://www.npmjs.com/package/@equationalapplications/react-llm-wiki) | React hooks + web adapter with `sql.js` |
| [`@equationalapplications/prisma-outbox`](https://www.npmjs.com/package/@equationalapplications/prisma-outbox) | Sync SQLite outbox events to Prisma in a transaction |
| [`@equationalapplications/core-llm-tools`](https://www.npmjs.com/package/@equationalapplications/core-llm-tools) | Platform-agnostic Gemini tool schemas + capability scope injector |
```

Each README bolds its own row and links the other four.

---

## Section 5 — Taglines & External Dependency Links

### Opening taglines

| Package | Tagline |
|---------|---------|
| `core-llm-wiki` | "Platform-agnostic TypeScript engine for hybrid LLM memory. Features episodic fact extraction, semantic vector search, and multi-agent architectures over SQLite. Bring your own adapter." |
| `expo-llm-wiki` | "Local-first LLM memory for Expo and React Native. Combines the core semantic search and extraction engine with expo-sqlite and ready-to-use React hooks." |
| `react-llm-wiki` | "In-browser LLM memory for React web apps. Wraps the core engine with sql.js WebAssembly SQLite for a complete, zero-server RAG experience." |
| `prisma-outbox` | "Sync `@equationalapplications/core-llm-wiki` SQLite outbox events to your Prisma-backed database using the transactional outbox pattern — at-least-once delivery with ordering guarantees." |
| `core-llm-tools` | "Zero-dependency Gemini function-calling schemas and capability-scoped tool injection for edge AI agents. Works in Node.js, browser, and React Native (Hermes)." |

### External dependency links (inline, first reference only)

| Dependency | Link |
|-----------|------|
| `sql.js` | https://github.com/sql-js/sql.js |
| `better-sqlite3` | https://github.com/WiseLibs/better-sqlite3 |
| `sqlite-vec` | https://github.com/asg017/sqlite-vec |
| `sqlite-vss` | https://github.com/asg017/sqlite-vss |
| `expo-sqlite` | https://docs.expo.dev/versions/latest/sdk/sqlite/ |
| `MiniSearch` | https://github.com/lucaong/minisearch |

---

## Files Changed

### READMEs
- `README.md` (root) — nav bar + badge label updates already done in kv/tools-docs
- `packages/core/README.md`
- `packages/expo/README.md`
- `packages/react/README.md`
- `packages/prisma-outbox/README.md`
- `packages/core-llm-tools/README.md`

### package.json
- `packages/core/package.json`
- `packages/expo/package.json`
- `packages/react/package.json`
- `packages/prisma-outbox/package.json`
- `packages/core-llm-tools/package.json`
