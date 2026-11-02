---
title: Introduction
description: What Core LLM Wiki is, what problems it solves, and how the packages fit together.
sidebar:
  order: 1
---

**Core LLM Wiki** is a TypeScript library that gives AI agents persistent, structured, long-term
memory, stored in SQLite. It sits between raw conversation logs and a curated knowledge base:

- You log what happens (**events**) and feed it documents.
- An LLM pass called the **librarian** turns those into durable **facts** and **tasks**.
- At answer time you `read()` the most relevant memory and inject it into your prompt.

It was inspired by [Andrej Karpathy's LLM Wiki idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
"LLM wiki" has since become a general name for that pattern. **Core LLM Wiki** is the name of this
project: a family of packages published under the `@equationalapplications` npm scope, such as
`core-llm-wiki`, `react-llm-wiki`, and `expo-llm-wiki`. Core LLM Wiki can import and export the
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf),
so your knowledge isn't locked in.

## What you get

| Capability | What it means for you |
|---|---|
| **Episodic → semantic memory** | Events consolidate into facts in the background, so you never hand-write a summarizer. |
| **Hybrid retrieval** | Vector search when you provide `embed()`, keyword search otherwise (offline-safe), or a weighted blend. |
| **GraphRAG** | Typed edges between facts, walked with one recursive SQL query. No graph database required. |
| **Multi-entity** | Many independent "brains" in one file (per user, per agent, per tier), readable together with weights. |
| **Provenance** | Every fact records where it came from. Document facts can't be rewritten by the model. |
| **Trust controls** | Draft review, evidence grounding, and lint reports, all opt-in. |
| **Observability** | A typed, content-free `onDiagnostic` stream reports anything the engine drops. |

## The packages

The packages are published from one monorepo and versioned together.

| Package | Use it when… |
|---|---|
| [`@equationalapplications/expo-llm-wiki`](/expo-llm-wiki/packages/expo/) | You're building an Expo / React Native app. |
| [`@equationalapplications/react-llm-wiki`](/expo-llm-wiki/packages/react/) | You're building a React web app. |
| [`@equationalapplications/core-llm-wiki`](/expo-llm-wiki/packages/core/) | You're on Node.js, plain JS, or another framework. This is the engine all the others build on. |
| [`@equationalapplications/core-llm-tools`](/expo-llm-wiki/packages/core-llm-tools/) | You want Gemini function-calling schemas with scope-based authorization. |
| [`@equationalapplications/core-okf`](/expo-llm-wiki/packages/core-okf/) | You need raw OKF parse/produce primitives. |
| [`@equationalapplications/schema-org-llm-wiki`](/expo-llm-wiki/packages/ontologies/) | You want a ready-made schema.org ontology for your graph. |
| [`@equationalapplications/schema-software-org`](/expo-llm-wiki/packages/ontologies/#software-organization) | You want an ontology for a software organization's agent. |
| [`@equationalapplications/prisma-outbox`](/expo-llm-wiki/guides/prisma-outbox/) | You need to sync memory to a Prisma-backed server database. |
| [`@equationalapplications/mcp-server`](/expo-llm-wiki/packages/mcp-server/) | You want to give coding agents (Claude Code, Cursor…) hosted [SynapseTree](https://synapsetree.dev) memory. |

Not sure which package you need? See [Choose a package](/expo-llm-wiki/start/choose-a-package/).

## Used in production

Core LLM Wiki powers [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts),
a desktop second brain whose
[integrations](https://github.com/equationalapplications/curated-thoughts-integrations) share one
memory across your AI agents. It also powers
[Curated Journal](https://github.com/equationalapplications/curated-journal), an offline mobile
journal, and [SynapseTree](https://synapsetree.dev), a hosted cloud memory service. See
[Ecosystem](/expo-llm-wiki/start/ecosystem/).

## Design principles

- **Bring your own inference (BYOI).** The library never ships an LLM client or API key. You
  supply `generateText` and, optionally, `embed`.
- **Namespace safe.** Every table is prefixed (`llm_wiki_` by default), so it can live inside your
  existing app database.
- **No silent failures.** Anything the engine drops (a bad chunk, a rejected fact, a dangling
  edge) can be reported to you through `onDiagnostic`.
- **Safe defaults.** New behavior is opt-in. Upgrading a minor version doesn't change what your
  app stores.
