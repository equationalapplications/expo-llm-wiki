# Design: Open Knowledge Format (OKF) Export

**Status:** Implemented
**Packages:** new `@equationalapplications/core-okf` (`packages/okf`); `packages/core` adapter
**Date:** 2026-06-18
**Spec reference:** Open Knowledge Format v0.1, https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md

## Problem

OKF v0.1 is a vendor-neutral spec for representing knowledge as a directory of markdown files
with YAML frontmatter, where the file path is the concept's identity. `expo-llm-wiki`'s
`WikiMemory` already models knowledge as facts/tasks/events per entity and already exports it
(`exportDump()` → JSON `MemoryDump`, optionally rendered to human-readable markdown via
`formatMemoryDump()`). Neither existing export is OKF-compliant: `formatMemoryDump()` produces
one combined markdown file per entity with no frontmatter and no per-concept addressability.
Producing a real OKF bundle would let users open their wiki memory in any OKF-aware tool,
editor, or visualizer, and host it as a plain git repo.

## Goals

- Add an OKF-compliant export path: `MemoryDump` → a flat list of `{ path, content }` files
  forming a valid OKF bundle (root `index.md`, per-entity `index.md`/`log.md`/concept files).
- Build the OKF-generic parts (frontmatter serialization, concept/index/log builders) as a
  standalone, zero-dependency package with no knowledge of this wiki's data model, so other
  projects in (or outside) this monorepo can produce/consume OKF bundles without depending on
  `core-llm-wiki`.
- Conform to the v0.1 normative rules: `type` is the only required frontmatter key; `index.md`
  files carry no frontmatter except the bundle root, which may declare `okf_version: "0.1"`;
  `log.md` uses ISO 8601 `YYYY-MM-DD` date headings, newest first; reserved filenames `index.md`
  and `log.md` are never used as concept files.

## Non-Goals

- **No import.** Reading a foreign OKF bundle back into `WikiMemory` requires deciding how
  arbitrary third-party `type` values map to facts/tasks/events — a separate, larger problem.
  This spec is export-only.
- **No archiving.** Output is a flat file list, same shape as `formatMemoryDump`'s existing
  `files[]`. No tar/zip dependency is introduced — no current consumer of `formatMemoryDump`
  archives its output either (`ExportTab.tsx` renders it directly); packaging into an archive is
  a UI-layer concern left to callers.
- **No changes to `exportDump()` / `importDump()` / `ImportExportService`.** The OKF export is
  an additional, alternate formatting function alongside `formatMemoryDump`, not a replacement.

## Design

### 1. `packages/okf` (`@equationalapplications/core-okf`) — generic OKF primitives

New zero-dependency package, structured like `core-llm-tools`. No knowledge of `WikiFact`,
`WikiTask`, or `WikiEvent`.

**`src/types.ts`**

```ts
export interface OkfFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string; // ISO 8601
  [key: string]: unknown; // producers may add custom keys; consumers must preserve them
}

export interface OkfIndexEntry {
  path: string; // bundle-relative, e.g. 'entities/alice/facts/fact_123.md'
  title: string;
  description?: string;
}

export interface OkfIndexSection {
  heading: string; // e.g. 'Facts'
  entries: OkfIndexEntry[];
}

export interface OkfLogEntry {
  date: string; // ISO 8601 YYYY-MM-DD, used for grouping/heading
  text: string; // rendered line content; may include a markdown link
}

export interface OkfFile {
  path: string;
  content: string;
}
```

**`src/frontmatter.ts`**

```ts
export function serializeFrontmatter(fm: OkfFrontmatter): string;
```

Emits a `---\n...\n---\n` YAML block. Supports the value shapes frontmatter actually needs:
string, number, boolean, null scalars, and `string[]` (rendered as a block list). Quotes a
string value when it contains `:`, `#`, leading/trailing whitespace, or would otherwise parse
as a YAML bool/null/number literal (e.g. a tag literally named `"true"`).

**`src/concept.ts`**

```ts
export function buildConceptDocument(fm: OkfFrontmatter, body: string): string;
```

Concatenates the serialized frontmatter block and the body. `type` is the only field this
function requires to be present (enforced by `OkfFrontmatter.type` being non-optional) — matches
the spec's "minimally opinionated" requirement.

**`src/index-md.ts`**

```ts
export function buildIndexMd(sections: OkfIndexSection[]): string;
export function buildRootIndexMd(okfVersion: string, sections: OkfIndexSection[]): string;
```

`buildIndexMd` renders `## <heading>` per section and `* [title](path) - description` (or
`* [title](path)` when `description` is absent) per entry, no frontmatter. `buildRootIndexMd`
wraps the same body in a frontmatter block containing only `okf_version` — the one normative
exception where an `index.md` may carry frontmatter.

**`src/log-md.ts`**

```ts
export function buildLogMd(entries: OkfLogEntry[]): string;
```

Groups entries by `date`, sorts groups descending (newest first), renders `## YYYY-MM-DD` per
group and `- <text>` per entry underneath, in the order given within each group.

**`src/index.ts`** — barrel export of all of the above.

### 2. `packages/core/src/utils/formatOkfBundle.ts` — wiki adapter

Maps a `MemoryDump` to an OKF bundle using `core-okf`'s primitives. New file, parallel to the
existing `formatMemoryDump.ts`.

**Shared sanitizer:** `formatMemoryDump.ts`'s entity-directory-name sanitization
(`formatEntityFileName`'s internal logic, currently inlined) is extracted to a shared
`sanitizeForFilename(value: string): string` helper (new file
`packages/core/src/utils/sanitizeForFilename.ts`) and reused by both formatters — same
collision-hash/length-limit behavior as today, no behavior change to `formatMemoryDump`'s
existing output.

**Layout per entity** (`<dir>` = `sanitizeForFilename(entityId)`):

```
entities/<dir>/facts/<fact.id>.md
entities/<dir>/tasks/<task.id>.md
entities/<dir>/log.md
entities/<dir>/index.md
index.md                              (bundle root)
```

Fact/task `id` values (`fact_<24hex>` / `task_<24hex>`, from `generateId()`) are already
filesystem-safe and used directly as filenames — no sanitization needed there.

**Fact → concept doc** (`entities/<dir>/facts/<fact.id>.md`, `type: 'fact'`):
- `title`: `fact.title`
- `tags`: `fact.tags`
- `timestamp`: `new Date(fact.updated_at).toISOString()`
- `resource`: `fact.source_ref ?? undefined` (key omitted when `null`)
- custom keys: `id`, `entity_id`, `confidence`, `source_type`, `source_hash`, `created_at`,
  `access_count`, `last_accessed_at`, `deleted_at`
- **excluded:** `embedding_blob` (binary; stripped the same way `formatMemoryDump` already
  strips it from its manifest)
- body: `fact.body`

**Task → concept doc** (`entities/<dir>/tasks/<task.id>.md`, `type: 'task'`):
- `title`: `task.description`
- `timestamp`: `new Date(task.updated_at).toISOString()`
- custom keys: `id`, `entity_id`, `status`, `priority`, `created_at`, `resolved_at`, `deleted_at`
- body: `''` (a task's only content is its description, already used as `title`)

**Events → `entities/<dir>/log.md`:** one `OkfLogEntry` per event — `date` is `event.created_at`
formatted as `YYYY-MM-DD`; `text` is `` (event.event_type) <summary> ``, where `<summary>` is
`event.summary` unless `event.related_entry_id` matches an exported fact's `id` for that entity,
in which case it's wrapped as a markdown link to that fact's relative path
(`[summary](../facts/<id>.md)`) — this is what realizes OKF's "a link asserts a relationship"
convention for this bundle.

**Entity `index.md`** (`entities/<dir>/index.md`): two sections, "Facts" and "Tasks", each entry
linking to its concept file (`title` = the doc's `title`, `description` omitted — neither facts
nor tasks have a dedicated description field distinct from their title/body). A plain line below
the sections links to `./log.md` for the event timeline.

**Root `index.md`**: `buildRootIndexMd('0.1', ...)` with one section "Entities", one entry per
exported entity linking to `entities/<dir>/index.md`.

**Function signature:**

```ts
export function formatOkfBundle(dump: MemoryDump): { files: OkfFile[] };
```

### 3. Exports

- `packages/okf/src/index.ts`: all types + `serializeFrontmatter`, `buildConceptDocument`,
  `buildIndexMd`, `buildRootIndexMd`, `buildLogMd`.
- `packages/core/src/index.ts`: add `formatOkfBundle` to the existing barrel export (alongside
  `formatMemoryDump`).
- `packages/core/package.json`: add `@equationalapplications/core-okf` as a `workspace:*`
  dependency.

### 4. Testing Strategy

Unit tests only, `vitest run`, no I/O — same style as `core-llm-tools`.

`packages/okf/__tests__/`:
- `frontmatter.test.ts` — scalar types, string-array tags, quoting rules (colon, `#`, leading/
  trailing whitespace, boolean/null/number-literal-shaped strings), key ordering, omission of
  `undefined` values.
- `concept.test.ts` — frontmatter + body concatenation, minimal case (`type` only).
- `index-md.test.ts` — multiple sections, entries with/without `description`, empty sections
  list, `buildRootIndexMd`'s `okf_version` frontmatter.
- `log-md.test.ts` — date grouping/descending sort, multiple entries per date, ISO heading
  format, empty entries list.

`packages/core/__tests__/`:
- `formatOkfBundle.test.ts` — full bundle shape for a multi-entity, multi-fact/task/event dump:
  correct file paths, frontmatter field mapping per fact/task, `embedding_blob` exclusion,
  `related_entry_id` → markdown-link resolution in `log.md` (including the case where the
  referenced fact isn't in the export and the link is omitted), root + entity `index.md` link
  correctness, reserved-filename collision (an entity/fact/task whose sanitized id would be
  `index` or `log` — confirm the existing hash-suffix collision logic in
  `sanitizeForFilename` still produces a non-colliding name).
- `sanitizeForFilename.test.ts` — extracted from the existing inline logic; same assertions
  `formatMemoryDump.test.ts` already implicitly relies on, now testable directly.

### 5. Versioning

New package starts in the monorepo's lockstep version scheme (currently `4.11.0`, matching
every other published package's `package.json`). `packages/core`'s change is additive
(semver-minor).

## Open Questions

None — all resolved during brainstorming (package boundary, export-only scope, concept mapping,
directory layout).
