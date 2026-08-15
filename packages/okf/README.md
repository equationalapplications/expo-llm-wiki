# @equationalapplications/core-okf

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fcore-okf?label=core-okf)](https://www.npmjs.com/package/@equationalapplications/core-okf) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fcore-okf?label=downloads)](https://www.npmjs.com/package/@equationalapplications/core-okf)

## Overview

A zero-dependency library for parsing and producing [Open Knowledge Format (OKF) v0.1 and v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundles. This package provides the raw primitives to work with OKF frontmatter, concept documents, and index/log files, completely decoupled from any specific database or data model.

For a ready-made `MemoryDump` ⇄ OKF bundle adapter, see the [OKF Import/Export section in `@equationalapplications/core-llm-wiki`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md#okf-importexport).

For the llm-wiki interoperability profiles (`llm-wiki/1` and `llm-wiki/2`), see [`docs/okf-profile.md`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/okf-profile.md). Conformance fixtures live in [`fixtures/`](./fixtures/).

## Installation

```bash
npm install @equationalapplications/core-okf
```

## API Reference

### `serializeFrontmatter` / `parseFrontmatter`

Produces and parses YAML frontmatter for OKF concept documents.

```typescript
const yaml = serializeFrontmatter({ type: 'fact', id: 'fact_123' });
const { frontmatter, rest } = parseFrontmatter(fileContent);
```

### `buildConceptDocument` / `parseConcept`

Combines frontmatter and markdown body into a single string, or splits an existing OKF file into its component parts.

```typescript
const markdown = buildConceptDocument({ type: 'task', id: 'task_1' }, '# Buy groceries');
const { frontmatter, body } = parseConcept(markdown);
```

### `buildIndexMd` / `buildRootIndexMd`

Generates directory index lists or root OKF catalog manifests.

```typescript
const sections = [{ heading: 'Facts', entries: [{ path: 'facts/fact_123.md', title: 'Fact 123' }] }];
const dirIndex = buildIndexMd(sections);
const rootIndex = buildRootIndexMd('0.1', sections);
```

### `buildLogMd` / `parseLogMd`

Serializes chronological append-only events or parses them back into discrete entries.

```typescript
const log = buildLogMd([{ date: '2026-06-23', text: 'Observation made' }]);
const events = parseLogMd(logContent);
```

### `extractMarkdownLinks`

Parses relative markdown cross-links to map knowledge graph edges.

```typescript
const links = extractMarkdownLinks('See [preferences](facts/fact_abc.md) for more.');
// links: [{ text: 'preferences', path: 'facts/fact_abc.md' }]
```

## Monorepo Ecosystem

| Package | Purpose |
| --- | --- |
| [@equationalapplications/core-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [@equationalapplications/expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [@equationalapplications/react-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
| [@equationalapplications/prisma-outbox](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/prisma-outbox/README.md) | Sync SQLite outbox events to Prisma |
| [@equationalapplications/core-llm-tools](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/README.md) | Gemini tool schemas and capability injector |
| [**@equationalapplications/core-okf**](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/okf/README.md) | Zero-dependency Open Knowledge Format (OKF) v0.1 primitives — parse and produce interoperable knowledge bundles. |
| [@equationalapplications/schema-org-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-org/README.md) | Curated schema.org warm-agent ontology manifest |

## OKF v0.2 conformance

This package conforms to [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md). New helpers for v0.2:

- `deriveTrustTier(verified)` — derive `'unverified' | 'machine-confirmed' | 'human-reviewed'`.
- `isStaleAfter(staleAfter, now)` — staleness check against an absolute `YYYY-MM-DD` cutoff.
- `parseVerifiedFlexible(value)` — accept either an array or a bare `{ by, at }` mapping.
- `extractFootnotes(body)` / `serializeFootnotes(footnotes)` — preserve footnote attribution verbatim.
- `parseFlowMapping(text)` / `parseFlowSequence(text)` — flow parsing with at most one level of mapping-value nesting (no anchors/aliases outside quoted strings).

The `serializeFrontmatter` function emits plain objects as flow mappings and actor strings (containing `/` or `:`) via `serializeActorString`. Anchor/alias expansion is rejected; only **unquoted** `&` or `*` characters are treated as opaque (quoted spans are excluded from the scan, so URL query strings like `"https://x/a?p=1&q=2"` remain valid).
