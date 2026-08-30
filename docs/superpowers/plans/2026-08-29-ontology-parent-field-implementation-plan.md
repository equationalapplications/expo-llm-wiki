# Ontology Single-Level Parent Inheritance — Implementation Plan

**Date:** 2026-08-29 (revised 2026-08-30 for spec rev 3)
**Status:** PLAN (execution)
**Spec:** `docs/superpowers/specs/2026-08-28-ontology-parent-field-spec.md` (rev 3)
**Author:** Tessera
**Estimated Effort:** Small (~2–4 hours)
**Branch:** `docs/ontology-parent-field-spec` (spec branch; implement on a feature branch cut from `main`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `parent_type` field to `OntologyNodeType` so a concrete type (e.g. `design_spec`) satisfies edge definitions declared for its parent type (e.g. `creativework`) — one level only, validation and persistence, no schema migration.

**Architecture:** Pure TypeScript change in `@equationalapplications/core-llm-wiki`. `parent_type` rides on the existing JSON manifest (persisted in `entity_manifests.manifest_json`), so no SQLite/migration work. Type matching gets a single primitive (`typeSatisfies`) used by all four gates — three source-side, one target-side. Prompt text advertises the field so the LLM can propose children with parents; the merge path treats those proposals as untrusted.

**Tech Stack:** TypeScript (strict), vitest, pnpm workspace, tsup build.

---

## Global Constraints

- Package under test: `packages/core` (`@equationalapplications/core-llm-wiki`, currently 6.0.1). All commands run from repo root: `~/code/github/equationalapplications/expo-llm-wiki`.
- Test runner: vitest. Core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`. Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`.
- `tsconfig.json` has `"strict": true` (no `exactOptionalPropertyTypes`) — conditional-spread is the pattern for optional fields.
- **D1:** One level only. `validateManifest` **rejects** parent chains deeper than 1.
- **D2:** `resolveNodeType` is NOT parent-aware — exact 1:1 match, unchanged.
- **D3:** Parent-aware on **both** sides. Targets resolve exact-first (two-pass).
- **D4:** All four gates route through the `typeSatisfies` primitive.
- **D5:** No SQLite schema, migration, `WikiFact`/`WikiEdge`, or persisted-type changes.
- **D6:** Emergent proposals are untrusted — `mergeOntologyUpdates` drops a bad `parent_type` rather than letting `validateManifest` throw inside a caller's transaction.
- **D7:** Parent types are instantiable. No `abstract` flag.
- **D8:** The field is `parent_type` — plain `parent` collides with the shipped `parent` edge type in the warm-agent manifest.
- **D10:** A present-but-blank `parent_type` throws; absent stays valid.
- **D11:** `getEffectiveState` validates seed manifests before use, on both branches.
- Merge convention (all Equational repos): regular merge commits, never squash.
- Commit style: conventional commits (`feat:`, `fix:`, `test:`), as used on this branch (`docs(spec): rev 3 — …`).

## Relationship to the spec

Spec rev 3 (2026-08-30) folded in every correction this plan previously tracked in a side table: the rename to `parent_type`, the three persistence gates, the `mergeOntologyUpdates` field-stripping bug, enforced chain rejection, the `EMERGENT_EXTRA` prompt target, and the new D6/D7 decisions. **The spec is now authoritative and self-consistent** — this plan implements it directly and no longer carries a corrections table. If the two ever disagree, the spec wins and this plan is the thing to fix.

The four source-matching gates (D4), found by an exhaustive `source_type.toLowerCase() ===` sweep over `src/`:

| Gate | Location | Task |
|------|----------|------|
| Validation | `utils/ontology.ts:132` (`validateInlineEdges`) | 1 |
| Persistence | `services/OntologyService.ts:134` (`resolveEdges`) | 3 |
| Persistence | `services/IngestionService.ts:472-475` (`upsertGraph`) | 3 |
| Definition | the shared helper itself | 1 |

---

### Task 1: `parent_type` field + manifest validation + shared matcher

**Files:**
- Modify: `packages/core/src/types.ts:40-43` (`OntologyNodeType`)
- Modify: `packages/core/src/utils/ontology.ts` (`validateManifest`, `validateInlineEdges`, new export)
- Test: `packages/core/__tests__/utils/ontology.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: existing `validateManifest(manifest): void`, `validateInlineEdges(sourceType, _targetType, edges, manifest, opts?): ExtractedFactEdge[]`.
- Produces (used by later tasks):
  - `OntologyNodeType.parent_type?: string` — trimmed parent slug; must exist in the same manifest and must not itself have a `parent_type`.
  - `typeSatisfies(declaredType: string, concreteType: string, manifest: OntologyManifest): boolean` — true if `concreteType` equals `declaredType` exactly (case-insensitive) OR `concreteType`'s `parent_type` equals it. One hop, never recursive. Guards `manifest.node_types`.
  - `validateManifest` throws, in order: `Ontology parent_type must be non-empty when present: <type>` (D10), `Self-parent: <type>`, `Parent type not found: <slug>`, `Parent chain too deep: <a> → <b> → <c>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__tests__/utils/ontology.test.ts` (`validateManifest`, `resolveNodeType`, `validateInlineEdges` are already imported at the top of that file):

```ts
const parentManifest: OntologyManifest = {
  node_types: [
    { type: 'creativework', description: 'Parent content type.' },
    { type: 'design_spec', description: 'A design spec.', parent_type: 'creativework' },
    { type: 'software_application', description: 'An app.' },
  ],
  edge_types: [
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'subject matter' },
    { type: 'assigns', source_type: 'software_application', target_type: 'person', description: 'owner' },
  ],
};

describe('ontology parent inheritance', () => {
  it('validateManifest accepts manifests without any parent_type fields', () => {
    expect(() => validateManifest(manifest)).not.toThrow(); // existing top-level `manifest`
  });

  it('validateManifest accepts a valid parent reference', () => {
    expect(() => validateManifest(parentManifest)).not.toThrow();
  });

  it('validateManifest rejects self-parent (case-insensitive)', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'design_spec', description: 'x', parent_type: 'Design_Spec' },
      ],
      edge_types: [],
    })).toThrow(/Self-parent/);
  });

  it('validateManifest rejects a parent slug that does not exist', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'design_spec', description: 'x', parent_type: 'nonexistent' },
      ],
      edge_types: [],
    })).toThrow(/Parent type not found/);
  });

  it('validateManifest rejects parent chains deeper than one level (D1)', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'thing', description: 'root' },
        { type: 'creativework', description: 'mid', parent_type: 'thing' },
        { type: 'design_spec', description: 'leaf', parent_type: 'creativework' },
      ],
      edge_types: [],
    })).toThrow(/Parent chain too deep/);
  });

  it('validateManifest rejects a two-cycle (caught by the chain check, not self-parent)', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'a', description: 'x', parent_type: 'b' },
        { type: 'b', description: 'y', parent_type: 'a' },
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

  it('resolveNodeType stays exact 1:1 — parent_type is never consulted (D2)', () => {
    expect(resolveNodeType('design_spec', parentManifest)).toBe('design_spec');
    expect(resolveNodeType('CreativeWork', parentManifest)).toBe('creativework');
    expect(resolveNodeType('thing', parentManifest)).toBeNull(); // not in manifest at all
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology.test`
Expected: FAIL — TypeScript/Vitest errors: `parent_type` does not exist on `OntologyNodeType`; `Self-parent`/`Parent type not found`/`Parent chain too deep` never thrown; parent-matched edge dropped (`[]` instead of accepted).

- [ ] **Step 3: Write the minimal implementation**

`packages/core/src/types.ts:40-43` — replace the interface with:

```ts
export interface OntologyNodeType {
  type: string;
  description: string;
  /** Optional parent type slug. One level only — the parent must exist in the
   *  same manifest and must not itself declare a `parent_type`. */
  parent_type?: string;
}
```

`packages/core/src/utils/ontology.ts` — add the shared matcher above `validateManifest`:

```ts
/**
 * True when `concreteType` satisfies a declared type: an exact
 * (case-insensitive) match, or a one-hop parent match — the concrete type's
 * `parent_type` equals the declared type. Never recursive (D1). Exact matches
 * short-circuit before the node lookup, so manifests with no `parent_type`
 * behave bit-for-bit as before.
 */
export function typeSatisfies(
  declaredType: string,
  concreteType: string,
  manifest: OntologyManifest,
): boolean {
  const concrete = concreteType.trim().toLowerCase();
  const declared = declaredType.trim().toLowerCase();
  if (!concrete || !declared) return false;
  if (declared === concrete) return true;
  // `node_types` is typed non-optional but arrives from JSON.parse of a DB row
  // at runtime; guard it the way validateManifest already does.
  const def = (manifest.node_types ?? []).find(
    n => n?.type?.trim().toLowerCase() === concrete,
  );
  const parent = def?.parent_type?.trim().toLowerCase();
  return !!parent && parent === declared;
}
```

Inside `validateManifest`, insert after the `nodeSlugs` loop (line 44, before the `edgeKeys` declaration) and before the edge loop — `nodeSlugs` is fully populated there, so forward references resolve:

```ts
  // D1: optional one-level parent inheritance. A parent must be a real,
  // distinct node in the same manifest, and must not itself have a parent.
  // The chain check also rejects 2-cycles, which self-parent alone misses.
  const parentOf = new Map<string, string | undefined>();
  for (const node of manifest.node_types ?? []) {
    parentOf.set(node.type.trim().toLowerCase(), node.parent_type?.trim().toLowerCase());
  }
  for (const node of manifest.node_types ?? []) {
    // D10: absent means "no parent"; present-but-blank is malformed.
    if (node.parent_type === undefined) continue;
    const parentSlug = node.parent_type.trim().toLowerCase();
    if (!parentSlug) {
      throw new Error(`Ontology parent_type must be non-empty when present: ${node.type}`);
    }
    if (parentSlug === node.type.trim().toLowerCase()) {
      throw new Error(`Self-parent: ${node.type}`);
    }
    if (!nodeSlugs.has(parentSlug)) {
      throw new Error(`Parent type not found: ${node.parent_type}`);
    }
    const grandparent = parentOf.get(parentSlug);
    if (grandparent) {
      throw new Error(`Parent chain too deep: ${node.type} → ${node.parent_type} → ${grandparent}`);
    }
  }
```

In `validateInlineEdges`, replace line 132 (`const match = defs.find(...)`):

```ts
    const match = defs.find(d => typeSatisfies(d.source_type, sourceType, manifest));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology.test`
Expected: PASS — all prior tests in the file still green (no-parent manifests validate identically → D5).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/utils/ontology.ts packages/core/__tests__/utils/ontology.test.ts
git commit -m "feat(ontology): optional parent_type with one-level manifest validation"
```

---

### Task 2: `mergeOntologyUpdates` preserves `parent_type` defensively (D6)

**Files:**
- Modify: `packages/core/src/utils/ontology.ts:71-88` (node merge loop)
- Test: `packages/core/__tests__/utils/ontology.test.ts` (same new `describe` block)

**Interfaces:**
- Consumes: `OntologyNodeType.parent_type` (Task 1).
- Produces: `mergeOntologyUpdates(current, updates)` keeps a proposed node's `parent_type` **only if** the slug resolves within the merged node set and that parent has no `parent_type` of its own. Otherwise the field is dropped and the node merges as top-level. Never throws. Nodes without `parent_type` merge exactly as before (no key added).

**Why defensive rather than verbatim:** `mergeManifestUpdates` → `setManifest` → `validateManifest` (`MetadataRepository.ts:176`), and all three `mergeEmergentUpdates` call sites (`IngestionService.ts:597`, `MaintenanceService.ts:563`, `:1145`) run inside `withTransactionAsync` with no try/catch. A hallucinated parent slug passed through verbatim would throw out of `validateManifest` and abort the entire ingest. The existing merge contract is lenient — the edge loop `continue`s on unknown source/target types (`utils/ontology.ts:99`) — and `parent_type` must stay on that contract.

- [ ] **Step 1: Write the failing tests**

Append to the `ontology parent inheritance` describe block:

```ts
  it('mergeOntologyUpdates preserves parent_type when the parent is in the same batch', () => {
    const merged = mergeOntologyUpdates(emptyManifest(), {
      node_types: [
        { type: 'creativework', description: 'Parent.' },
        { type: 'design_spec', description: 'Child.', parent_type: 'creativework' },
      ],
      edge_types: [],
    });
    expect(merged.node_types.find(n => n.type === 'design_spec')?.parent_type).toBe('creativework');
    expect(() => validateManifest(merged)).not.toThrow();
  });

  it('mergeOntologyUpdates preserves parent_type when the parent already exists', () => {
    const merged = mergeOntologyUpdates(
      { node_types: [{ type: 'creativework', description: 'Parent.' }], edge_types: [] },
      {
        node_types: [{ type: 'design_spec', description: 'Child.', parent_type: 'CreativeWork' }],
        edge_types: [],
      },
    );
    expect(merged.node_types.find(n => n.type === 'design_spec')?.parent_type).toBe('CreativeWork');
    expect(() => validateManifest(merged)).not.toThrow();
  });

  it('mergeOntologyUpdates drops an unresolvable parent_type instead of yielding a throwing manifest (D6)', () => {
    const merged = mergeOntologyUpdates(emptyManifest(), {
      node_types: [{ type: 'design_spec', description: 'Child.', parent_type: 'hallucinated' }],
      edge_types: [],
    });
    expect(merged.node_types.find(n => n.type === 'design_spec'))
      .toEqual({ type: 'design_spec', description: 'Child.' });
    expect(() => validateManifest(merged)).not.toThrow();
  });

  it('mergeOntologyUpdates drops a parent_type whose target is itself a child (D1/D6)', () => {
    const merged = mergeOntologyUpdates(
      {
        node_types: [
          { type: 'thing', description: 'root' },
          { type: 'creativework', description: 'mid', parent_type: 'thing' },
        ],
        edge_types: [],
      },
      {
        node_types: [{ type: 'design_spec', description: 'leaf', parent_type: 'creativework' }],
        edge_types: [],
      },
    );
    expect(merged.node_types.find(n => n.type === 'design_spec')?.parent_type).toBeUndefined();
    expect(() => validateManifest(merged)).not.toThrow();
  });

  it('mergeOntologyUpdates drops a self-referential parent_type', () => {
    const merged = mergeOntologyUpdates(emptyManifest(), {
      node_types: [{ type: 'design_spec', description: 'x', parent_type: 'Design_Spec' }],
      edge_types: [],
    });
    expect(merged.node_types[0]).toEqual({ type: 'design_spec', description: 'x' });
  });

  it('mergeOntologyUpdates survives a malformed proposed node with no type field', () => {
    const merged = mergeOntologyUpdates(emptyManifest(), {
      node_types: [
        { description: 'no type at all' } as unknown as OntologyNodeType,
        { type: 'person', description: 'A person.' },
      ],
      edge_types: [],
    });
    expect(merged.node_types).toEqual([{ type: 'person', description: 'A person.' }]);
  });

  it('mergeOntologyUpdates leaves parent_type absent for plain nodes (no key churn)', () => {
    const merged = mergeOntologyUpdates(emptyManifest(), {
      node_types: [{ type: 'person', description: 'A person.' }],
      edge_types: [],
    });
    expect(merged.node_types[0]).toEqual({ type: 'person', description: 'A person.' });
    expect('parent_type' in merged.node_types[0]).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology.test`
Expected: FAIL — the preservation tests get `parent_type === undefined` (line 86 rebuilds `{ type, description }`, stripping the field).

- [ ] **Step 3: Write the minimal implementation**

In `mergeOntologyUpdates`, insert after the `edgeNames` declaration (line 79) and before the node loop:

```ts
  // D6: emergent updates are untrusted. Index parents over current + proposed
  // nodes, first-seen wins (mirrors the dedup in the loop below). A truthy
  // value means that slug is itself a child, so it cannot serve as a parent.
  // Guarded against malformed updates: an LLM may emit a node with no `type`.
  const parentOf = new Map<string, string | undefined>();
  for (const n of [...current.node_types, ...(updates.node_types ?? [])]) {
    const slug = n?.type?.trim().toLowerCase();
    if (!slug || parentOf.has(slug)) continue;
    parentOf.set(slug, n.parent_type?.trim().toLowerCase() || undefined);
  }
```

Then replace line 86:

```ts
    node_types.push({ type, description: String(node.description ?? '') });
```

with:

```ts
    // Drop an unresolvable, self-referential, or two-deep parent rather than
    // letting validateManifest throw inside the caller's transaction (D6).
    const rawParent = node.parent_type?.trim();
    const parentSlug = rawParent?.toLowerCase();
    const keepParent = !!parentSlug
      && parentSlug !== key
      && parentOf.has(parentSlug)
      && !parentOf.get(parentSlug);
    node_types.push({
      type,
      description: String(node.description ?? ''),
      ...(keepParent ? { parent_type: rawParent } : {}),
    });
```

Conditional spread keeps `parent_type` absent rather than `undefined` — matches the no-key-churn assertion and the existing serialization shape.

Note the check is deliberately conservative: if updates propose `b` with a bad parent and `a` with `parent_type: 'b'`, `a`'s parent is dropped too, even though `b` will itself merge as top-level. Fail-safe over exact; the LLM can re-propose. This is stated in spec D6.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology.test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/utils/ontology.ts packages/core/__tests__/utils/ontology.test.ts
git commit -m "fix(ontology): preserve valid parent_type on merge, drop untrusted ones"
```

---

### Task 3: Parent-aware matching at the persistence gates (source + target)

**Files:**
- Modify: `packages/core/src/services/OntologyService.ts:134` (`resolveEdges` source filter)
- Modify: `packages/core/src/services/OntologyService.ts:141` (`resolveEdges` target lookup → two-pass, D3)
- Modify: `packages/core/src/services/OntologyService.ts` `getEffectiveState` (validate seeds, D11)
- Modify: `packages/core/src/services/IngestionService.ts:472-475` (`upsertGraph` edge filter)
- Test: `packages/core/__tests__/services/OntologyService.test.ts` (append to existing `OntologyService` describe)
- Test: `packages/core/__tests__/upsertGraphContract.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `typeSatisfies(declaredType, concreteType, manifest)` from Task 1.
- Produces: `resolveEdges(...)` and `upsertGraph(...)` persist edges whose source type satisfies the declared `source_type` via one-hop parent match, and `resolveEdges` additionally resolves a target through its `parent_type` when no def matches the target exactly (D3). `getEffectiveState` validates a seed manifest on both branches (D11). Signatures unchanged.

Without this task the feature is inert: `validateInlineEdges` admits the edge and both persistence gates silently discard it. In strict mode `upsertGraph` does worse — it **throws** `WikiStrictOntologyViolation` on a parent-satisfied edge.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__tests__/services/OntologyService.test.ts` (reuse the file's existing `makeMocks()` helper):

```ts
describe('OntologyService.resolveEdges — parent inheritance', () => {
  const parentEdgeManifest: OntologyManifest = {
    node_types: [
      { type: 'creativework', description: 'Parent.' },
      { type: 'design_spec', description: 'Child.', parent_type: 'creativework' },
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

  it('resolves a target through its parent_type (D3)', () => {
    const { metadataRepo, edgeRepo } = makeMocks();
    const svc = new OntologyService(metadataRepo, edgeRepo);
    const manifest: OntologyManifest = {
      node_types: parentEdgeManifest.node_types,
      edge_types: [
        { type: 'supersedes', source_type: 'creativework', target_type: 'creativework', description: 'x' },
      ],
    };
    const edges = svc.resolveEdges('e1', 'f1', 'design_spec',
      [{ edge_type: 'supersedes', target_title: 'Old Spec' }], manifest,
      new Map([['old spec', { id: 'd0', okf_type: 'design_spec' }]]), 1000);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ target_id: 'd0', edge_type: 'supersedes' });
  });

  it('prefers an exact target def over a parent-derived one, whatever the order', () => {
    const { metadataRepo, edgeRepo } = makeMocks();
    const svc = new OntologyService(metadataRepo, edgeRepo);
    const rows = [
      { type: 'about', source_type: 'creativework', target_type: 'creativework', description: 'broad' },
      { type: 'about', source_type: 'creativework', target_type: 'design_spec', description: 'narrow' },
    ];
    for (const edge_types of [rows, [...rows].reverse()]) {
      const edges = svc.resolveEdges('e1', 'f1', 'design_spec',
        [{ edge_type: 'about', target_title: 'Other Spec' }],
        { node_types: parentEdgeManifest.node_types, edge_types },
        new Map([['other spec', { id: 'd9', okf_type: 'design_spec' }]]), 1000);
      expect(edges).toHaveLength(1);
      expect(edges[0]!.target_id).toBe('d9');
    }
  });

  it('still skips a target with no okf_type', () => {
    const { metadataRepo, edgeRepo } = makeMocks();
    const svc = new OntologyService(metadataRepo, edgeRepo);
    const edges = svc.resolveEdges('e1', 'f1', 'design_spec',
      [{ edge_type: 'about', target_title: 'Untyped' }], parentEdgeManifest,
      new Map([['untyped', { id: 'u1', okf_type: null }]]), 1000);
    expect(edges).toEqual([]);
  });

  it('child source does not satisfy an edge declared on an unrelated type', () => {
    const { metadataRepo, edgeRepo } = makeMocks();
    const svc = new OntologyService(metadataRepo, edgeRepo);
    const manifest: OntologyManifest = {
      node_types: [
        { type: 'creativework', description: 'Parent.' },
        { type: 'software_application', description: 'App.' },
        { type: 'design_spec', description: 'Child.', parent_type: 'creativework' },
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

  it('persists an edge whose source type satisfies the declared type via parent (strict mode does not throw)', async () => {
    await wiki.setOntologyManifest('entity-1', {
      node_types: [
        { type: 'creativework', description: 'Parent.' },
        { type: 'design_spec', description: 'Child.', parent_type: 'creativework' },
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
Expected: FAIL — `resolveEdges` child test gets `[]`; the `upsertGraph` test throws `WikiStrictOntologyViolation` (strict mode) rather than reaching `edgesWritten: 1`.

- [ ] **Step 3: Write the minimal implementation**

`packages/core/src/services/OntologyService.ts` — add `typeSatisfies` to the import block from `'../utils/ontology'` (lines 16-22). Then replace line 134:

```ts
      const candidates = resolveEdgeDefinitions(edge.edge_type, manifest)
        .filter(d => typeSatisfies(d.source_type, sourceType, manifest));
```

Then the target lookup at line 141 becomes the exact-first two-pass of D3:

```ts
      // Before:
      const def = candidates.find(
        d => d.target_type.toLowerCase() === (target.okf_type ?? '').toLowerCase(),
      );
      // After:
      const targetType = (target.okf_type ?? '').trim().toLowerCase();
      const def = candidates.find(d => d.target_type.trim().toLowerCase() === targetType)
        ?? candidates.find(d => typeSatisfies(d.target_type, targetType, manifest));
```

The exact pass runs first so a narrower def always beats a parent-derived one.
`typeSatisfies` returns false for an empty `concreteType`, so an untyped target
(`okf_type === null`) still matches nothing — unchanged from today.

And in `getEffectiveState`, validate the seed before either branch (D11):

```ts
    const seed = this.ontologyConfig?.seedManifests?.[entityId];
    if (seed) {
      // D11: the tx branch validates via setManifest; the cache branch did not.
      validateManifest(seed.manifest);
      const state = {
```

`packages/core/src/services/IngestionService.ts` — import `typeSatisfies` from `'../utils/ontology'` (add to the existing import from that module if present, otherwise add a new import). Replace lines 472-475:

```ts
      const candidates = (manifest.edge_types ?? []).filter(d =>
        d.type.toLowerCase() === edge.type.toLowerCase()
        && typeSatisfies(d.source_type, sourceType ?? '', manifest),
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- OntologyService.test upsertGraphContract ingest.test`
Expected: PASS — including the pre-existing ingest tests (exact-match behavior is preserved: `typeSatisfies` short-circuits true on exact match before any parent lookup).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/OntologyService.ts packages/core/src/services/IngestionService.ts packages/core/__tests__/services/OntologyService.test.ts packages/core/__tests__/upsertGraphContract.test.ts
git commit -m "feat(ontology): parent-aware source matching when persisting edges"
```

---

### Task 4: Prompt visibility for `parent_type` (D9)

**Files:**
- Modify: `packages/core/src/prompts/ontology.ts:9-15` (`EMERGENT_EXTRA`)
- Test: `packages/core/__tests__/services/PromptService.test.ts` (the file already imports `buildOntologyPromptAppendix`)

**Interfaces:**
- Consumes: nothing new.
- Produces: emergent-mode instructions whose `ontology_updates.node_types` schema line advertises the optional `parent_type` field. The manifest JSON itself already serializes `parent_type` automatically (`OntologyService.buildPromptContext` → `JSON.stringify(manifest, null, 2)`), so strict-mode and backfill prompts need no change. `ONTOLOGY_BACKFILL_SYSTEM_PROMPT` (`src/prompts.ts:25`) classifies existing facts and does not propose types — untouched.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('PromptService', ...)` block (or as a sibling describe at the end of the file):

```ts
describe('ontology prompt — parent_type advertisement', () => {
  it('emergent ontology_updates schema advertises the optional parent_type field', () => {
    const { ontologyModeInstructions } = buildOntologyPromptAppendix(
      'emergent', '{"node_types":[],"edge_types":[]}',
    );
    expect(ontologyModeInstructions).toContain('"parent_type"');
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
Expected: FAIL — `EMERGENT_EXTRA` has no `"parent_type"` yet.

- [ ] **Step 3: Write the minimal implementation**

In `packages/core/src/prompts/ontology.ts`, replace the `node_types` line inside `EMERGENT_EXTRA` (line 12):

```ts
  "node_types": [{ "type": "slug", "description": "...", "parent_type": "optional existing slug" }],
```

leaving the `edge_types` line and the surrounding text untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- PromptService.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/prompts/ontology.ts packages/core/__tests__/services/PromptService.test.ts
git commit -m "feat(ontology): advertise optional parent_type in emergent prompt schema"
```

---

### Task 5: End-to-end integration coverage

**Files:**
- Create: `packages/core/__tests__/ontologyParentInheritance.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, exercised through the public `WikiMemory` API.
- Produces: confidence that (a) a `parent_type`-bearing manifest survives the persist → `validateManifest` → JSON.parse round-trip in `MetadataRepository`, (b) the backfill path types a fact as a child type and persists a parent-declared edge, (c) deep chains are rejected at the public API boundary, (d) a hallucinated emergent parent does not abort an ingest (D6).

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
    { type: 'design_spec', description: 'A design spec.', parent_type: 'creativework' },
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
  it('a parent_type-bearing manifest survives the persist/validate/parse round-trip', async () => {
    const { wiki } = await makeParentWiki('strict');
    const state = await wiki.getOntologyManifest('e1');
    expect(state).not.toBeNull();
    expect(state!.manifest.node_types.find(n => n.type === 'design_spec')?.parent_type)
      .toBe('creativework');
  });

  it('setOntologyManifest rejects a two-level chain at the public API boundary', async () => {
    const db = openTestDatabase();
    const wiki = createWiki(db, { llmProvider: { generateText: async () => '{}' } } as any);
    await wiki.setup();
    await expect(wiki.setOntologyManifest('e1', {
      node_types: [
        { type: 'thing', description: 'root' },
        { type: 'creativework', description: 'mid', parent_type: 'thing' },
        { type: 'design_spec', description: 'leaf', parent_type: 'creativework' },
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

  it('a hallucinated emergent parent_type does not abort the run (D6)', async () => {
    const { db, wiki, generateText } = await makeParentWiki('emergent');
    await seedEntry(db, { id: 'fact_x', title: 'Some Fact', okfType: null });

    generateText.mockResolvedValue(JSON.stringify({
      classifications: [{ id: 'fact_x', okf_type: 'design_spec', edges: [] }],
      ontology_updates: {
        node_types: [{ type: 'runbook', description: 'A runbook.', parent_type: 'no_such_type' }],
        edge_types: [],
      },
    }));

    await expect(wiki.runOntologyBackfill('e1')).resolves.toBeDefined();

    const state = await wiki.getOntologyManifest('e1');
    const runbook = state!.manifest.node_types.find(n => n.type === 'runbook');
    // Merged as a top-level type with the bad parent dropped — not rejected,
    // not throwing out of validateManifest inside the transaction.
    if (runbook) expect(runbook.parent_type).toBeUndefined();
  });
});
```

Notes for the implementer:
- `makeParentWiki` mirrors the established `makeWiki` harness in `packages/core/__tests__/ontologyBackfill.test.ts:173-180` (`createWiki` + `setOntologyManifest`).
- `setOntologyManifest` persists through `MetadataRepository.setManifest`, which calls `validateManifest` (Task 1's new checks); `getManifest` re-validates on every read — the round-trip test proves a persisted `parent_type` passes both.
- The backfill test proves the full chain from Task 3: classification with a child type → `validateAndNormalizeFact` (Task 1's `validateInlineEdges` change) → `resolveAndPersistEdges` → `resolveEdges` (Task 3's `OntologyService` change) → edge row.
- The D6 test is the regression guard for the highest-severity failure mode: if `mergeOntologyUpdates` ever passes `parent_type` through verbatim again, this test fails with a thrown `Parent type not found` instead of resolving. Whether backfill emits `ontology_updates` on this exact shape may vary — if the merge is not reached, assert against `mergeOntologyUpdates` directly (Task 2 covers it at unit level) and keep this test for the no-throw guarantee.

- [ ] **Step 2: Run the new file**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test -- ontologyParentInheritance`
Expected: PASS. If the backfill result shape differs (`result.scanned`), consult `OntologyBackfillResult` in `packages/core/src/types.ts:96` and assert on the DB rows instead — the DB assertions are the source of truth.

- [ ] **Step 3: Run the FULL core suite and typecheck**

Run: `pnpm --filter @equationalapplications/core-llm-wiki test && pnpm --filter @equationalapplications/core-llm-wiki typecheck`
Expected: full suite green, no type errors. (`ingest.test.ts`, `ontologyBackfill.test.ts`, `healBounding.test.ts`, and the `maintenance` tests exercise every changed call path — any red there means an exact-match regression, not flakiness.)

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

- **Unit:** `packages/core/__tests__/utils/ontology.test.ts` — validation matrix (accept/no-parent, accept/valid-parent, reject self, reject missing, reject chain, reject 2-cycle), matcher matrix (parent hit, wrong-parent miss, unknown-edge miss, strict no-throw), `resolveNodeType` exact-match regression (D2), merge matrix (preserve valid × 2, drop unresolvable, drop two-deep, drop self, survive malformed, no key churn).
- **Service:** `packages/core/__tests__/services/OntologyService.test.ts` — `resolveEdges` child/exact/unrelated matrix; `packages/core/__tests__/services/PromptService.test.ts` — prompt advertisement.
- **Contract/Integration:** `packages/core/__tests__/upsertGraphContract.test.ts` — persistence through `upsertGraph` in strict mode; `packages/core/__tests__/ontologyParentInheritance.test.ts` — manifest round-trip, chain rejection at API boundary, backfill end-to-end, D6 no-abort.
- **Full gate:** `pnpm --filter @equationalapplications/core-llm-wiki test && pnpm --filter @equationalapplications/core-llm-wiki typecheck && pnpm --filter @equationalapplications/core-llm-wiki build`. Repo-wide `pnpm test` (includes integration workspace) before PR merge.

## Execution Order

1 → 2 → 3 → 4 → 5. Tasks 1–3 are strictly sequential (each consumes the previous task's exports). Task 4 is independent of Tasks 2–3 and could run in parallel, but at this size keep the branch linear. Each task is one commit; the PR contains all five (atomic feature).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Persistence gates missed → edges validate but never persist | Task 3 covers both persistence sites; the four-gate table above is the exhaustive `source_type.toLowerCase() ===` sweep of `src/` |
| Hallucinated emergent parent aborts an ingest transaction | Task 2's defensive merge (D6) + the Task 5 no-abort test; `validateManifest` never sees an invalid parent from the LLM path |
| Persisted manifests from older versions fail the new `validateManifest` | New checks only fire when `parent_type` is present; pre-parent manifests are byte-identical (D5, covered by "accepts manifests without any parent_type fields") |
| Ambiguous edge names when both an exact and a parent-derived def match | `target_type` disambiguates (unchanged, still exact — D3); covered by the "both candidates" test |
| Recursive inheritance sneaks in later | `Parent chain too deep` makes D1 enforceable at every manifest write AND read |
| Consumers (Clanker pins, Curated Thoughts) | Type-only additive change; no published-version bump required in this PR. `schema-org-llm-wiki` is a separate package — untouched |

## Non-Goals (out of scope)

- Recursive/transitive inheritance resolution (D1)
- `resolveNodeType` parent matching (D2)
- Parent-aware **target**-type matching (D3 — targets are entity titles at validation, exact `okf_type` slugs at resolution)
- SQLite schema/migration changes; `WikiFact`/`WikiEdge`/persisted-type changes (D5)
- Re-parenting an existing type via emergent updates (D6 — that is a `setOntologyManifest` operation)
- An `abstract` flag (D7)
- `traverseGraph` changes; read-query is-a inference; UI changes
- schema-org-llm-wiki changes; Tessera-agent ~18-type manifest authoring (separate work)

## Acceptance Criteria Checklist

- [ ] `validateManifest` accepts warm-agent-style manifests with no `parent_type` fields
- [ ] `validateManifest` accepts valid one-level parents; rejects self-parent, missing parent, 2-level chains, and 2-cycles
- [ ] `validateInlineEdges` accepts child source for parent-declared edge (lenient + strict), rejects wrong-parent and unknown edges
- [ ] `resolveNodeType` behavior unchanged (exact 1:1)
- [ ] `mergeOntologyUpdates` preserves valid `parent_type`, drops unresolvable/two-deep/self ones without throwing, and survives malformed nodes
- [ ] `resolveEdges` and `upsertGraph` persist parent-satisfied edges (integration-proven, strict mode does not throw)
- [ ] `resolveEdges` resolves a parent-declared target, prefers an exact def over a parent-derived one regardless of array order, and still skips untyped targets
- [ ] `validateManifest` rejects a present-but-blank `parent_type`; `mergeOntologyUpdates` drops one without throwing
- [ ] `getEffectiveState` validates a seed manifest on both the `tx` and no-`tx` paths
- [ ] Emergent prompt advertises optional `parent_type`; strict prompt unchanged
- [ ] Backfill end-to-end: fact typed as child + parent-declared edge persisted
- [ ] A hallucinated emergent `parent_type` does not abort the run
- [ ] **FULL core suite green** + typecheck + clean build

## References

- **Spec:** `docs/superpowers/specs/2026-08-28-ontology-parent-field-spec.md` (rev 3)
- **Precedent:** polyManifest fixtures in `packages/core/__tests__/utils/ontology.test.ts:24-38` and `OntologyService.test.ts:25-40` (schema-org-flavored polymorphic edge sets); `makeWiki` harness in `ontologyBackfill.test.ts:173-180`
- **Pipeline map:** `validateInlineEdges:132` (validate) ↔ `OntologyService.resolveEdges:134` + `IngestionService.ts:472` (persist); `MetadataRepository.getManifest:164` re-validates persisted manifests on every read; `mergeEmergentUpdates` call sites at `IngestionService.ts:597`, `MaintenanceService.ts:563`, `:1145` (all inside `withTransactionAsync`, no try/catch)
- **Naming:** `packages/schema-org/src/index.ts` ships an edge type named `parent` (person → person, familial) — the reason the node field is `parent_type` (D8)
