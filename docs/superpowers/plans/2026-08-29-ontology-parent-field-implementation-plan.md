# Ontology Single-Level Parent Inheritance — Implementation Plan

**Date:** 2026-08-29
**Status:** PLAN (execution)
**Spec:** `docs/superpowers/specs/2026-08-28-ontology-parent-field-spec.md`
**Author:** Tessera
**Estimated Effort:** Small (~2–4 hours)
**Branch:** `docs/ontology-parent-field-spec` (spec branch; implement on a feature branch cut from `main`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `parent` field to `OntologyNodeType` so a concrete type (e.g. `design_spec`) satisfies edge definitions declared for its parent type (e.g. `creativework`) — one level only, validation and persistence, no schema migration.

**Architecture:** Pure TypeScript change in `@equationalapplications/core-llm-wiki`. `parent` rides on the existing JSON manifest (persisted in `entity_manifests.manifest_json`), so no SQLite/migration work. Edge matching gets a single shared helper (`edgeDefMatchesSourceType`) used by the one validation gate and all three persistence gates. Prompt text advertises the field so the LLM can propose children with parents.

**Tech Stack:** TypeScript (strict), vitest, pnpm workspace, tsup build.

---

## Global Constraints

- Package under test: `packages/core` (`@equationalapplications/core-llm-wiki`, currently 6.0.1). All commands run from repo root: `~/code/github/equationalapplications/expo-llm-wiki`.
- Test runner: vitest. Core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`. Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`.
- `tsconfig.json` has `"strict": true` (no `exactOptionalPropertyTypes`) — conditional-spread is the pattern for optional fields.
- **D1:** One-level parent only. `validateManifest` must reject parent chains deeper than 1.
- **D2:** `resolveNodeType` is NOT parent-aware — exact 1:1 match, unchanged.
- **D4:** No SQLite schema, migration, `WikiFact`/`WikiEdge` type, or persisted-type changes.
- Merge convention (all Equational repos): regular merge commits, never squash.
- Commit style: conventional commits (`feat:`, `fix:`, `test:`), as used on this branch (`docs(spec): rev 2 — …`).

## Spec corrections found during codebase verification

The plan implements the spec's **intent**; four claims needed correction against the code at commit `3cbddec`:

| # | Spec says | Code reality | Plan resolution |
|---|-----------|--------------|-----------------|
| 1 | Update "format example in the backfill prompt" (`EXAMPLE_JSON`) in `packages/core/src/prompts/ontology.ts` | No `EXAMPLE_JSON` exists. The backfill prompt is `ONTOLOGY_BACKFILL_SYSTEM_PROMPT` in `src/prompts.ts` (classifies facts; does not propose types). The propose-a-type format example is `EMERGENT_EXTRA` in `src/prompts/ontology.ts:9-15`. | Task 4 updates `EMERGENT_EXTRA`'s `node_types` schema line. No change to `ONTOLOGY_BACKFILL_SYSTEM_PROMPT` (D5's manifest-JSON serialization already carries `parent` via `JSON.stringify`). |
| 2 | `mergeOntologyUpdates` — "no change. Nodes with `parent` are pushed as-is." | `src/utils/ontology.ts:86` rebuilds merged nodes as `{ type, description }`, **stripping `parent`**. An LLM-proposed child type would silently lose its parent. | Task 2 adds the fix + regression tests. |
| 3 | Only `validateInlineEdges` becomes parent-aware ("Target types are not checked at this layer") | Two **persistence-side** matchers also do exact `source_type` matching: `OntologyService.resolveEdges` (`src/services/OntologyService.ts:134`) and the `upsertGraph` filter (`src/services/IngestionService.ts:472-474`). Without updating them, child-source edges validate but **silently fail to persist**. | Task 3 routes both (plus `validateInlineEdges`) through one shared helper. Target-type matching stays exact everywhere (per D3). |
| 4 | Risks table: "`validateManifest` should reject chains > 1" — but the Changes section omits the check | The spec's own snippet would accept `design_spec→creativework→thing`. | Task 1 adds an explicit `Parent chain too deep` check implementing D1's guarantee. |

Non-goal restated from spec §"What This Does NOT Include": no recursive resolution at runtime, no `traverseGraph` changes, no read-query is-a inference, no UI changes.

---

### Task 1: `parent` field on `OntologyNodeType` + manifest validation + shared matcher

**Files:**
- Modify: `packages/core/src/types.ts:40-43` (`OntologyNodeType`)
- Modify: `packages/core/src/utils/ontology.ts` (`validateManifest`, `validateInlineEdges`, new export)
- Test: `packages/core/__tests__/utils/ontology.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: existing `validateManifest(manifest): void`, `validateInlineEdges(sourceType, _targetType, edges, manifest, opts?): ExtractedFactEdge[]`.
- Produces (used by later tasks):
  - `OntologyNodeType.parent?: string` — trimmed parent slug, must exist in the same manifest.
  - `edgeDefMatchesSourceType(def: { source_type: string }, concreteType: string, manifest: OntologyManifest): boolean` — true if `concreteType` equals `def.source_type` exactly (case-insensitive) OR `concreteType`'s `parent` equals `def.source_type` (case-insensitive). One hop, never recursive.
  - `validateManifest` throws, in order: `Self-parent: <type>`, `Parent type not found: <slug>`, `Parent chain too deep: <a> → <b> → <c>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__tests__/utils/ontology.test.ts` (imports at the top of the file already cover everything except nothing new is needed — `validateManifest`, `resolveNodeType`, `validateInlineEdges` are already imported there):

```ts
const parentManifest: OntologyManifest = {
  node_types: [
    { type: 'creativework', description: 'Parent content type.' },
    { type: 'design_spec', description: 'A design spec.', parent: 'creativework' },
    { type: 'software_application', description: 'An app.' },
  ],
  edge_types: [
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'subject matter' },
    { type: 'assigns', source_type: 'software_application', target_type: 'person', description: 'owner' },
  ],
};

describe('ontology parent inheritance', () => {
  it('validateManifest accepts manifests without any parent fields', () => {
    expect(() => validateManifest(manifest)).not.toThrow(); // existing top-level `manifest`
  });

  it('validateManifest accepts a valid parent reference', () => {
    expect(() => validateManifest(parentManifest)).not.toThrow();
  });

  it('validateManifest rejects self-parent (case-insensitive)', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'design_spec', description: 'x', parent: 'Design_Spec' },
      ],
      edge_types: [],
    })).toThrow(/Self-parent/);
  });

  it('validateManifest rejects a parent slug that does not exist', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'design_spec', description: 'x', parent: 'nonexistent' },
      ],
      edge_types: [],
    })).toThrow(/Parent type not found/);
  });

  it('validateManifest rejects parent chains deeper than one level (D1)', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'thing', description: 'root' },
        { type: 'creativework', description: 'mid', parent: 'thing' },
        { type: 'design_spec', description: 'leaf', parent: 'creativework' },
      ],
      edge_types: [],
    })).toThrow(/Parent chain too deep/);
  });

  it('validateInlineEdges accepts a child source for an edge declared on the parent', () => {
    const valid = validateInlineEdges('design_spec', null, [
      { edge_type: 'about', target_title: 'Jane Doe' },
    ], parentManifest);
    expect(valid).toEqual([{ edge_type: 'about', target_title: 'Jane Doe' }]);
  });

  it('validateInlineEdges strict mode does not throw for a parent-matched source', () => {
    expect(() => validateInlineEdges('design_spec', null, [
      { edge_type: 'about', target_title: 'Jane Doe' },
    ], parentManifest, { strict: true, entityId: 'e1' })).not.toThrow();
  });

  it('validateInlineEdges does not accept a child whose parent is a different type', () => {
    const valid = validateInlineEdges('design_spec', null, [
      { edge_type: 'assigns', target_title: 'Jane Doe' },
    ], parentManifest);
    expect(valid).toEqual([]); // assigns is declared on software_application, not creativework
  });

  it('validateInlineEdges still rejects unknown edge types', () => {
    const valid = validateInlineEdges('design_spec', null, [
      { edge_type: 'nonexistent_edge', target_title: 'x' },
    ], parentManifest);
    expect(valid).toEqual([]);
  });

  it('resolveNodeType stays exact 1:1 — parent is never consulted (D2)', () => {
    expect(resolveNodeType('design_spec', parentManifest)).toBe('design_spec');
    expect(resolveNodeType('CreativeWork', parentManifest)).toBe('creativework');
    expect(resolveNodeType('thing', parentManifest)).toBeNull(); // not in manifest at all
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology.test`
Expected: FAIL — TypeScript/Vitest errors: `parent` does not exist on `OntologyNodeType`; `Self-parent`/`Parent type not found`/`Parent chain too deep` never thrown; parent-matched edge dropped (`[]` instead of accepted).

- [ ] **Step 3: Write the minimal implementation**

`packages/core/src/types.ts:40-43` — replace the interface with:

```ts
export interface OntologyNodeType {
  type: string;
  description: string;
  /** Optional parent type slug. One level only — parent must exist in the same manifest. */
  parent?: string;
}
```

`packages/core/src/utils/ontology.ts` — add the shared matcher above `validateManifest`:

```ts
/**
 * True when `concreteType` satisfies an edge definition's declared source_type:
 * either an exact (case-insensitive) match, or a one-hop parent match — the
 * concrete type's `parent` equals the declared source_type. Never recursive (D1).
 */
export function edgeDefMatchesSourceType(
  def: { source_type: string },
  concreteType: string,
  manifest: OntologyManifest,
): boolean {
  const concrete = concreteType.trim().toLowerCase();
  if (!concrete) return false;
  if (def.source_type.trim().toLowerCase() === concrete) return true;
  const srcDef = manifest.node_types.find(n => n.type.trim().toLowerCase() === concrete);
  return !!srcDef?.parent?.trim()
    && srcDef.parent.trim().toLowerCase() === def.source_type.trim().toLowerCase();
}
```

Inside `validateManifest`, insert after the `nodeSlugs` loop (line 44, before the `edgeKeys` declaration) and before the edge loop:

```ts
  // D1: optional one-level parent inheritance. A parent must be a real,
  // distinct node in the same manifest, and must not itself have a parent.
  for (const node of manifest.node_types ?? []) {
    const parentSlug = node.parent?.trim().toLowerCase();
    if (!parentSlug) continue;
    if (parentSlug === node.type.trim().toLowerCase()) {
      throw new Error(`Self-parent: ${node.type}`);
    }
    if (!nodeSlugs.has(parentSlug)) {
      throw new Error(`Parent type not found: ${node.parent}`);
    }
    const parent = (manifest.node_types ?? []).find(
      n => n.type.trim().toLowerCase() === parentSlug,
    );
    if (parent?.parent?.trim()) {
      throw new Error(`Parent chain too deep: ${node.type} → ${parent.type} → ${parent.parent}`);
    }
  }
```

In `validateInlineEdges`, replace line 132 (`const match = defs.find(...)`):

```ts
    const match = defs.find(d => edgeDefMatchesSourceType(d, sourceType, manifest));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology.test`
Expected: PASS — all prior tests in the file still green (no-parent manifests validate identically → D4).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/utils/ontology.ts packages/core/__tests__/utils/ontology.test.ts
git commit -m "feat(ontology): optional parent field with one-level manifest validation"
```

---

### Task 2: `mergeOntologyUpdates` must preserve `parent`

**Files:**
- Modify: `packages/core/src/utils/ontology.ts:81-88` (node merge loop)
- Test: `packages/core/__tests__/utils/ontology.test.ts` (same new `describe` block)

**Interfaces:**
- Consumes: `OntologyNodeType.parent` (Task 1).
- Produces: `mergeOntologyUpdates(current, updates)` keeps a proposed node's `parent` (trimmed) verbatim in the merged manifest; nodes without `parent` merge exactly as before (no `parent` key added).

- [ ] **Step 1: Write the failing tests**

Append to the `ontology parent inheritance` describe block:

```ts
  it('mergeOntologyUpdates preserves parent on proposed child types', () => {
    const merged = mergeOntologyUpdates(emptyManifest(), {
      node_types: [
        { type: 'creativework', description: 'Parent.' },
        { type: 'design_spec', description: 'Child.', parent: 'creativework' },
      ],
      edge_types: [],
    });
    const child = merged.node_types.find(n => n.type === 'design_spec');
    expect(child?.parent).toBe('creativework');
    expect(() => validateManifest(merged)).not.toThrow();
  });

  it('mergeOntologyUpdates leaves parent undefined for plain nodes (no key churn)', () => {
    const merged = mergeOntologyUpdates(emptyManifest(), {
      node_types: [{ type: 'person', description: 'A person.' }],
      edge_types: [],
    });
    expect(merged.node_types[0]).toEqual({ type: 'person', description: 'A person.' });
    expect('parent' in merged.node_types[0]).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology.test`
Expected: FAIL — first test gets `child?.parent === undefined` (line 86 rebuilds `{ type, description }`).

- [ ] **Step 3: Write the minimal implementation**

In `mergeOntologyUpdates`, replace line 86:

```ts
    node_types.push({ type, description: String(node.description ?? '') });
```

with:

```ts
    node_types.push({
      type,
      description: String(node.description ?? ''),
      ...(node.parent?.trim() ? { parent: node.parent.trim() } : {}),
    });
```

(Conditional spread keeps `parent` absent rather than `undefined` — matches the no-key-churn assertion and the existing serialization shape.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology.test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/utils/ontology.ts packages/core/__tests__/utils/ontology.test.ts
git commit -m "fix(ontology): preserve parent field when merging emergent node updates"
```

---

### Task 3: Parent-aware source matching at the persistence gates

**Files:**
- Modify: `packages/core/src/services/OntologyService.ts:134` (`resolveEdges` filter)
- Modify: `packages/core/src/services/IngestionService.ts:472-475` (`upsertGraph` edge filter)
- Test: `packages/core/__tests__/services/OntologyService.test.ts` (append to existing `OntologyService` describe)
- Test: `packages/core/__tests__/upsertGraphContract.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `edgeDefMatchesSourceType(def, concreteType, manifest)` from Task 1.
- Produces: `resolveEdges(...)` and `upsertGraph(...)` persist edges whose source type satisfies the declared `source_type` via one-hop parent match. Exact-match defs and parent-derived defs are both candidates; `target_type` (exact, unchanged) disambiguates when several defs share an edge name. Signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__tests__/services/OntologyService.test.ts` (reuse the file's existing `makeMocks()` helper):

```ts
describe('OntologyService.resolveEdges — parent inheritance', () => {
  const parentEdgeManifest: OntologyManifest = {
    node_types: [
      { type: 'creativework', description: 'Parent.' },
      { type: 'design_spec', description: 'Child.', parent: 'creativework' },
      { type: 'person', description: 'Person.' },
    ],
    edge_types: [
      { type: 'about', source_type: 'creativework', target_type: 'person', description: 'x' },
    ],
  };

  it('child source type satisfies an edge declared for its parent', () => {
    const { metadataRepo, edgeRepo } = makeMocks();
    const svc = new OntologyService(metadataRepo, edgeRepo);
    const titleIndex = new Map([['jane doe', { id: 'p1', okf_type: 'person' }]]);
    const edges = svc.resolveEdges(
      'e1', 'f1', 'design_spec',
      [{ edge_type: 'about', target_title: 'Jane Doe' }],
      parentEdgeManifest, titleIndex, 1000,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      entity_id: 'e1', source_id: 'f1', target_id: 'p1', edge_type: 'about',
    });
  });

  it('exact source match and parent-derived match are both candidates; target_type disambiguates', () => {
    const { metadataRepo, edgeRepo } = makeMocks();
    const svc = new OntologyService(metadataRepo, edgeRepo);
    const manifest: OntologyManifest = {
      node_types: parentEdgeManifest.node_types,
      edge_types: [
        { type: 'about', source_type: 'creativework', target_type: 'person', description: 'parent-def' },
        { type: 'about', source_type: 'design_spec', target_type: 'creativework', description: 'exact-def' },
      ],
    };
    const titleIndex = new Map([
      ['jane doe', { id: 'p1', okf_type: 'person' }],
      ['the spec', { id: 'c1', okf_type: 'creativework' }],
    ]);
    // Target 'person' → parent-def wins; target 'the spec' → exact-def wins.
    const toPerson = svc.resolveEdges('e1', 'f1', 'design_spec',
      [{ edge_type: 'about', target_title: 'Jane Doe' }], manifest,
      new Map([['jane doe', { id: 'p1', okf_type: 'person' }]]), 1000);
    expect(toPerson[0]?.edge_type).toBe('about');
    expect(toPerson[0]?.target_id).toBe('p1');
    const toWork = svc.resolveEdges('e1', 'f1', 'design_spec',
      [{ edge_type: 'about', target_title: 'The Spec' }], manifest,
      new Map([['the spec', { id: 'c1', okf_type: 'creativework' }]]), 1000);
    expect(toWork[0]?.target_id).toBe('c1');
  });

  it('child source does not satisfy an edge declared on an unrelated type', () => {
    const { metadataRepo, edgeRepo } = makeMocks();
    const svc = new OntologyService(metadataRepo, edgeRepo);
    const manifest: OntologyManifest = {
      node_types: [
        { type: 'software_application', description: 'App.' },
        { type: 'design_spec', description: 'Child.', parent: 'creativework' },
        { type: 'person', description: 'Person.' },
      ],
      edge_types: [
        { type: 'assigns', source_type: 'software_application', target_type: 'person', description: 'x' },
      ],
    };
    const edges = svc.resolveEdges('e1', 'f1', 'design_spec',
      [{ edge_type: 'assigns', target_title: 'Jane Doe' }], manifest,
      new Map([['jane doe', { id: 'p1', okf_type: 'person' }]]), 1000);
    expect(edges).toEqual([]);
  });
});
```

Append to `packages/core/__tests__/upsertGraphContract.test.ts` (file already imports `WikiMemory`, `openTestDatabase`, `setupDatabase`, `SQLiteAdapter`):

```ts
describe('upsertGraph — parent-inherited source matching', () => {
  let db: SQLiteAdapter;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
  });

  it('persists an edge whose source type satisfies the declared type via parent', async () => {
    await wiki.setOntologyManifest('entity-1', {
      node_types: [
        { type: 'creativework', description: 'Parent.' },
        { type: 'design_spec', description: 'Child.', parent: 'creativework' },
        { type: 'person', description: 'Person.' },
      ],
      edge_types: [
        { type: 'about', source_type: 'creativework', target_type: 'person', description: 'x' },
      ],
    }, { mode: 'strict' });

    const result = await db.withTransactionAsync(tx =>
      wiki.upsertGraph('entity-1', {
        sourceRef: 'spec.md',
        sourceHash: 'b'.repeat(64),
        nodes: [
          { id: 'f1', type: 'design_spec', title: 'Spec' },
          { id: 'f2', type: 'person', title: 'Jane Doe' },
        ],
        edges: [{ sourceId: 'f1', type: 'about', targetId: 'f2' }],
      }, tx),
    );
    expect(result).toMatchObject({ nodesWritten: 2, edgesWritten: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- OntologyService.test upsertGraphContract`
Expected: FAIL — `resolveEdges` child test gets `[]`; upsertGraph gets `edgesWritten: 0` (both filters are exact-match only).

- [ ] **Step 3: Write the minimal implementation**

`packages/core/src/services/OntologyService.ts` — add to the import block from `'../utils/ontology'` (line 16-22): `edgeDefMatchesSourceType`. Then replace line 134:

```ts
      const candidates = resolveEdgeDefinitions(edge.edge_type, manifest)
        .filter(d => edgeDefMatchesSourceType(d, sourceType, manifest));
```

`packages/core/src/services/IngestionService.ts` — import `edgeDefMatchesSourceType` from `'../utils/ontology'` (add to the existing import from that module if present, otherwise add a new import). Replace lines 472-475:

```ts
      const candidates = (manifest.edge_types ?? []).filter(d =>
        d.type.toLowerCase() === edge.type.toLowerCase()
        && edgeDefMatchesSourceType(d, sourceType ?? '', manifest),
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- OntologyService.test upsertGraphContract ingest.test`
Expected: PASS — including the pre-existing ingest tests (exact-match behavior is preserved: `edgeDefMatchesSourceType` returns true on exact match first).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/OntologyService.ts packages/core/src/services/IngestionService.ts packages/core/__tests__/services/OntologyService.test.ts packages/core/__tests__/upsertGraphContract.test.ts
git commit -m "feat(ontology): parent-aware source matching when persisting edges"
```

---

### Task 4: Prompt visibility for `parent` (D5)

**Files:**
- Modify: `packages/core/src/prompts/ontology.ts:9-15` (`EMERGENT_EXTRA`)
- Test: `packages/core/__tests__/services/PromptService.test.ts` (the file already imports `buildOntologyPromptAppendix`)

**Interfaces:**
- Consumes: nothing new.
- Produces: emergent-mode instructions whose `ontology_updates.node_types` schema line advertises the optional `parent` field. The manifest JSON itself already serializes `parent` automatically (`OntologyService.buildPromptContext` → `JSON.stringify(manifest, null, 2)`), so strict-mode and backfill prompts need no change.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('PromptService', ...)` block (or as a sibling describe at the end of the file):

```ts
describe('ontology prompt — parent field advertisement', () => {
  it('emergent ontology_updates schema advertises the optional parent field', () => {
    const { ontologyModeInstructions } = buildOntologyPromptAppendix(
      'emergent', '{"node_types":[],"edge_types":[]}',
    );
    expect(ontologyModeInstructions).toContain('"parent"');
    expect(ontologyModeInstructions).toContain('parent_slug');
  });

  it('strict mode instructions do not propose types (unchanged)', () => {
    const { ontologyModeInstructions } = buildOntologyPromptAppendix(
      'strict', '{"node_types":[],"edge_types":[]}',
    );
    expect(ontologyModeInstructions).not.toContain('ontology_updates');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- PromptService.test`
Expected: FAIL — `EMERGENT_EXTRA` has no `"parent"` yet.

- [ ] **Step 3: Write the minimal implementation**

In `packages/core/src/prompts/ontology.ts`, replace the `node_types` line inside `EMERGENT_EXTRA` (line 12):

```ts
  "node_types": [{ "type": "slug", "description": "...", "parent": "parent_slug (optional)" }],
```

leaving the `edge_types` line and the surrounding text untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- PromptService.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/prompts/ontology.ts packages/core/__tests__/services/PromptService.test.ts
git commit -m "feat(ontology): advertise optional parent field in emergent prompt schema"
```

---

### Task 5: End-to-end integration coverage

**Files:**
- Create: `packages/core/__tests__/ontologyParentInheritance.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, exercised through the public `WikiMemory` API.
- Produces: confidence that (a) a `parent`-bearing manifest survives the persist → `validateManifest` → JSON.parse round-trip in `MetadataRepository`, (b) the backfill path types a fact as a child type and persists a parent-declared edge, (c) deep chains are rejected at the public API boundary.

- [ ] **Step 1: Write the integration tests**

Create `packages/core/__tests__/ontologyParentInheritance.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { createWiki } from '../src/index';
import type { OntologyManifest, SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';

const PARENT_MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'creativework', description: 'Parent content type.' },
    { type: 'design_spec', description: 'A design spec.', parent: 'creativework' },
    { type: 'person', description: 'A person.' },
  ],
  edge_types: [
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'subject' },
  ],
};

async function makeParentWiki(mode: 'strict' | 'emergent' | 'off' = 'strict') {
  const db = openTestDatabase();
  const generateText = vi.fn<any>();
  const wiki = createWiki(db, { llmProvider: { generateText } } as any);
  await wiki.setup();
  await wiki.setOntologyManifest('e1', PARENT_MANIFEST, { mode });
  return { db, wiki, generateText };
}

async function seedEntry(db: SQLiteAdapter, opts: {
  id: string; title?: string; okfType?: string | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at,
        access_count, deleted_at, okf_type, ontology_checked_at)
     VALUES (?, 'e1', ?, ?, '[]', 'certain', 'user_stated', 1000, 1000, 0, NULL, ?, NULL)`,
    [opts.id, opts.title ?? `title ${opts.id}`, `body ${opts.id}`, opts.okfType ?? null],
  );
}

describe('ontology parent inheritance — end to end', () => {
  it('a parent-bearing manifest survives the persist/validate/parse round-trip', async () => {
    const { wiki } = await makeParentWiki('strict');
    const state = await wiki.getOntologyManifest('e1');
    expect(state).not.toBeNull();
    expect(state!.manifest.node_types.find(n => n.type === 'design_spec')?.parent)
      .toBe('creativework');
  });

  it('setOntologyManifest rejects a two-level chain at the public API boundary', async () => {
    const db = openTestDatabase();
    const wiki = createWiki(db, { llmProvider: { generateText: async () => '{}' } } as any);
    await wiki.setup();
    await expect(wiki.setOntologyManifest('e1', {
      node_types: [
        { type: 'thing', description: 'root' },
        { type: 'creativework', description: 'mid', parent: 'thing' },
        { type: 'design_spec', description: 'leaf', parent: 'creativework' },
      ],
      edge_types: [],
    }, { mode: 'strict' })).rejects.toThrow(/Parent chain too deep/);
  });

  it('backfill types a fact with a child type and persists a parent-declared edge', async () => {
    const { db, wiki, generateText } = await makeParentWiki('strict');
    await seedEntry(db, { id: 'fact_spec', title: 'Checkout Redesign', okfType: null });
    await seedEntry(db, { id: 'fact_jane', title: 'Jane Doe', okfType: 'person' });

    generateText.mockResolvedValue(JSON.stringify({
      classifications: [{
        id: 'fact_spec',
        okf_type: 'design_spec',
        edges: [{ edge_type: 'about', target_title: 'Jane Doe' }],
      }],
    }));

    const result = await wiki.runOntologyBackfill('e1');
    expect(result.scanned).toBe(1);

    const typed = await db.getFirstAsync<{ okf_type: string }>(
      `SELECT okf_type FROM ${PREFIX}entries WHERE id = 'fact_spec'`);
    expect(typed!.okf_type).toBe('design_spec');

    const edgeRows = await db.getAllAsync<{ edge_type: string; target_id: string }>(
      `SELECT edge_type, target_id FROM ${PREFIX}edges WHERE source_id = 'fact_spec'`);
    expect(edgeRows).toEqual([{ edge_type: 'about', target_id: 'fact_jane' }]);
  });
});
```

Notes for the implementer:
- `makeParentWiki` mirrors the established `makeWiki` harness in `packages/core/__tests__/ontologyBackfill.test.ts:173-180` (`createWiki` + `setOntologyManifest`).
- `setOntologyManifest` persists through `MetadataRepository.setManifest`, which calls `validateManifest` (Task 1's new checks) and `getManifest` re-validates on every read — the round-trip test proves persisted `parent` passes both.
- The backfill test proves the full chain from Task 3: classification with a child type → `validateAndNormalizeFact` (Task 1's `validateInlineEdges` change) → `resolveAndPersistEdges` → `resolveEdges` (Task 3's `OntologyService` change) → edge row.

- [ ] **Step 2: Run the new file**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontologyParentInheritance`
Expected: PASS. If the backfill result shape differs (`result.scanned`), consult `OntologyBackfillResult` in `packages/core/src/types.ts:96` and assert on the DB rows instead — the DB assertions are the source of truth.

- [ ] **Step 3: Run the FULL core suite and typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test && pnpm --filter @equationalapplications/core-llm-wiki typecheck`
Expected: full suite green, no type errors. (`ingest.test.ts`, `ontologyBackfill.test.ts`, `healBounding.test.ts`, and `maintenance` tests exercise every changed call path — any red there means an exact-match regression, not flakiness.)

- [ ] **Step 4: Build the package**

Run: `pnpm --filter @equationalapplications/core-llm-wiki build`
Expected: clean tsup build (d.ts regeneration proves the public type surface compiles).

- [ ] **Step 5: Commit**

```bash
git add packages/core/__tests__/ontologyParentInheritance.test.ts
git commit -m "test(ontology): end-to-end parent inheritance coverage"
```

---

## Testing Strategy

- **Unit:** `packages/core/__tests__/utils/ontology.test.ts` — validation matrix (accept/no-parent, accept/valid-parent, reject self, reject missing, reject chain), matcher matrix (parent hit, wrong-parent miss, unknown-edge miss, strict no-throw), `resolveNodeType` exact-match regression (D2), merge preservation (Task 2).
- **Service:** `packages/core/__tests__/services/OntologyService.test.ts` — `resolveEdges` child/exact/unrelated matrix; `packages/core/__tests__/services/PromptService.test.ts` — prompt advertisement.
- **Contract/Integration:** `packages/core/__tests__/upsertGraphContract.test.ts` — persistence through `upsertGraph`; `packages/core/__tests__/ontologyParentInheritance.test.ts` — manifest round-trip, chain rejection at API boundary, backfill end-to-end.
- **Full gate:** `pnpm --filter @equationalapplications/core-llm-wiki test && pnpm --filter @equationalapplications/core-llm-wiki typecheck && pnpm --filter @equationalapplications/core-llm-wiki build`. Repo-wide `pnpm test` (includes integration workspace) before PR merge.

## Execution Order

1 → 2 → 3 → 4 → 5. Tasks 1–3 are strictly sequential (each consumes the previous task's exports). Task 4 is independent of Tasks 2–3 and could run in parallel, but at this size keep the branch linear. Each task is one commit; the PR contains all five (atomic feature).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Persistence gates missed → edges validate but never persist | Task 3 explicitly covers both exact-match persistence sites (found by exhaustive `source_type.toLowerCase() ===` sweep — only 4 sites exist in `src/`) |
| Persisted manifests from older versions fail the new `validateManifest` | New checks only fire when `parent` is present; pre-parent manifests are byte-identical (D4, covered by "accepts manifests without any parent fields") |
| Ambiguous edge names when both an exact and a parent-derived def match | `target_type` disambiguates (unchanged, still exact); covered by the "both candidates" test |
| Recursive inheritance sneaks in later | `Parent chain too deep` check makes D1 enforceable at every manifest write AND read |
| Consumers (Clanker pins, Curated Thoughts) | Type-only additive change; no published-version bump required in this PR. `schema-org-llm-wiki` is a separate package — untouched |

## Non-Goals (out of scope)

- Recursive/transitive inheritance resolution (D1)
- `resolveNodeType` parent matching (D2)
- SQLite schema/migration changes; `WikiFact`/`WikiEdge`/persisted-type changes (D4)
- `traverseGraph` changes; read-query is-a inference; UI changes (spec §Non-Goals)
- Parent-aware **target**-type matching (D3 — targets are entity titles at validation, exact `okf_type` slugs at resolution)
- schema-org-llm-wiki changes; Tessera-agent ~18-type manifest authoring (separate work)

## Acceptance Criteria Checklist

- [ ] `validateManifest` accepts warm-agent-style manifests with no `parent` fields
- [ ] `validateManifest` accepts valid one-level parents; rejects self-parent, missing parent, and 2-level chains
- [ ] `validateInlineEdges` accepts child source for parent-declared edge (lenient + strict), rejects wrong-parent and unknown edges
- [ ] `resolveNodeType` behavior unchanged (exact 1:1)
- [ ] `mergeOntologyUpdates` preserves `parent`; plain nodes merge with no `parent` key
- [ ] `resolveEdges` and `upsertGraph` persist parent-satisfied edges (integration-proven)
- [ ] Emergent prompt advertises optional `parent`; strict prompt unchanged
- [ ] Backfill end-to-end: fact typed as child + parent-declared edge persisted
- [ ] **FULL core suite green** + typecheck + clean build

## References

- **Spec:** `docs/superpowers/specs/2026-08-28-ontology-parent-field-spec.md` (rev 2, commit `3cbddec`)
- **Precedent:** polyManifest fixtures in `packages/core/__tests__/utils/ontology.test.ts:24-38` and `OntologyService.test.ts:25-40` (schema-org-flavored polymorphic edge sets); `makeWiki` harness in `ontologyBackfill.test.ts:173-180`
- **Pipeline map:** `validateInlineEdges` (validate) ↔ `OntologyService.resolveEdges:134` + `IngestionService.ts:472` (persist); `MetadataRepository.getManifest:164` re-validates persisted manifests on every read
