# Spec: Knowledge Graph Traversal API

**Date:** 2026-06-23
**Status:** Draft
**Builds on:** [2026-06-22-okf-import-design.md](./2026-06-22-okf-import-design.md) (`llm_wiki_edges` table), [2026-06-23-per-entity-seeded-ontology-design.md](./2026-06-23-per-entity-seeded-ontology-design.md) (ontology manifest, `okf_type`)
**Packages:** `@equationalapplications/core-llm-wiki` (`packages/core`), `@equationalapplications/react-llm-wiki` (`packages/react`), `@equationalapplications/core-llm-tools` (`packages/core-llm-tools`)

---

## Problem

The engine persists typed knowledge nodes (`okf_type` column on `entries`) and relationships (`llm_wiki_edges` table) via the OKF import and Seeded Ontology extraction passes (`OntologyService.resolveAndPersistEdges()`, called from `MaintenanceService.doRunLibrarian()`). But the retrieval surface — `WikiMemory.read()` — only does semantic/keyword search over individual facts. There is no way for the LLM (or a UI) to walk the graph structurally: "who reports to X," "what connects to this project," "show me everything two hops from this fact."

`runLibrarian` and `ingestDocument` already write edges in the background. This spec adds the read path on top of that existing data — no schema changes.

## Goals

- `EdgeRepository.getNeighborhood()` — single-query multi-hop traversal via SQLite `WITH RECURSIVE`, entity-scoped, depth/confidence/source-type/edge-type filtered, cycle-safe, capped and ordered at the SQL level.
- `GraphTraversalService.traverseGraph()` — orchestrates: merge `WikiConfig` defaults with per-call `GraphTraversalOptions`, call the repository, hydrate node IDs into `WikiFact[]`.
- `WikiMemory.traverseGraph(entityId, options)` — thin facade delegate.
- `formatGraphContext(neighborhood)` — pure function, dense text serialization for LLM prompt injection. Exported from `core-llm-wiki`'s public surface.
- `useWikiTraversal(entityId, options)` — reactive React hook mirroring `useMemoryRead`.
- `wikiGetOntologyManifest` and `wikiTraverseGraphManifest` tool schemas in `core-llm-tools`, scope `memory:read`.

## Non-Goals (v1)

- **Arbitrary graph query languages.** No GraphQL/Cypher/Gremlin. Traversal is strictly N-hops from one starting node.
- **Global graph analysis.** PageRank, clustering, etc. — too heavy for edge/mobile SQLite, out of scope.
- **Vector search over edges.** Traversal is purely structural; semantic search stays in `read()`.
- **Schema changes.** `llm_wiki_edges` and `entries` already have every column this feature needs (`source_id`, `target_id`, `edge_type`, `entity_id`, `confidence`, `source_type`, `deleted_at`, `updated_at`).
- **Tool executor wiring.** `core-llm-tools` ships JSON schema declarations only. The functions that actually call `WikiMemory.traverseGraph()` / `formatGraphContext()` and register them with a model runner live in the host application (e.g. Clanker for the Edge Agent, or an `@google/adk` cloud runner) — out of scope for this repo, matching the precedent set in [2026-06-18-google-search-tool-design.md](./2026-06-18-google-search-tool-design.md) ("Backend wiring in Clanker. Out of scope for this repo/package").
- **Cross-hook auto-refetch / push updates.** `useWikiTraversal` follows the same manual-`refetch()` convention as every other hook in `packages/react` (e.g. `useOntologyManifest`).

---

## Types (`core-llm-wiki`)

```typescript
// packages/core/src/types.ts

export interface GraphTraversalOptions {
  sourceId: string;
  /** Hop count. Default 1. Clamped to [1, 3] regardless of input. */
  maxDepth?: number;
  /** Default 'both'. Falls back to WikiConfig.traversalDirection, then 'both'. */
  direction?: 'inbound' | 'outbound' | 'both';
  /**
   * Allowed edge types. `undefined` = no filter (all types).
   * `[]` (explicit empty array) = match nothing — distinct from `undefined`.
   */
  edgeTypes?: string[];
  /** Total node cap (anchor + neighbors). Default 20 via WikiConfig.maxTraversalNodes. */
  maxTraversalNodes?: number;
  /** Minimum confidence tier for *discovered* nodes. Does not gate the anchor. Default 'tentative'. */
  minTraversalConfidence?: 'certain' | 'inferred' | 'tentative';
  /** source_type values to dead-end on for *discovered* nodes. Does not gate the anchor. Default []. */
  excludeSourceTypes?: Array<WikiFact['source_type']>;
}

export interface GraphNeighborhood {
  /** Anchor node first, then discovered neighbors ordered by depth ASC, then updated_at DESC. */
  nodes: WikiFact[];
  /** Only edges where both endpoints are present in `nodes`. */
  edges: WikiEdge[];
}
```

`WikiConfig` (`packages/core/src/types.ts`) gains four optional fields, following the existing `maxResults`/`preFilterLimit` pattern — global defaults, overridable per-call:

```typescript
interface WikiConfig {
  // ...existing fields...
  maxTraversalNodes?: number;       // default 20
  minTraversalConfidence?: 'certain' | 'inferred' | 'tentative'; // default 'tentative'
  traversalDirection?: 'inbound' | 'outbound' | 'both'; // default 'both'
  excludeSourceTypes?: Array<WikiFact['source_type']>;  // default []
}
```

**Confidence ranking** (lowest to highest reliability): `tentative` (0) < `inferred` (1) < `certain` (2). `minTraversalConfidence: 'inferred'` admits `inferred` and `certain` discovered nodes, excludes `tentative` ones.

---

## `EdgeRepository.getNeighborhood()`

All filtering, dead-ending, ordering, and capping happens inside this one method — `GraphTraversalService` does not re-filter or re-sort anything it returns.

```typescript
// packages/core/src/repositories/EdgeRepository.ts

interface NeighborhoodQueryOptions {
  maxDepth: number;                 // already clamped to [1,3] by caller
  direction: 'inbound' | 'outbound' | 'both';
  edgeTypes?: string[];             // undefined = no filter; [] = match nothing
  minConfidence: 'certain' | 'inferred' | 'tentative';
  excludeSourceTypes: string[];
  maxNodes: number;
}

async getNeighborhood(
  entityId: string,
  sourceId: string,
  opts: NeighborhoodQueryOptions,
  tx?: SQLiteAdapter,
): Promise<{ nodeIds: string[]; edges: WikiEdge[] }>
```

### Behavior

1. **`edgeTypes: []` short-circuits.** If the caller passed an explicit empty array, return `{ nodeIds: [sourceId-if-it-exists], edges: [] }` without running the recursive query — no edge type can match nothing, so the CTE work is wasted. Still need one query to confirm the anchor exists (deleted/cross-entity check, below).
2. **Anchor validation, not anchor filtering.** The anchor is included whenever it exists, belongs to `entityId`, and isn't soft-deleted — confidence and source_type do **not** gate it. The caller already named this node by ID (e.g. from a prior `wiki_read` result); they're asking to expand outward from it, not asking permission to see it.
3. **Discovered-node dead-end gate.** Every node beyond the anchor is gated by `minConfidence` and `excludeSourceTypes` *during* the walk (joined against `entries` inside the recursive step), not after. A node that fails the gate is never added to the frontier, so it cannot act as an invisible bridge to nodes beyond it.
4. **Cycle guard.** Track visited IDs as a delimited string (`,id1,id2,...,`) per path; check with `instr(visited, ',' || next_id || ',') = 0` before allowing a re-visit. Plain (undelimited) substring matching is unsafe — e.g. ID `123` would false-positive-match inside `,91234,`.
5. **Cap + order.** Final `SELECT DISTINCT node_id, MIN(depth)` grouped, then `ORDER BY depth ASC, entries.updated_at DESC LIMIT maxNodes`. Ties at the same depth go to the most-recently-updated fact first.
6. **Edges re-query.** After node IDs are capped, re-query edges scoped to `entity_id = ?` AND both `source_id` and `target_id` IN the capped ID set. This guarantees no edge in the result references a node that didn't make the cap.

### CTE shape

```sql
WITH RECURSIVE walk(node_id, depth, visited) AS (
  -- Base case: anchor validation only (no confidence/source_type gate)
  SELECT id, 0, ',' || id || ','
  FROM entries
  WHERE id = ?sourceId AND entity_id = ?entityId AND deleted_at IS NULL

  UNION

  -- Recursive step: SQLite has no LATERAL join, so a derived "next_id" table
  -- can't correlate against w/e. Repeat the CASE expression inline at each
  -- of the three places that need it (join target, visited-string append,
  -- cycle check) instead of aliasing it once.
  SELECT
    CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END,
    w.depth + 1,
    w.visited || (CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END) || ','
  FROM walk w
  JOIN edges e
    ON e.entity_id = ?entityId
    AND (
      (?direction != 'inbound'  AND e.source_id = w.node_id) OR
      (?direction != 'outbound' AND e.target_id = w.node_id)
    )
    AND (?edgeTypes IS NULL OR e.edge_type IN (?edgeTypes))
  JOIN entries n
    ON n.id = (CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END)
    AND n.entity_id = ?entityId
    AND n.deleted_at IS NULL
    AND (CASE n.confidence WHEN 'tentative' THEN 0 WHEN 'inferred' THEN 1 ELSE 2 END)
        >= (CASE ?minConfidence WHEN 'tentative' THEN 0 WHEN 'inferred' THEN 1 ELSE 2 END)
    AND n.source_type NOT IN (?excludeSourceTypes)
  WHERE w.depth < ?maxDepth
    AND instr(w.visited, ',' || (CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END) || ',') = 0
)
SELECT node_id, MIN(depth) AS depth
FROM walk
GROUP BY node_id
ORDER BY depth ASC, (SELECT updated_at FROM entries WHERE id = node_id) DESC
LIMIT ?maxNodes;
```

`?edgeTypes` and `?excludeSourceTypes` are not single bind params — SQLite has no array binding. `getNeighborhood()` must build the `(?, ?, ...)` placeholder string dynamically (one `?` per array element, joined with `,`) and splice it into the SQL text *before* execution, then pass the flattened values as part of the single positional-params array handed to `SQLiteAdapter`. Same pattern as `EntryRepository.findByIds()`'s chunked `IN (...)` construction — do not attempt to bind the array directly as one parameter. When `excludeSourceTypes` is empty, the clause becomes `NOT IN ()`, which SQLite evaluates as always-true (no exclusion) — verify this with a unit test rather than special-casing it.

---

## `GraphTraversalService`

New file, `packages/core/src/services/GraphTraversalService.ts`, alongside `RetrievalService`, `OntologyService`, `MaintenanceService`. Pure orchestrator — no SQL.

```typescript
export class GraphTraversalService {
  constructor(
    private edgeRepo: EdgeRepository,
    private entryRepo: EntryRepository,
    private config: WikiConfig,
  ) {}

  async traverseGraph(entityId: string, options: GraphTraversalOptions): Promise<GraphNeighborhood> {
    const opts: NeighborhoodQueryOptions = {
      maxDepth: Math.max(1, Math.min(options.maxDepth ?? 1, 3)),
      direction: options.direction ?? this.config.traversalDirection ?? 'both',
      edgeTypes: options.edgeTypes,
      minConfidence: options.minTraversalConfidence ?? this.config.minTraversalConfidence ?? 'tentative',
      excludeSourceTypes: options.excludeSourceTypes ?? this.config.excludeSourceTypes ?? [],
      maxNodes: options.maxTraversalNodes ?? this.config.maxTraversalNodes ?? 20,
    };

    const { nodeIds, edges } = await this.edgeRepo.getNeighborhood(entityId, options.sourceId, opts);
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    // findByIds() already returns facts in input-ID order (Map-based lookup,
    // see packages/core/src/repositories/EntryRepository.ts:78-109) — no
    // re-sort needed here.
    const nodes = await this.entryRepo.findByIds(nodeIds, [entityId]);
    return { nodes, edges };
  }
}
```

### Error / edge cases

| Case | Behavior |
| :--- | :--- |
| `sourceId` missing, soft-deleted, or belongs to a different `entityId` | `{ nodes: [], edges: [] }`, no throw — matches `read()`'s graceful-empty convention. |
| `maxDepth` outside `[1, 3]` | Silently clamped, not an error — caller mistakes shouldn't break a conversation. |
| `edgeTypes: []` | Treated as "match nothing." `undefined` means "no filter." |
| `excludeSourceTypes` empty | No exclusion (default — all source types traversable). |

`WikiMemory.traverseGraph(entityId, options)` (`packages/core/src/WikiMemory.ts`) is a one-line delegate to `GraphTraversalService.traverseGraph()`, same shape as the existing `getOntologyManifest` delegate.

---

## `formatGraphContext()`

Pure function, `packages/core/src/utils/formatGraphContext.ts` (sibling to `ontology.ts`), **exported from `packages/core/src/index.ts`** so host applications can format a `GraphNeighborhood` before injecting it into a prompt without re-deriving the logic.

```typescript
export function formatGraphContext(neighborhood: GraphNeighborhood): string
```

Output shape (per the original draft):

```text
[person] John Doe (ID: 123)
  -[reports_to]-> [person] Jane Smith
  <-[contributes_to]- [project] Alpha Rewrite
```

**Determinism:**
- Top-level grouping follows `neighborhood.nodes` order as already produced by `GraphTraversalService` (depth ASC, then `updated_at` DESC).
- For each node, render its outbound edges (`-[type]->`) before inbound edges (`<-[type]-`).
- Within each direction group, sort by `edge_type` then by the connected node's `title`.

This keeps repeated calls with the same underlying data byte-identical, which matters for prompt caching.

---

## React hook (`react-llm-wiki`)

`packages/react/src/useWikiTraversal.ts`, mirrors `useMemoryRead`/`useOntologyManifest`'s fetch-on-mount, refetch-on-change, in-flight-queue contract.

```typescript
export interface WikiTraversalState {
  nodes: WikiFact[];
  edges: WikiEdge[];
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useWikiTraversal(entityId: string, options: GraphTraversalOptions): WikiTraversalState;
```

**Behavior:**

1. Reads `wiki` via `useWiki()`.
2. On mount and whenever `entityId` or a *stable serialization* of `options` changes, calls `wiki.traverseGraph(entityId, options)`.
3. Uses the in-flight fetch queue pattern from `useMemoryRead` (`packages/react/src/useMemoryRead.ts:125-155`) — never discards an in-flight result.
4. **Stable options key:** `normalizeReadOptionsKey` in `useMemoryRead.ts` is a private, file-local helper (not exported) — `useWikiTraversal.ts` implements its own local `normalizeTraversalOptionsKey(options)` following the same approach (sort/normalize known fields into a deterministic string for the `useEffect` dependency), rather than importing across hook files. This avoids the infinite-refetch risk of a naive `JSON.stringify` on an inline object literal.
5. Naming: `isPending`, not `isLoading` — matches every other hook in this package.

---

## `core-llm-tools` manifests

New file `packages/core-llm-tools/src/manifests/graph.ts`. Scope `memory:read` for both (read-only, per the existing `AgentScope` union) — the live agent never writes edges directly; that stays in the background `runLibrarian` pass.

```typescript
export const wikiGetOntologyManifest: FunctionToolManifest = {
  name: 'wiki_get_ontology',
  scope: 'memory:read',
  kind: 'function',
  schema: {
    name: 'wiki_get_ontology',
    description: "Retrieve the current ontology manifest (allowed node types and edge types) for the user's memory. Use this to understand the structure of the knowledge graph and what relationships exist.",
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The namespace/entity ID to inspect.' },
      },
      required: ['entityId'],
    },
  },
};

export const wikiTraverseGraphManifest: FunctionToolManifest = {
  name: 'wiki_traverse_graph',
  scope: 'memory:read',
  kind: 'function',
  schema: {
    name: 'wiki_traverse_graph',
    description: 'Traverse the knowledge graph starting from a specific fact ID to discover connected concepts and relationships. Returns a formatted neighborhood subgraph.',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The namespace/entity ID to traverse.' },
        sourceId: { type: 'string', description: 'The exact ID of the starting fact node (obtained from a previous wiki_read call).' },
        maxDepth: { type: 'integer', description: 'How many relationship hops to traverse. Maximum allowed is 3.' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: "The direction of relationships to follow. Default 'both'." },
        edgeTypes: { type: 'array', items: { type: 'string' }, description: 'Optional filter. If provided, traversal only follows these edge types (e.g. ["reports_to", "depends_on"]).' },
      },
      required: ['entityId', 'sourceId'],
    },
  },
};
```

**Package boundary:** `core-llm-tools` contains *only* these JSON schema declarations and their `memory:read` scope tag — it has no dependency on `core-llm-wiki` and does not call `traverseGraph()` or `formatGraphContext()` itself. The host application's tool executor (wherever it registers function-calling tools with a model runner) is responsible for: receiving the model's tool call, invoking `wiki.traverseGraph(entityId, options)`, passing the result through `formatGraphContext()`, and returning the formatted string as the tool result. That wiring is out of scope for this repo (see Non-Goals).

---

## Testing

- **`EdgeRepository.getNeighborhood()`** (unit, real SQLite): depth clamp behavior at the caller boundary; `direction` in/out/both; `edgeTypes` allow-list including the explicit-`[]` short-circuit; confidence dead-end (a `tentative` node blocks traversal past it); `excludeSourceTypes` dead-end; cycle guard via a hand-built cyclic fixture (A→B→A); node cap + depth/recency tie-break ordering; anchor returned even when its own confidence/source_type would fail the discovered-node gate; empty result for missing/cross-entity/soft-deleted `sourceId`.
- **`GraphTraversalService`**: config-default vs. per-call-option precedence for all four tunables; empty-result passthrough; entity-scoped hydration via `findByIds(ids, [entityId])`.
- **`formatGraphContext()`**: pure-function snapshot tests; deterministic ordering across repeated calls with identical input.
- **`useWikiTraversal`**: extend `packages/react/__tests__/hooks.test.tsx`, same `makeMockWiki()` + `wrapper` pattern as `useOntologyManifest` — initial fetch, `options`-change refetch, error path, queued-fetch-while-in-flight, `refetch()`.
- **Tool manifests**: schema-shape validation only (`name`, `scope`, required params) — no executor behavior to test in this repo.

---

## File map

| Action | Path | Responsibility |
| :--- | :--- | :--- |
| Modify | `packages/core/src/types.ts` | `GraphTraversalOptions`, `GraphNeighborhood`, `WikiConfig` additions |
| Modify | `packages/core/src/repositories/EdgeRepository.ts` | `getNeighborhood()` |
| Create | `packages/core/src/services/GraphTraversalService.ts` | Orchestration |
| Modify | `packages/core/src/WikiMemory.ts` | `traverseGraph()` delegate |
| Create | `packages/core/src/utils/formatGraphContext.ts` | Presenter utility |
| Modify | `packages/core/src/index.ts` | Export `formatGraphContext`, `GraphTraversalOptions`, `GraphNeighborhood` |
| Create | `packages/react/src/useWikiTraversal.ts` | Reactive hook |
| Modify | `packages/react/src/index.ts` | Export hook + `WikiTraversalState` |
| Modify | `packages/react/__tests__/hooks.test.tsx` | Unit tests |
| Create | `packages/core-llm-tools/src/manifests/graph.ts` | `wikiGetOntologyManifest`, `wikiTraverseGraphManifest` |
| Modify | `packages/core-llm-tools/src/index.ts` | Export new manifests |
| Modify | `packages/react/README.md`, `packages/expo/README.md` | Document `useWikiTraversal` (follow the checklist structure used in [2026-06-23-ontology-react-hooks-design.md](./2026-06-23-ontology-react-hooks-design.md)) |

No `packages/core/src/db/schema.ts` changes — every column this feature reads already exists.

---

## Versioning & changelog

- **Do not edit `CHANGELOG.md` manually** — semantic-release generates entries from conventional commits.
- Suggested PR title: `feat(core): add knowledge graph traversal API`, with a follow-up or same-PR `feat(react): add useWikiTraversal hook` and `feat(core-llm-tools): add wiki_get_ontology and wiki_traverse_graph manifests` depending on how the implementation plan splits the work.

---

## Acceptance

- [ ] `EdgeRepository.getNeighborhood()` passes all cases in §Testing.
- [ ] `GraphTraversalService.traverseGraph()` and `WikiMemory.traverseGraph()` implemented and delegate correctly.
- [ ] `formatGraphContext()` exported from `core-llm-wiki` public surface, deterministic output verified by snapshot test.
- [ ] `useWikiTraversal` exported from `packages/react` and reachable via `packages/expo` with zero expo-package code changes.
- [ ] `wikiGetOntologyManifest` and `wikiTraverseGraphManifest` exported from `core-llm-tools`, scope `memory:read`.
- [ ] No `packages/core/src/db/schema.ts` changes.
- [ ] `packages/react/README.md` and `packages/expo/README.md` document `useWikiTraversal`.
- [ ] `CHANGELOG.md` untouched.
