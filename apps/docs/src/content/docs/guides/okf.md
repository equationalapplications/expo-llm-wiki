---
title: OKF import & export
description: Move knowledge in and out as Open Knowledge Format bundles — markdown files with frontmatter that any tool can read.
sidebar:
  order: 14
---

[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
represents a knowledge base as plain markdown files with YAML frontmatter. Core LLM Wiki exports and
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

Without `merge: true`, `importDump` replaces the entity: it soft-deletes the entity's facts and
tasks and deletes its edges before importing. Stored events are kept.

Each concept is routed to facts or tasks by:

1. `typeMapping` (an OKF `type` mapped to `'fact'`, `'task'`, or `'ignore'`),
2. the directory it's in (`/facts/` or `/tasks/`),
3. `defaultSchema` (`'fact'` by default).

The profile is detected from the root index frontmatter:

| Frontmatter | Parsed as |
|---|---|
| `profile: llm-wiki/2` | v0.2 |
| no `profile`, `okf_version: 0.2` | v0.2 |
| unknown `profile`, `okf_version: 0.2` | v0.2, best effort |
| `profile: llm-wiki/1` | v0.1 |
| no `profile`, `okf_version: 0.1` | v0.1 (legacy) |
| neither field | profile 0 (the oldest legacy format) |

The profile decides two things. Under v0.2, a task's `status` is its lifecycle and its execution
state is in `execution_status`. Under v0.1 and profile 0, `status` is the execution state. And
v0.1 builds edges only from the `## Related` section, while the other formats also turn links in
the body into edges. Trust and provenance fields are read whatever the profile.

:::tip
Imported facts usually have no `okf_type` and no edges from the librarian. Run
[`runOntologyBackfill()`](/expo-llm-wiki/guides/ontologies/#backfill-untyped-facts) after an import
so traversal can reach them.
:::

## Log dates

Log entries are dated by `occurred_at` when it is a usable past date (years 0000-9999, not later than `created_at`), and by `created_at` otherwise. A merge import
re-dates log entries that would sort behind the librarian position to just after the current time, or after the librarian position if that is
later, and keeps the original date in `occurred_at`. OKF bundles carry no source watermark, so every
old entry is treated as not yet read.

## Event ids

Log lines this library exports end with an `<!-- id: … -->` comment. An event whose id is
already stored is skipped on import. A line without a valid id comment (a hand-written log, an
older bundle, or a log run through a formatter that strips HTML comments) gets an id computed from
the entity id, the date, the event type, the summary, and how many identical lines came before it.
Importing that log again then skips every line.

In a summary, `\\`, `\[` and `\]` are escapes: they are stored as `\`, `[` and `]`. Exports write
them that way, and a hand-written log must too, so a path like `\\server` is written `\\\\server`.

Limits:

- The id depends on the summary. Edit a line and it imports as a new event.
- It holds only while the earlier events are stored. After `runPrune()` deletes them, a later
  import stores them again.
- Two cases store one extra copy of each event, once: a store that imported the id-less log with
  a release before derived ids, and a log whose id comments were stripped after its events were
  imported. The librarian reads the copies on its next pass.
- Keep one day's entries in one bundle. Identical lines split across two bundles get the same id,
  and the second is skipped.

The rule is in the [profile, §7](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/okf-profile.md),
and [`deriveEventId`](/expo-llm-wiki/packages/core-okf/) computes it.

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

OKF is the shared exchange format of the Core LLM Wiki family.
[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts) backs up and restores
its whole brain as OKF v0.2 zip bundles, and
[Curated Journal](https://github.com/equationalapplications/curated-journal) imports and exports
the same bundles on mobile. If your app produces `llm-wiki/2` bundles, they're in the same format.

## Lower-level primitives

Need to produce OKF from your own data model? Use the zero-dependency
[`@equationalapplications/core-okf`](/expo-llm-wiki/packages/core-okf/) package. The normative
profile spec is in [`docs/okf-profile.md`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/okf-profile.md).
