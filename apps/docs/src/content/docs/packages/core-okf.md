---
title: core-okf
description: Zero-dependency primitives for parsing and producing Open Knowledge Format v0.1 and v0.2 bundles.
sidebar:
  order: 5
---

`@equationalapplications/core-okf` · [npm](https://www.npmjs.com/package/@equationalapplications/core-okf) · [source](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/okf)

Low-level, database-agnostic building blocks for [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf).
To convert a wiki to and from OKF directly, use `formatOkfBundle` and `parseOkfBundle` from core
instead. See the [OKF guide](/expo-llm-wiki/guides/okf/).

```bash
npm install @equationalapplications/core-okf
```

| Function | Purpose |
|---|---|
| `serializeFrontmatter(obj)` / `parseFrontmatter(text)` | YAML frontmatter, including flow mappings and sequences |
| `buildConceptDocument(fm, body)` / `parseConcept(text)` | Build or split one concept file |
| `buildIndexMd(sections)` / `buildRootIndexMd(version, sections)` | Directory and root indexes |
| `buildLogMd(entries)` / `parseLogMd(text)` | Append-only chronological logs |
| `extractMarkdownLinks(text)` | Relative links → `{ text, path }` (graph edges) |
| `deriveEventId(input)` | Deterministic id for a log line with no id comment ([profile §7](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/okf-profile.md)) |

```ts
const md = buildConceptDocument({ type: 'task', id: 'task_1' }, '# Buy groceries');
const { frontmatter, body } = parseConcept(md);
```

Conformance fixtures are in [`packages/okf/fixtures`](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/okf/fixtures), and the profile spec is in
[`docs/okf-profile.md`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/okf-profile.md).
