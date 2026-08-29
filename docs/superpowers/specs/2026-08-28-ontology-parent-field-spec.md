# Ontology Single-Level Parent Inheritance — Spec

**Date:** 2026-08-28
**Status:** Draft
**Packages:** `@equationalapplications/core-llm-wiki`
**Depends on:** None

---

## Executive Summary

Add an optional `parent` field to `OntologyNodeType`, enabling one-level type
inheritance. A concrete type (e.g. `design_spec`) declares `parent:
'creativework'`, and edge validation treats it as satisfying edges declared
for the parent type. This supports polymorphic queries ("all CreativeWorks")
without deep hierarchies.

---

## Problem Statement

The warm-agent ontology (`@equationalapplications/schema-org-llm-wiki`) defines
9 flat node types. Tessera's executive agent schema needs ~18 types organized
into 2 levels: parent types for polymorphic querying and concrete types for
specific classification. Today, `OntologyNodeType` has no inheritance — every
type is a peer. Edge validation (`validateInlineEdges`) matches `source_type`
and `target_type` by exact slug only, so an edge declared as `source_type:
'creativework'` rejects `design_spec` even though `design_spec` semantically
*is a* CreativeWork.

---

## Decisions

### D1: One-level parent only (no recursive inheritance)

`parent` is a single optional string referencing another node type slug in
the same manifest. No transitive resolution — if `design_spec` has
`parent: 'creativework'`, the system does NOT follow `creativework`'s parent
(if it had one). This keeps the agent's reasoning flat and predictable.

**Rationale:** Deep inheritance chains (Thing > CreativeWork >
SoftwareSourceCode > WebApplication) force the agent to spend tokens on type
resolution instead of answering queries. Two levels (parent + concrete) give
polymorphic query power without the bloat.

### D2: `resolveNodeType` is NOT parent-aware

`resolveNodeType`'s contract is raw string → canonical slug, 1:1. Passing
`'design_spec'` returns `'design_spec'`. Passing `'creativework'` returns
`'creativework'`. Adding parent matching would break the 1:1 contract and
make return values depend on array order.

**Rationale:** Parent-aware matching belongs exclusively in edge validation,
where we ask a different question: "does this concrete type satisfy this
edge's declared type?"

### D3: Edge validation is parent-aware

`validateInlineEdges` checks whether a concrete `source_type` satisfies an
edge's declared `source_type` by looking up the concrete type's `parent`.
Same for `target_type`. One-hop lookup, not recursive.

### D4: No schema migration

The `parent` field is optional. Existing manifests without it validate
identically. No SQLite column changes, no migration scripts.

### D5: Manifest JSON serialization includes `parent`

The manifest injected into LLM prompts via `buildOntologyPromptAppendix`
includes `parent` in the serialized node_types array. The LLM sees the
hierarchy when classifying facts. No separate prompt template changes.

---

## Changes

### `packages/core/src/types.ts`

Add `parent` to `OntologyNodeType`:

```ts
export interface OntologyNodeType {
  type: string;
  description: string;
  /** Optional parent type slug. One level only — parent must exist in manifest. */
  parent?: string;
}
```

### `packages/core/src/utils/ontology.ts`

**`validateManifest`** — add parent validation after the dedup loops:

```ts
// After the nodeSlugs dedup loop, before the edge validation loop:
for (const node of manifest.node_types ?? []) {
  if (node.parent?.trim()) {
    const p = node.parent.trim().toLowerCase();
    if (p === node.type.trim().toLowerCase()) {
      throw new Error(`Self-parent: ${node.type}`);
    }
    if (!nodeSlugs.has(p)) {
      throw new Error(`Parent type not found: ${node.parent}`);
    }
  }
}
```

**`resolveNodeType`** — **no change.** Stays as exact 1:1 resolution.

**`validateInlineEdges`** — parent-aware source/target matching. Replace the
existing source_type equality check:

```ts
// Before:
const match = defs.find(d => d.source_type.toLowerCase() === sourceType.toLowerCase());

// After:
const match = defs.find(d => {
  if (d.source_type.toLowerCase() === sourceType.toLowerCase()) return true;
  // Parent match: is sourceType a child of d.source_type?
  const srcDef = manifest.node_types.find(
    n => n.type.toLowerCase() === sourceType.toLowerCase(),
  );
  return srcDef?.parent?.trim().toLowerCase() === d.source_type.toLowerCase();
});
```

Note: `manifest` is not currently passed to `validateInlineEdges`. Add it as
a parameter. The only caller is `OntologyService.validateAndNormalizeFact`
which already has `manifest` in scope.

**`mergeOntologyUpdates`** — **no change.** Nodes with `parent` are pushed
as-is. The `parent` field is just another string property.

### `packages/core/src/prompts/ontology.ts`

Update the format example in the backfill prompt to include `parent`:

```ts
const EXAMPLE_JSON = `{
  "node_types": [{ "type": "slug", "description": "...", "parent": "parent_slug" }],
  ...
}`;
```

### `packages/core/src/services/OntologyService.ts`

**`validateAndNormalizeFact`** — pass `manifest` to `validateInlineEdges`:

```ts
// Before:
const edges = validateInlineEdges(canonical, null, fact.edges ?? [], manifest, opts);
// After (same call — just ensure manifest reaches the function):
const edges = validateInlineEdges(canonical, null, fact.edges ?? [], manifest, opts);
```

The function signature change handles the rest.

---

## Tests

### Unit tests for `utils/ontology.ts`

1. **`validateManifest` accepts manifest without parents** — existing warm-agent
   manifest still validates.
2. **`validateManifest` accepts manifest with valid parents** — `design_spec`
   with `parent: 'creativework'` where `creativework` exists passes.
3. **`validateManifest` rejects self-parent** — type with `parent` pointing to
   itself throws `Self-parent`.
4. **`validateManifest` rejects missing parent** — `parent` referencing a
   non-existent slug throws `Parent type not found`.
5. **`validateInlineEdges` parent match** — edge declared as
   `source_type: 'creativework'` accepts `design_spec` as source when
   `design_spec.parent === 'creativework'`.
6. **`validateInlineEdges` no false positive** — edge declared as
   `source_type: 'software_application'` does NOT accept `design_spec` even
   if `design_spec.parent === 'creativework'` (wrong parent).
7. **`resolveNodeType` unchanged** — still returns exact match or null.

---

## What This Does NOT Include

- No recursive/transitive inheritance resolution
- No changes to SQLite schema, WikiFact, WikiEdge, or persisted types
- No changes to `traverseGraph` (it walks edges, not types)
- No `is-a` inference on read queries — only on edge validation
- No UI changes

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Manifest JSON grows slightly with `parent` field | Negligible — one string per type |
| Edge validation is slightly slower (one extra lookup per edge) | One `find()` on ~18 types — negligible |
| Future developer adds recursive parent resolution | `validateManifest` should reject chains > 1 (noted in D1) |
