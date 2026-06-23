# Design: Per-Entity Seeded Ontology

**Status:** Implemented
**Package:** `@equationalapplications/core-llm-wiki` (`packages/core`)
**Date:** 2026-06-23
**Depends on:** `2026-06-22-okf-import-design.md` (`okf_type` column, `edges` table, `EdgeRepository`)

## Problem

With the OKF import pipeline in place, `core-llm-wiki` persists node types via the `okf_type`
column and graph relationships in the `edges` table. However, the LLM maintenance passes
(`runLibrarian`, `ingestDocument`) lack a governing structure for these primitives. Without
guidance, the LLM extracts generic facts and hallucinates arbitrary relationships, causing
taxonomy drift that makes it impossible for developers to build predictable, data-driven UI
dashboards on top of the memory engine.

`runHeal` is also named in the taxonomy-drift problem (it synthesizes `newFacts`), but heal's
primary job is contradiction resolution and grooming — not primary extraction. Ontology typing
for heal is explicitly deferred to a follow-up spec (see Non-Goals).

## Goals

- Introduce `OntologyConfig` on `WikiConfig` to control the strictness of LLM graph extraction,
  defaulting to **`off`** so existing deployments are unchanged.
- Implement three operating modes: **Strict**, **Emergent**, and **Off**.
- Define a concise `OntologyManifest` JSON schema for allowed `node_types` and `edge_types`.
- Extend `PromptService` to inject `{{ontologyManifest}}` and `{{ontologyModeInstructions}}`
  into librarian and ingest prompts when mode ≠ `off`.
- Persist per-entity manifests (and per-entity mode overrides) in SQLite, with in-memory caching
  during execution.
- Expose `getOntologyManifest` / `setOntologyManifest` on `WikiMemory` for host applications to
  seed taxonomies.
- In Strict/Emergent modes, extend the LLM JSON output contract so facts may carry `okf_type` and
  inline `edges`, persisting typed facts and graph edges via the existing `EdgeRepository`.
- In Emergent mode, accept append-only `ontology_updates` from the LLM and merge them into the
  stored manifest (dedupe by `type` string; never modify existing definitions).

## Non-Goals

- **No `runHeal` ontology in v1.** Heal keeps its current JSON schema (`downgraded`, `deleted`,
  `newFacts` only). Typed `newFacts` and heal-driven edge repair are follow-up work.
- **No graph traversal/query API.** Edge persistence only; multi-hop reads remain future work
  (inherited deferral from the OKF import spec).
- **No OKF bundle manifest round-trip.** The `ontology_manifest` is engine-internal metadata.
  OKF `type` frontmatter and markdown cross-links continue to round-trip independently via the
  existing import/export path.
- **No host approval gate for Emergent updates.** Proposed types take effect in the same
  maintenance transaction.
- **No manifest type redefinition.** Emergent updates are append-only; duplicate `type` strings
  are silently ignored.
- **No JSON Schema validation library.** Manifest and LLM output are validated with lightweight
  TypeScript guards, consistent with existing `validateFact` / `parseJsonResponse` patterns.

## Design Decisions (Brainstorming Resolutions)

| Decision | Resolution |
| :--- | :--- |
| Default mode when unset | `off` |
| Per-entity config | Global default in `WikiConfig.ontology`; per-entity mode + manifest in DB; `setOntologyManifest` / `getOntologyManifest` API |
| Edge output shape | Inline on facts: `edges: [{ edge_type, target_title }]` |
| Emergent manifest updates | Append-only, dedupe by `type` |
| Heal participation | Excluded from v1 |
| Architecture | Dedicated `OntologyService` (not inline in maintenance services) |

## Design

### 1. Types (`packages/core/src/types.ts`)

```ts
export type OntologyMode = 'strict' | 'emergent' | 'off';

export interface OntologyNodeType {
  type: string;
  description: string;
}

export interface OntologyEdgeType {
  type: string;
  source_type: string;
  target_type: string;
  description: string;
}

export interface OntologyManifest {
  node_types: OntologyNodeType[];
  edge_types: OntologyEdgeType[];
}

export interface OntologyConfig {
  /** Global default mode. Default: 'off'. */
  mode?: OntologyMode;
  /**
   * Bootstrap manifests for known entities at construction time.
   * Written to DB on first access if no row exists for that entity.
   */
  seedManifests?: Record<string, {
    manifest: OntologyManifest;
    mode?: OntologyMode;
  }>;
}

/** LLM-facing fact shape extension (Strict/Emergent modes only). */
export interface ExtractedFactEdge {
  edge_type: string;
  target_title: string;
}

export interface ExtractedFactWithOntology extends ExtractedFact {
  okf_type?: string;
  edges?: ExtractedFactEdge[];
}

export interface OntologyUpdates {
  node_types?: OntologyNodeType[];
  edge_types?: OntologyEdgeType[];
}
```

Add `ontology?: OntologyConfig` to `WikiConfig`.

### 2. Ontology modes

**Off (default):** Graph relationship and explicit type extraction are disabled. Prompts,
JSON schemas, and persistence paths are unchanged from today: `okf_type` remains `null` on
LLM-created facts; no edges are created by maintenance passes. OKF import continues to populate
`okf_type` and edges independently.

**Strict:** The LLM must classify facts using only `node_types` (mapped to `okf_type`) and
`edge_types` defined in the entity's manifest. Validation rules:

- `okf_type` must match a `node_types[].type` entry. Lookup is **case-insensitive**; the
  canonical casing from the manifest is persisted (e.g. LLM outputs `"Person"` → stored as
  `"person"`). Only types with no manifest match fall back to `null`.
- Each inline edge's `edge_type` must exist in `edge_types` with `source_type` equal to the
  fact's `okf_type` and `target_type` equal to the resolved target fact's `okf_type`.
- If a fact's `okf_type` is invalid, or any edge fails validation → store the fact with
  `okf_type: null` and **no edges** for that fact (fallback to untyped semantic fact).
- Tasks are unaffected in v1 (no `okf_type` on tasks from LLM passes).

**Emergent:** Same validation and fallback as Strict for the current response, but the LLM may
also return `ontology_updates` with new `node_types` and/or `edge_types`. Updates are merged
into the manifest **before** validating/persisting facts from the same response (so newly
proposed types can be used immediately). Merge is append-only: a type is added only if its
`type` string is not already present in the manifest; duplicates are silently ignored.

### 3. `ontology_manifest` schema

Concise enough for system prompts; expressive enough to define a typed graph.

```json
{
  "node_types": [
    { "type": "person", "description": "An individual or user." },
    { "type": "project", "description": "An ongoing initiative or software repository." }
  ],
  "edge_types": [
    {
      "type": "reports_to",
      "source_type": "person",
      "target_type": "person",
      "description": "Hierarchy between individuals."
    },
    {
      "type": "contributes_to",
      "source_type": "person",
      "target_type": "project",
      "description": "Denotes an individual working on a project."
    }
  ]
}
```

**Invariants enforced on write (`setOntologyManifest` and merge):**

- `node_types` and `edge_types` must be arrays (may be empty).
- Each `type` slug must be non-empty, unique within its array.
- Each `edge_types[].source_type` and `target_type` must reference an existing `node_types[].type`
  (validation error on `setOntologyManifest`; silently dropped on Emergent merge if endpoint
  types are not yet present — the edge type is only appended when both endpoints exist, or when
  the update batch also introduces the missing node types in the same merge call).

### 4. Storage — migration v6

```ts
{
  version: 6,
  description: 'Add entity_manifests table for per-entity ontology state',
  run: async (db, prefix) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${prefix}entity_manifests (
        entity_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'off',
        manifest_json TEXT NOT NULL DEFAULT '{"node_types":[],"edge_types":[]}',
        updated_at INTEGER NOT NULL
      );
    `);
  },
},
```

Also add the table to `schema.ts` for fresh installs.

**`MetadataRepository` extensions:**

```ts
getManifest(entityId: string, tx?: SQLiteAdapter): Promise<{
  mode: OntologyMode;
  manifest: OntologyManifest;
} | null>;

setManifest(
  entityId: string,
  data: { mode: OntologyMode; manifest: OntologyManifest },
  tx: SQLiteAdapter,
): Promise<void>;

mergeManifestUpdates(
  entityId: string,
  updates: OntologyUpdates,
  tx: SQLiteAdapter,
): Promise<OntologyManifest>;
```

`mergeManifestUpdates` loads the current row (or empty manifest), appends novel types, persists,
and returns the merged manifest. It does **not** change `mode`.

### 5. `OntologyService` (`packages/core/src/services/OntologyService.ts`)

Central coordinator. Constructed in `WikiMemory` with `MetadataRepository`, `EdgeRepository`,
and `WikiConfig.ontology`.

**Responsibilities:**

| Method | Purpose |
| :--- | :--- |
| `resolveMode(entityId)` | DB row → `WikiConfig.ontology.mode` → `'off'` |
| `getManifest(entityId)` | Cache → DB → `seedManifests` bootstrap → `null` (Off) |
| `setManifest(entityId, manifest, opts?)` | Validate, persist, invalidate cache |
| `buildPromptContext(entityId)` | Returns `{ ontologyManifest, ontologyModeInstructions }` or `null` when Off |
| `applyEmergentUpdates(entityId, updates, tx)` | Append-only merge via `MetadataRepository` |
| `validateAndNormalizeFact(fact, manifest, mode)` | Case-insensitive `okf_type` lookup with canonical manifest casing; returns `{ okf_type, edges }` or fallback `{ okf_type: null, edges: [] }` |
| `resolveAndPersistEdges(entityId, sourceId, sourceType, edges, titleIndex, tx)` | Title lookup → `EdgeRepository.addIgnoreDuplicate` |

**In-memory cache:** `Map<string, { mode: OntologyMode; manifest: OntologyManifest }>`.
Populated on first `getManifest` per entity per `WikiMemory` instance; invalidated on
`setManifest` / `mergeManifestUpdates`. Not shared across instances (consistent with existing
`SearchService` entity cache pattern). **Assumes a single-process host** (mobile, local
Node, single-worker server). Horizontally scaled multi-instance deployments with a shared DB
must treat manifest writes as eventually consistent across instances, or bypass the cache by
using separate `WikiMemory` instances per request without cross-instance invalidation.

**Mode resolution order:**

1. `entity_manifests.mode` column if row exists.
2. `WikiConfig.ontology.mode`.
3. `'off'`.

**Bootstrap:** On `getManifest(entityId)`, if no DB row exists and
`WikiConfig.ontology.seedManifests[entityId]` is present, write that entry to DB (using seed
`mode` or global default) and return it.

### 6. `PromptService` integration

Extend `buildIngestPrompt` and `buildLibrarianPrompt` to accept an optional
`ontologyContext: { ontologyManifest: string; ontologyModeInstructions: string } | null`.

When context is non-null, hydrate `{{ontologyManifest}}` and `{{ontologyModeInstructions}}` in
the template. When null (Off mode), leave placeholders unreplaced (existing behavior — templates
do not yet contain these variables).

**`ontologyModeInstructions` content (generated by `OntologyService`, not hand-edited):**

- **Strict:** Instructs the LLM to use only manifest types; describes fallback to untyped facts;
  specifies the extended JSON schema with `okf_type` and inline `edges`.
- **Emergent:** Same as Strict, plus permission to return `ontology_updates` for novel types.

Default prompt constants (`LIBRARIAN_SYSTEM_PROMPT`, `INGEST_SYSTEM_PROMPT`) gain placeholder
blocks that are inert when Off (placeholders remain literal if not hydrated — or prompts are
structured so ontology blocks are appended only when context is provided; implementation may
choose conditional append vs. placeholder hydration, but the effective prompt text when Off must
be byte-identical to today's defaults).

### 7. LLM JSON output contracts

**Off:** Unchanged.

**Strict / Emergent — librarian:**

```json
{
  "facts": [{
    "title": "string (max 80 chars)",
    "body": "string (max 800 chars)",
    "tags": ["string"],
    "confidence": "certain|inferred|tentative",
    "okf_type": "person",
    "edges": [{ "edge_type": "reports_to", "target_title": "Jane Doe" }]
  }],
  "tasks": [{ "description": "string", "priority": "number (0-10)" }]
}
```

**Strict / Emergent — ingest:**

```json
{
  "facts": [{
    "title": "string (max 80 chars)",
    "body": "string (max 800 chars)",
    "tags": ["string"],
    "confidence": "certain|inferred|tentative",
    "okf_type": "project",
    "edges": [{ "edge_type": "contributes_to", "target_title": "Acme Rewrite" }]
  }]
}
```

**Emergent only — optional top-level key on librarian and ingest responses:**

```json
{
  "ontology_updates": {
    "node_types": [{ "type": "vendor", "description": "An external supplier." }],
    "edge_types": [{
      "type": "supplies",
      "source_type": "vendor",
      "target_type": "project",
      "description": "Vendor provides materials to a project."
    }]
  }
}
```

`okf_type` and `edges` remain optional per fact. Omitted `okf_type` → stored as `null` (same as
failed validation fallback). Omitted `edges` → no edges for that fact.

### 8. Maintenance & ingestion wiring

**`MaintenanceService.doRunLibrarian`:**

1. `ontologyContext = await ontologyService.buildPromptContext(entityId)`.
2. Build prompt with context; call LLM.
3. If mode is Emergent and `ontology_updates` present → `applyEmergentUpdates` inside transaction.
4. For each valid fact → `validateAndNormalizeFact` → persist with `okf_type`.
5. Build `titleIndex` from inserted facts + `currentFacts` (normalized:
   `title.trim().toLowerCase().replace(/\s+/g, ' ')`).
6. `resolveAndPersistEdges` for each fact with validated edges.

**`IngestionService.ingestDocument`:** Same pattern per chunk. Emergent updates from multiple
chunks merge cumulatively (each chunk's updates append to manifest within its transaction).
Edge `target_title` may reference a fact from an earlier chunk in the same ingest call via the
accumulating `titleIndex`.

**`MaintenanceService.doRunHeal`:** No changes.

### 9. Edge resolution

For each validated inline edge on fact `F`:

1. Normalize `target_title` and look up in `titleIndex: Map<string, string>` (title → fact id).
2. On miss → skip edge (no throw; optional `console.warn` in development).
3. On hit → verify target's `okf_type` matches the edge type's `target_type` (already enforced
   during validation if target is a sibling in the same response; re-check for existing facts
   whose `okf_type` may differ).
4. `EdgeRepository.addIgnoreDuplicate({ id: generateId(), entity_id, source_id: F.id, target_id,
   edge_type, created_at: now })`.

Self-loop edges (`source_id === target_id`) are permitted if the manifest defines them. The
`edges` table has no `CHECK` constraint preventing identical source/target IDs (only a
`UNIQUE(entity_id, source_id, target_id, edge_type)` dedup index).

### 10. Public API (`WikiMemory`)

```ts
async getOntologyManifest(entityId: string): Promise<{
  mode: OntologyMode;
  manifest: OntologyManifest;
} | null>;

async setOntologyManifest(
  entityId: string,
  manifest: OntologyManifest,
  options?: { mode?: OntologyMode },
): Promise<void>;
```

`getOntologyManifest` returns `null` when no row exists and no seed applies (entity is
effectively Off with an empty manifest). Hosts that need to distinguish "Off" from "Strict with
empty manifest" should call after `setOntologyManifest` or inspect the returned `mode`.

Export new types from `packages/core/src/index.ts`.

### 11. File map

| Action | Path | Responsibility |
| :--- | :--- | :--- |
| Modify | `src/types.ts` | `OntologyMode`, manifest types, `OntologyConfig`, extended fact types |
| Modify | `src/db/schema.ts` | `entity_manifests` table on fresh install |
| Modify | `src/db/migrations.ts` | v6 migration |
| Modify | `src/repositories/MetadataRepository.ts` | `getManifest`, `setManifest`, `mergeManifestUpdates` |
| Create | `src/services/OntologyService.ts` | Mode resolution, validation, cache, edge resolution |
| Modify | `src/services/PromptService.ts` | Ontology context hydration |
| Modify | `src/services/MaintenanceService.ts` | Librarian ontology pipeline |
| Modify | `src/services/IngestionService.ts` | Ingest ontology pipeline |
| Modify | `src/prompts.ts` | Ontology-aware default prompts (inert when Off) |
| Modify | `src/WikiMemory.ts` | Wire `OntologyService`; expose public API |
| Modify | `src/index.ts` | Export new types |
| Create | `__tests__/services/OntologyService.test.ts` | Unit tests |
| Modify | `__tests__/services/PromptService.test.ts` | Ontology variable injection |
| Modify | `__tests__/services/MaintenanceService.test.ts` | Strict librarian integration |
| Modify | `__tests__/services/IngestionService.test.ts` | Strict ingest integration |
| Create | `__tests__/repositories/MetadataRepository.manifest.test.ts` | Manifest CRUD + merge |

### 12. Testing strategy

**`OntologyService.test.ts`:**

- Mode resolution: DB override beats config; config beats default Off.
- `seedManifests` bootstrap on first `getManifest`.
- Strict validation: valid type + edges pass; invalid `okf_type` → null fallback; wrong edge
  endpoints → fact stored without edges.
- Emergent merge: append novel types; ignore duplicate `type`; ignore edge types whose
  endpoints are missing.
- Edge resolution: sibling title match; existing-fact title match; miss → skip.
- Cache invalidation on `setManifest`.

**`PromptService.test.ts`:**

- Off → no ontology variables in output (or placeholders unreplaced).
- Strict → `ontologyManifest` JSON and instructions present.

**Integration (librarian + ingest):**

- Off mode → byte-same behavior as pre-feature tests (`okf_type` null, no new edges).
- Strict with seeded manifest → facts get `okf_type`; edges persisted in `edges` table.
- Emergent → manifest row grows after pass; subsequent fact uses new type in same pass.
- Invalid LLM output (unknown type) → untyped fact, no throw.

**`MetadataRepository` manifest tests:**

- `setManifest` / `getManifest` round-trip.
- `mergeManifestUpdates` append-only semantics.

### 13. Versioning

Additive (semver-minor): new table, new config fields, new optional fact fields in LLM contract,
new public API methods. Default Off preserves all existing runtime behavior for hosts that do not
opt in.

## Open Questions

None — resolved during brainstorming.

## Next Step

Once this specification is approved, invoke the implementation plan (`writing-plans` skill) to
draft exact modifications to `LIBRARIAN_SYSTEM_PROMPT` and `INGEST_SYSTEM_PROMPT`, plus the
`OntologyService` validation guards and migration v6.
