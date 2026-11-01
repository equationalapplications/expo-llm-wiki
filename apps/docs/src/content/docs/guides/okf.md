---
title: OKF import & export
description: Move knowledge in and out as Open Knowledge Format bundles — markdown files with frontmatter that any tool can read.
sidebar:
  order: 14
---

[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
represents a knowledge base as plain markdown files with YAML frontmatter. LLM Wiki exports and
imports OKF **v0.2** (profile `llm-wiki/2`, the default) and can read v0.1 (`llm-wiki/1`) and
older bundles.

## Export

```ts
import { formatOkfBundle } from '@equationalapplications/core-llm-wiki';

const dump = await wiki.exportDump(['user-123']);
const { files } = formatOkfBundle(dump);
// files: Array<{ path: string; content: string }>
// e.g. { path: 'entities/user-123/facts/fact_abc.md', content: '---\n…' }

// Force a v0.1 bundle:
formatOkfBundle(dump, { profile: 'llm-wiki/1' });
```

Write `files` to disk, or zip them (for example with `fflate`) for download.

## Import

```ts
import { parseOkfBundle } from '@equationalapplications/core-llm-wiki';

const dump = parseOkfBundle('user-123', files, {
  defaultSchema: 'fact',
  typeMapping: { custom_type: 'fact', archived: 'ignore' },
});

await wiki.importDump(dump, { merge: true });
```

Each concept is routed to facts or tasks by:

1. `typeMapping` (an OKF `type` mapped to `'fact'`, `'task'`, or `'ignore'`),
2. the directory it's in (`/facts/` or `/tasks/`),
3. `defaultSchema` (`'fact'` by default).

The profile is detected from the root index frontmatter.

:::tip
Imported facts usually have no `okf_type` and no edges from the librarian. Run
[`runOntologyBackfill()`](/expo-llm-wiki/guides/ontologies/#backfill-untyped-facts) after an import
so traversal can reach them.
:::

## Edges and `## Related`

In OKF, edges between concepts are written as a trailing `## Related` section of markdown links.
Parsing turns those into `WikiEdge` rows and strips the section from the stored body. Exporting
writes it back from the dump's `edges`.

## What round-trips

- The literal OKF `type` string is stored in `okf_type` and restored on export.
- The entity summary is persisted (`getEntitySummary(entityId)`) and re-exported.
- The v0.2 trust and provenance fields have their own write methods: `writeOkfTrust`,
  `writeOkfSources`, `setLifecycleStatus`, `setStaleAfter`, and `setGeneratedBy`. Each has a
  `…Task` variant.

## OKF across the ecosystem

OKF is the shared exchange format of the LLM Wiki family.
[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts) backs up and restores
its whole brain as OKF v0.2 zip bundles, and
[Curated Journal](https://github.com/equationalapplications/curated-journal) imports and exports
the same bundles on mobile. If your app produces `llm-wiki/2` bundles, they're in the same format.

## Lower-level primitives

Need to produce OKF from your own data model? Use the zero-dependency
[`@equationalapplications/core-okf`](/expo-llm-wiki/packages/core-okf/) package. The normative
profile spec is in [`docs/okf-profile.md`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/okf-profile.md).
