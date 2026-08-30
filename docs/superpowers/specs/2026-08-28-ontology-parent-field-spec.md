# Ontology Single-Level Parent Inheritance — Spec

**Date:** 2026-08-28
**Status:** Draft (rev 3 — 2026-08-30)
**Packages:** `@equationalapplications/core-llm-wiki`
**Depends on:** None

---

## Executive Summary

Add an optional `parent_type` field to `OntologyNodeType`, enabling one-level
type inheritance. A concrete type (e.g. `design_spec`) declares
`parent_type: 'creativework'`, and edge matching treats it as satisfying edges
declared for the parent type. This supports polymorphic queries ("all
CreativeWorks") without deep hierarchies.

---

## Problem Statement

The warm-agent ontology (`@equationalapplications/schema-org-llm-wiki`) defines
9 flat node types. Tessera's executive agent schema needs ~18 types organized
into 2 levels: parent types for polymorphic querying and concrete types for
specific classification. Today, `OntologyNodeType` has no inheritance — every
type is a peer. Edge matching compares `source_type` by exact slug only, so an
edge declared as `source_type: 'creativework'` rejects `design_spec` even
though `design_spec` semantically *is a* CreativeWork.

---

## Decisions

### D1: One level only (no recursive inheritance)

`parent_type` is a single optional string referencing another node type slug in
the same manifest. No transitive resolution — if `design_spec` has
`parent_type: 'creativework'`, the system does NOT follow `creativework`'s own
parent. `validateManifest` **enforces** this: a manifest where a node's parent
itself has a `parent_type` is rejected. Without that check the depth limit
would be an unenforced convention that edge matching silently violates.

**Rationale:** Deep inheritance chains (Thing > CreativeWork >
SoftwareSourceCode > WebApplication) force the agent to spend tokens on type
resolution instead of answering queries. Two levels (parent + concrete) give
polymorphic query power without the bloat. Rejecting chains also rejects
2-cycles (`a→b→a`), which the self-parent check alone misses.

### D2: `resolveNodeType` is NOT parent-aware

`resolveNodeType`'s contract is raw string → canonical slug, 1:1. Passing
`'design_spec'` returns `'design_spec'`. Passing `'creativework'` returns
`'creativework'`. Adding parent matching would break the 1:1 contract and
make return values depend on array order.

**Rationale:** Parent-aware matching belongs exclusively in edge matching,
where we ask a different question: "does this concrete type satisfy this
edge's declared source type?"

### D3: Edge matching is parent-aware on the SOURCE side only

A concrete `source_type` satisfies an edge definition's declared `source_type`
via a one-hop `parent_type` lookup. **Target matching stays exact everywhere.**

Target types are not checked at all in `validateInlineEdges` (the LLM supplies
an entity title, not a type slug). They *are* checked in
`OntologyService.resolveEdges`, which matches `def.target_type` against the
resolved target fact's `okf_type` — that comparison remains exact. When both an
exact-source def and a parent-derived def share an edge name, exact target
matching is what disambiguates them.

### D4: Parent-aware matching applies to every source-matching gate

There are four places that ask "does this source type satisfy this edge def":
one validation gate and three persistence gates. All four route through a
single shared helper. Making only the validation gate parent-aware would admit
an edge and then silently fail to persist it — the feature would appear to
work and write nothing.

### D5: No schema migration

`parent_type` is optional and manifests persist as a whole JSON blob in
`entity_manifests.manifest_json`. Existing manifests without the field validate
identically. No SQLite column changes, no migration scripts.

### D6: Emergent proposals are untrusted — drop bad parents, never throw

`mergeOntologyUpdates` preserves a proposed `parent_type` **only if** the
referenced slug resolves within the merged node set and that parent does not
itself have a `parent_type`. Otherwise the field is dropped and the node merges
as a top-level type.

**Rationale:** `mergeManifestUpdates` → `setManifest` → `validateManifest`
(`MetadataRepository.ts:176`), and all three `mergeEmergentUpdates` call sites
(`IngestionService.ts:597`, `MaintenanceService.ts:563`, `:1145`) run inside
`withTransactionAsync` with no try/catch. Passing an LLM-proposed
`parent_type` through verbatim would let a hallucinated slug throw out of
`validateManifest` and **abort the entire ingest transaction**. Today
malformed `ontology_updates` are silently skipped — the edge loop `continue`s
on unknown source/target types (`utils/ontology.ts:99`). D6 keeps `parent_type`
on that same lenient contract.

Two consequences, both accepted:

- The check is deliberately conservative. If updates propose `b` with an
  unresolvable parent and `a` with `parent_type: 'b'`, `a`'s parent is dropped
  even though `b` will itself merge as top-level and would have been a legal
  parent. Fail-safe over exact; the LLM can re-propose.
- The merge loop skips slugs that already exist, so emergent updates cannot
  add a `parent_type` to an existing type — same as `description` today.
  Changing an established type's parent is a `setOntologyManifest` operation.

### D7: Parent types are instantiable

A parent type is an ordinary node type. A fact may be classified as bare
`creativework`, and `resolveNodeType('creativework')` resolves normally (D2).
No `abstract` flag is introduced.

**Rationale:** Enforcing abstractness means a new rejection path and a new
manifest field for a constraint the ontology author can express in the type's
description. Manifest authors who want parents to stay abstract should write
descriptions that steer classification toward the concrete children.

### D8: The field is `parent_type`, not `parent`

The warm-agent manifest already ships an **edge** type named `parent`
(`person → person`, familial — `packages/schema-org/src/index.ts`). Because
the whole manifest is serialized into the prompt, `parent` as a node field
would sit in the same JSON as `{"type": "parent", ...}` in `edge_types`,
meaning something unrelated. `parent_type` is unambiguous, and renaming is free
only before the field ships.

### D9: Manifest serialization carries `parent_type` for free

`OntologyService.buildPromptContext` does `JSON.stringify(manifest, null, 2)`,
so `parent_type` reaches the LLM with no prompt-template change. The only
prompt edit needed is advertising the field in the *propose-a-type* schema so
emergent mode can suggest children.

---

## Changes

### `packages/core/src/types.ts`

Add `parent_type` to `OntologyNodeType` (currently at `:40`):

```ts
export interface OntologyNodeType {
  type: string;
  description: string;
  /** Optional parent type slug. One level only — the parent must exist in the
   *  manifest and must not itself declare a `parent_type`. */
  parent_type?: string;
}
```

### `packages/core/src/utils/ontology.ts`

**`validateManifest`** (`:36`) — after the `nodeSlugs` dedup loop, before the
edge loop (`nodeSlugs` is fully populated at that point, so forward references
resolve):

```ts
const parentOf = new Map<string, string | undefined>();
for (const node of manifest.node_types ?? []) {
  parentOf.set(node.type.trim().toLowerCase(), node.parent_type?.trim().toLowerCase());
}
for (const node of manifest.node_types ?? []) {
  const p = node.parent_type?.trim().toLowerCase();
  if (!p) continue;
  if (p === node.type.trim().toLowerCase()) {
    throw new Error(`Self-parent: ${node.type}`);
  }
  if (!nodeSlugs.has(p)) {
    throw new Error(`Parent type not found: ${node.parent_type}`);
  }
  const grandparent = parentOf.get(p);
  if (grandparent) {
    throw new Error(`Parent chain too deep: ${node.type} → ${node.parent_type} → ${grandparent}`);
  }
}
```

**New shared helper** — the single definition of source satisfaction, used by
all four gates (D4):

```ts
export function edgeDefMatchesSourceType(
  def: { source_type: string },
  concreteType: string,
  manifest: OntologyManifest,
): boolean {
  const concrete = concreteType.trim().toLowerCase();
  if (!concrete) return false;
  if (def.source_type.trim().toLowerCase() === concrete) return true;
  const srcDef = manifest.node_types.find(n => n.type.trim().toLowerCase() === concrete);
  const parent = srcDef?.parent_type?.trim().toLowerCase();
  return !!parent && parent === def.source_type.trim().toLowerCase();
}
```

Exact match short-circuits first, so existing exact-match behavior is
bit-for-bit preserved for manifests with no `parent_type`.

**`validateInlineEdges`** (`:112`) — replace the source check at `:132`:

```ts
// Before:
const match = defs.find(d => d.source_type.toLowerCase() === sourceType.toLowerCase());
// After:
const match = defs.find(d => edgeDefMatchesSourceType(d, sourceType, manifest));
```

`manifest` is already a parameter, so no signature change. Only `match.type` is
read, and `validateManifest` enforces one casing per edge name, so which
candidate wins is immaterial here.

**`mergeOntologyUpdates`** (`:71`) — must preserve `parent_type` *defensively*
(D6). The current node loop rebuilds each node as `{ type, description }`
(`:86`), which would silently strip the field. Build the parent index over
current + proposed nodes with first-seen-wins (mirroring the dedup below), then
gate the field:

```ts
// Guarded against malformed updates: an LLM may emit a node with no `type`.
const parentOf = new Map<string, string | undefined>();
for (const n of [...current.node_types, ...(updates.node_types ?? [])]) {
  const slug = n?.type?.trim().toLowerCase();
  if (!slug || parentOf.has(slug)) continue;
  parentOf.set(slug, n.parent_type?.trim().toLowerCase() || undefined);
}

// …inside the existing node loop, replacing the `node_types.push` at :86:
const rawParent = node.parent_type?.trim();
const p = rawParent?.toLowerCase();
const keepParent = !!p && p !== key && parentOf.has(p) && !parentOf.get(p);
node_types.push({
  type,
  description: String(node.description ?? ''),
  ...(keepParent ? { parent_type: rawParent } : {}),
});
```

Conditional spread keeps `parent_type` absent rather than `undefined`, matching
the existing serialization shape.

### `packages/core/src/services/OntologyService.ts`

**`resolveEdges`** — replace the source filter at `:134`:

```ts
.filter(d => edgeDefMatchesSourceType(d, sourceType, manifest));
```

The target check at `:141` (`d.target_type` vs the resolved target's
`okf_type`) stays exact (D3).

**`validateAndNormalizeFact`** — no change. It already passes `manifest`.

### `packages/core/src/services/IngestionService.ts`

**`upsertGraph`** — replace the source clause at `:472-475`:

```ts
const candidates = (manifest.edge_types ?? []).filter(d =>
  d.type.toLowerCase() === edge.type.toLowerCase()
  && edgeDefMatchesSourceType(d, sourceType ?? '', manifest),
);
```

Without this, strict mode **throws** `WikiStrictOntologyViolation` on a
parent-satisfied edge rather than merely dropping it.

### `packages/core/src/prompts/ontology.ts`

Advertise the field in `EMERGENT_EXTRA` (`:9-15`) — the propose-a-type schema.
Update the `node_types` line at `:12`:

```ts
"node_types": [{ "type": "slug", "description": "...", "parent_type": "optional existing slug" }],
```

No change to `ONTOLOGY_BACKFILL_SYSTEM_PROMPT` (`packages/core/src/prompts.ts:25`):
it classifies existing facts and does not propose types, and the manifest it
receives already carries `parent_type` via D9.

---

## Tests

### Unit — `packages/core/__tests__/utils/ontology.test.ts`

1. **`validateManifest` accepts a manifest with no parents** — the warm-agent
   manifest still validates.
2. **`validateManifest` accepts valid one-level parents** — `design_spec`
   with `parent_type: 'creativework'` where `creativework` exists.
3. **Rejects self-parent** — throws `Self-parent`.
4. **Rejects missing parent** — throws `Parent type not found`.
5. **Rejects a two-level chain** (D1) — `a→b→c` throws `Parent chain too deep`.
6. **`edgeDefMatchesSourceType` parent hit** — def `source_type: 'creativework'`
   matches `design_spec`.
7. **`edgeDefMatchesSourceType` wrong-parent miss** — def
   `source_type: 'software_application'` does not match `design_spec`.
8. **`validateInlineEdges` accepts a parent-satisfied edge**; non-strict mode
   still drops (not throws) an unmatched one.
9. **`resolveNodeType` unchanged** (D2) — exact match or null; a parent slug
   does not resolve a child, and vice versa.
10. **`mergeOntologyUpdates` preserves a valid `parent_type`**, including when
    parent and child arrive in the same batch.
11. **`mergeOntologyUpdates` drops an unresolvable `parent_type`** and the
    merged manifest still passes `validateManifest` (D6 — no throw).
12. **`mergeOntologyUpdates` drops a two-deep `parent_type`** where the
    referenced parent already has one.
13. **`mergeOntologyUpdates` survives a malformed node** with no `type` field.
14. **No key churn** — a plain node merges to exactly
    `{ type, description }`, with no `parent_type` key.

### Service — `packages/core/__tests__/services/`

15. **`resolveEdges` persists a parent-satisfied edge**, and drops one whose
    parent does not match.
16. **`resolveEdges` disambiguates by exact `target_type`** when an
    exact-source def and a parent-derived def share an edge name (D3).
17. **Prompt advertises `parent_type`** in emergent mode.

### Contract / integration

18. **`upsertGraph` persists a parent-satisfied edge**, and strict mode does
    not throw on one.
19. **Manifest round-trip** — a `parent_type`-bearing manifest survives
    persist → `validateManifest` on read (`MetadataRepository.ts:164`) → parse.
20. **`setOntologyManifest` rejects a two-level chain** at the public API
    boundary.

---

## What This Does NOT Include

- No recursive/transitive inheritance resolution
- No `abstract` flag (D7)
- No changes to SQLite schema, WikiFact, WikiEdge, or persisted types
- No changes to `traverseGraph` (it walks edges, not types)
- No `is-a` inference on read queries — only on edge source matching
- No parent-aware **target** matching (D3)
- No ability for emergent updates to re-parent an existing type (D6)
- No UI changes

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Manifest JSON grows slightly with `parent_type` | One optional string per type — negligible |
| Extra `find()` over `node_types` per non-exact edge candidate | Exact matches short-circuit before the lookup; `find()` over ~18 types |
| A future developer adds recursive resolution | `Parent chain too deep` makes D1 enforceable at every manifest read *and* write |
| Hallucinated parents in emergent mode abort an ingest | D6: drop the field in merge; `validateManifest` never sees an invalid parent from the LLM path |
| Parent-satisfied edges validate but never persist | D4: one shared helper across all four gates; integration-proven through `upsertGraph` and the backfill path |

---

## Revisions

- **Rev 1 (2026-08-28)** — initial draft.
- **Rev 2 (2026-08-29)** — corrected `validateInlineEdges` assumptions against
  the codebase: `manifest` is already a parameter (no signature change), and
  target types are not checked at that layer.
- **Rev 3 (2026-08-30)** — review against source found the spec understated
  the change. Field renamed `parent` → `parent_type` (D8, collides with the
  shipped `parent` edge type). Added D4 (three persistence gates were missed;
  `mergeOntologyUpdates` strips unknown fields rather than passing them
  through, so "no change" was wrong), D6 (untrusted emergent parents could
  abort an ingest transaction), D7 (parents are instantiable), D9. D1 now
  enforces the depth limit the rev-1 risk table only asserted. Corrected the
  prompt target: `EMERGENT_EXTRA` in `prompts/ontology.ts`, not a
  nonexistent `EXAMPLE_JSON` in the backfill prompt.
