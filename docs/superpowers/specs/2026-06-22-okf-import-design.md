# Design: Open Knowledge Format (OKF) Import

**Status:** Implemented
**Packages:** `@equationalapplications/core-okf` (`packages/okf`); `packages/core` adapter + schema
**Date:** 2026-06-22
**Depends on:** `2026-06-18-okf-export-design.md` (export-only; explicitly deferred import)

## Problem

The export spec produces a compliant OKF v0.1 bundle from a `MemoryDump` via `formatOkfBundle`,
but there is no path back: reading a foreign or modified OKF bundle into `WikiMemory` requires
parsing YAML frontmatter, interpreting `log.md` chronologies, and deciding how arbitrary
third-party `type` values and markdown cross-links map onto the engine's facts/tasks/events.

This matters now because of the planned **Per-Entity Seeded Ontology** direction (Strict /
Emergent / Off `OntologyConfig` modes, not yet implemented): OKF's `type` frontmatter field and
markdown cross-links are exactly the node-type and edge primitives that future ontology graph
will need. Import should preserve them losslessly today, even though the consumer
(`OntologyConfig`) doesn't exist yet, rather than discarding them via a forced fact/task
downcast.

## Goals

- Zero-dependency parsing primitives in `@equationalapplications/core-okf`: extract frontmatter,
  concept body, `log.md` chronology, and inline markdown links from OKF bundle files.
- A `parseOkfBundle` adapter in `packages/core` that turns a flat `OkfFile[]` (one entity's
  subtree) into a `MemoryDump`, fed straight into the existing `wiki.importDump(dump, { merge:
  true })` pipeline — no changes to `ImportExportService`'s write-path safety (LWW, transactions,
  embedding-blob handling).
- Preserve the literal OKF `type` string per concept (no forced downcast to `'fact'`/`'task'`)
  via a new nullable `okf_type` column, while still routing each concept into the existing
  `entries`/`tasks` tables (routing is a separate decision from type fidelity).
- Persist typed relationship edges extracted from markdown cross-links in a concept's body, via a
  new `edges` table, so the bundle's graph structure survives a round trip.

## Non-Goals

- **No `ontology_manifest` / `OntologyConfig` handling.** `OntologyConfig` doesn't exist in code
  yet (no type, no storage). Parsing or hydrating it now would be opaque metadata with no
  consumer. Deferred to a future Per-Entity Seeded Ontology spec.
- **No graph traversal/query API.** This spec adds enough to persist and round-trip edges
  (`EdgeRepository.getByEntityId`). Multi-hop queries, path search, or any graph-read surface is
  future work.
- **No general YAML or CommonMark parsing.** `parseFrontmatter` supports the exact subset
  `serializeFrontmatter` produces (scalars, quoted strings, block string-lists). `extractMarkdownLinks`
  is a single-line inline-link regex, not a markdown AST. Unsupported constructs degrade
  gracefully (raw-string fallback, or the link/entry is skipped) rather than throwing.
- **No filesystem/archive I/O.** Same boundary as the export spec — the host application reads
  files (or a zip) and passes `OkfFile[]` in.
- **No cross-entity edge integrity guarantees.** An edge's `target_id` may reference a concept in
  an entity that wasn't included in a given import/export call. Accepted, same class of limitation
  as today's event `related_entry_id` handling.

## Design

### 1. `packages/okf` — generic parsing primitives

No knowledge of `WikiFact`/`WikiTask`/`WikiEvent`. Mirrors the existing serializer files.

**`src/frontmatter.ts`** (add to existing file)

```ts
export function parseFrontmatter(content: string): { frontmatter: OkfFrontmatter; rest: string };
```

Reads the `---\n...\n---\n` block. Supports scalar string/number/boolean/null, quoted strings
(matching `serializeFrontmatter`'s quoting rules in reverse), and block string-lists (`  - item`
lines under a `key:` line). Constructs it doesn't recognize (flow collections `[...]`/`{...}`,
multi-line block scalars `|`/`>`, anchors/aliases, nested maps) are kept as the raw string value
rather than causing a parse failure — this is a deliberate narrow subset, not a YAML 1.2 parser.

**`src/concept.ts`** (add)

```ts
export function parseConcept(content: string): { frontmatter: OkfFrontmatter; body: string };
```

**`src/log-md.ts`** (add)

```ts
export function parseLogMd(content: string): OkfLogEntry[];
```

Regex over `## YYYY-MM-DD` headings and `- text` bullets underneath, the exact shape
`buildLogMd` emits. Bundles with differently-formatted `log.md` files are best-effort (entries
that don't match the pattern are skipped, not thrown).

**`src/markdown-links.ts`** (new)

```ts
export function extractMarkdownLinks(body: string): Array<{ text: string; path: string }>;
```

Single-line inline link regex (`[text](path)`). Skips `http://`, `https://`, and `mailto:`
targets — only relative/local paths are candidate edges.

**`src/index.ts`**: export the four new functions alongside existing exports.

### 2. `packages/core/src/utils/parseOkfBundle.ts` — wiki adapter

```ts
export interface OkfImportOptions {
  /**
   * Routes a concept's OKF `type` to a destination table. This does NOT discard the
   * original type string — see okf_type below. Any type mapped to 'ignore' is skipped
   * entirely (no row, no edges from it).
   */
  typeMapping?: Record<string, 'fact' | 'task' | 'ignore'>;
  /** Fallback when typeMapping has no entry and directory convention doesn't apply. Default 'fact'. */
  defaultSchema?: 'fact' | 'task' | 'ignore';
}

export function parseOkfBundle(
  entityId: string,
  files: OkfFile[],
  options?: OkfImportOptions,
): MemoryDump;
```

**Routing precedence** (decides `entries` vs `tasks` table; independent of type fidelity):

1. `options.typeMapping[frontmatter.type]`, if present.
2. Else, directory convention: path contains `/facts/` → fact, path contains `/tasks/` → task.
3. Else, `options.defaultSchema` (default `'fact'`).

A result of `'ignore'` at any step skips the file.

**Two-pass parse per call** (`files` is one entity's subtree, e.g. everything under
`entities/<dir>/`):

1. **Build `path → resolvedId` map.** For every file other than `index.md`/`log.md`:
   `frontmatter.id ?? basename(path)` (filename without `.md`). This lets links resolve to ids
   for both our own exports (which always set the `id` custom key) and foreign bundles (which
   likely don't, per OKF's "only `type` is required" rule).
2. **Per concept file:** `parseConcept` → frontmatter + body.
   - Missing `id` → `generateId()`. Missing `created_at`/`updated_at` → `Date.now()`.
   - Remaining known frontmatter keys map back onto `WikiFact`/`WikiTask` fields, reversing
     `factFrontmatter`/`taskFrontmatter` from `formatOkfBundle.ts` (`title`, `tags`, `confidence`,
     `source_type`, `source_hash`, `source_ref`, `status`, `priority`, `resolved_at`,
     `deleted_at`, etc., per destination table).
   - `okf_type` field on the resulting `WikiFact`/`WikiTask` = `frontmatter.type` verbatim.
   - `extractMarkdownLinks(body)`, resolve each `path` via the map from step 1; skip links that
     don't resolve, or that resolve to `index.md`/`log.md` (structural navigation, not a
     relationship). Emit `WikiEdge { id: generateId(), entity_id, source_id: <this concept's
     resolved id>, target_id: <resolved>, edge_type: text, created_at: Date.now() }`.
3. **`log.md`** (if present): `parseLogMd` → events. Relative-link targets inside log entries
   resolve via the same map to hydrate `related_entry_id` — this is the existing event-to-fact
   relationship, unchanged in kind, just now read instead of only written.

Output: `{ generatedAt: Date.now(), entities: { [entityId]: { facts, tasks, events, edges } } }`.

### 3. `packages/core` schema + service wiring

**Migration v5** (`src/db/migrations.ts`):

```ts
{
  version: 5,
  description: 'Add okf_type to entries/tasks; create edges table for OKF graph import',
  run: async (db, prefix) => {
    for (const table of ['entries', 'tasks']) {
      const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${prefix}${table})`);
      if (!cols.some(c => c.name === 'okf_type')) {
        await db.execAsync(`ALTER TABLE ${prefix}${table} ADD COLUMN okf_type TEXT`);
      }
    }
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${prefix}edges (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(source_id, target_id, edge_type)
      );
      CREATE INDEX IF NOT EXISTS ${prefix}edges_entity_id ON ${prefix}edges (entity_id);
    `);
  },
},
```

`okf_type` is nullable; existing rows (pre-migration, or never touched by OKF import) stay
`NULL`. The `UNIQUE(source_id, target_id, edge_type)` constraint makes re-importing the same
bundle idempotent without needing LWW semantics for edges — there's no "edit an edge", only
presence/absence.

**`types.ts`**: add

```ts
export interface WikiEdge {
  id: string;
  entity_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  created_at: number;
}
```

Add `edges: WikiEdge[]` to `MemoryBundle`. Add `okf_type?: string | null` to `WikiFact` and
`WikiTask`.

**New `repositories/EdgeRepository.ts`** (mirrors `EventRepository`):

- `addIgnoreDuplicate(edge: WikiEdge, tx?): Promise<void>` — `INSERT OR IGNORE`.
- `getByEntityId(entityId: string, tx?): Promise<WikiEdge[]>`.
- `bulkDeleteByEntityId(entityId: string, tx): Promise<void>` — hard delete (no soft-delete
  concept for edges); used on non-merge import, mirroring `bulkSoftDeleteByEntityId` for
  facts/tasks.

**`WikiMemory.ts`**: instantiate `EdgeRepository`, pass it into `ImportExportService`'s
constructor as a new argument (alongside the existing repos).

**`ImportExportService.ts`**:

- `getFullBundle`: fetch `edges` via `edgeRepo.getByEntityId(entityId, ...)`, include in the
  returned `MemoryBundle`.
- `doImportEntity`: in the non-merge branch, call `edgeRepo.bulkDeleteByEntityId(entityId, tx)`
  alongside the existing fact/task wipe. After the events loop, iterate `bundle.edges` and
  `edgeRepo.addIgnoreDuplicate(edge, tx)` each — runs in both merge and non-merge modes (the
  UNIQUE constraint already prevents duplication on repeat import).

**`formatOkfBundle.ts`**: one-line change in each of `factFrontmatter`/`taskFrontmatter` —
`type: f.okf_type ?? 'fact'` / `type: t.okf_type ?? 'task'` instead of the hardcoded literal. No
other changes: a concept's body already contains the markdown links that produced its edges, so
OKF export round-trips the graph "for free" through existing body serialization — re-running
`parseOkfBundle` on an exported bundle re-derives the same edges.

**`index.ts`**: export `parseOkfBundle`, `OkfImportOptions`, `WikiEdge`.

### 4. File Map

| Package | Action | Path | Responsibility |
| :--- | :--- | :--- | :--- |
| `core-okf` | Modify | `src/frontmatter.ts` | Add `parseFrontmatter` |
| `core-okf` | Create | `src/concept.ts` parse half / modify existing | Add `parseConcept` |
| `core-okf` | Modify | `src/log-md.ts` | Add `parseLogMd` |
| `core-okf` | Create | `src/markdown-links.ts` | `extractMarkdownLinks` |
| `core-okf` | Modify | `src/index.ts` | Export new parse utilities |
| `core` | Modify | `src/types.ts` | `WikiEdge`, `MemoryBundle.edges`, `okf_type` fields |
| `core` | Modify | `src/db/migrations.ts` | v5: `okf_type` columns + `edges` table |
| `core` | Create | `src/repositories/EdgeRepository.ts` | Edge persistence |
| `core` | Modify | `src/WikiMemory.ts` | Wire `EdgeRepository` into `ImportExportService` |
| `core` | Modify | `src/services/ImportExportService.ts` | Fetch/wipe/insert edges in bundle lifecycle |
| `core` | Modify | `src/utils/formatOkfBundle.ts` | `okf_type` fallback (1 line × 2) |
| `core` | Create | `src/utils/parseOkfBundle.ts` | `OkfFile[]` → `MemoryDump` adapter |
| `core` | Modify | `src/index.ts` | Export `parseOkfBundle`, `OkfImportOptions`, `WikiEdge` |

### 5. Testing Strategy

`packages/okf/__tests__/`:

- `frontmatter.test.ts` (extend): scalar/quoted-string parsing, block string-lists, unsupported
  construct → raw-string fallback (round-trips against existing `serializeFrontmatter` fixtures).
- `concept.test.ts` (extend): split frontmatter/body, minimal `type`-only case.
- `log-md.test.ts` (extend): heading/bullet extraction, malformed-line skipping, empty content.
- `markdown-links.test.ts` (new): inline link extraction, `http(s)://`/`mailto:` exclusion,
  multiple links per line, no-link body.

`packages/core/__tests__/`:

- `migrations.test.ts` (extend): v5 adds `okf_type` columns and `edges` table idempotently
  (running it twice is a no-op).
- `EdgeRepository.test.ts` (new): `addIgnoreDuplicate` dedup behavior, `getByEntityId`,
  `bulkDeleteByEntityId`.
- `ImportExportService.test.ts` (extend): `getFullBundle` includes edges; `doImportEntity` wipes
  edges on non-merge, inserts on both modes, re-import doesn't duplicate.
- `parseOkfBundle.test.ts` (new): all three routing-precedence levels, `'ignore'` skip,
  `okf_type` preservation for arbitrary third-party type strings, edge extraction + resolution
  (including unresolved and structural-link skipping), missing-metadata fallback
  (`generateId()`/`Date.now()`), and a **full round-trip test**: `formatOkfBundle` →
  `parseOkfBundle` → structurally equivalent `MemoryDump` (facts, tasks, events, and edges).

### 6. Versioning

Additive (semver-minor): new nullable column, new table, new exported functions/types. No
existing behavior changes except the `okf_type ?? 'fact'/'task'` fallback in `formatOkfBundle`,
which preserves current output for all pre-existing data.

## Open Questions

None — resolved during brainstorming: schema-now vs. defer (chose minimal schema now), manifest
handling (deferred), edge source (markdown link text, not frontmatter arrays).
