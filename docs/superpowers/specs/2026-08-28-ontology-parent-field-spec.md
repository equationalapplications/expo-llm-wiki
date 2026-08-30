# Ontology Single-Level Parent Inheritance — Spec

**Date:** 2026-08-28
**Status:** Approved
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

### D3: Edge matching is parent-aware on both sides, exact-first

A concrete type satisfies an edge definition's declared type when it equals
that type exactly, or when its one-hop `parent_type` equals it. One primitive
(`typeSatisfies`) answers the question for sources and targets alike.

**Targets resolve exact-first.** `OntologyService.resolveEdges` runs two passes
over the candidate defs: first for a def whose `target_type` equals the target
fact's `okf_type` exactly, then — only if none matched — for one whose
`target_type` is the target's `parent_type`. Exact always beats parent-derived,
so *which pass* wins never depends on array order.

Within a single pass, more than one def can match. The source filter is now
many-to-one: `about design_spec → person` and `about creativework → person` are
two distinct legal triples that a `design_spec` source satisfies at once, and
both match a `person` target exactly, so `find` picks by array order. That is
immaterial rather than lucky — the only field read off the winning def is
`def.type`, and `validateManifest` already rejects a manifest whose triples
spell one edge name with different casing, so every candidate within a pass
yields a byte-identical edge row.

Exact-first preserves precision: a manifest declaring both
`about creativework → creativework` and `about creativework → design_spec`
still routes a `design_spec` target to the narrower row.

Target types are not checked at all in `validateInlineEdges` — the LLM supplies
an entity title there, not a type slug — so this applies only at resolution.

**Accepted cost:** declaring `→ creativework` now admits every child of
`creativework`, and there is no way to say "the parent type only". A type that
needs an exact-only target must not be given children.

### D4: Matching applies at every gate, through one primitive

Four places ask whether a concrete type satisfies a declared one — three on the
source side, one on the target side. All four call `typeSatisfies`. Updating
only some of them would admit an edge at validation and then silently discard
it at persistence, so the feature would appear to work and write nothing.

### D5: No schema migration

`parent_type` is optional and manifests persist as a whole JSON blob in
`entity_manifests.manifest_json`. Existing manifests without the field validate
identically. No SQLite column changes, no migration scripts.

### D6: Emergent proposals are untrusted — drop bad parents, never throw

`mergeOntologyUpdates` preserves a proposed `parent_type` **only if** it is a
non-empty string, it is not the node's own slug, the referenced slug resolves
within the merged node set, and that parent declares no `parent_type` key of
its own. Otherwise the field is dropped and the node merges as a top-level type.

**Every read of untrusted input is type-guarded.** `updates` is `JSON.parse`
output, so `parent_type` can arrive as a number, an object, or `null`. Calling
`.trim()` on a non-string throws a `TypeError` out of the merge and aborts the
caller's transaction — precisely the failure this decision exists to prevent, so
a guard that only handles *wrong slugs* and not *wrong types* leaves the hole
open. A non-string is unusable input: dropped, never thrown on.

**Rationale:** `mergeManifestUpdates` → `setManifest` → `validateManifest`
(`MetadataRepository.ts:176`), and all three `mergeEmergentUpdates` call sites
(`IngestionService.ts:597`, `MaintenanceService.ts:563`, `:1145`) run inside
`withTransactionAsync` with no try/catch. Passing an LLM-proposed
`parent_type` through verbatim would let a hallucinated slug throw out of
`validateManifest` and **abort the entire ingest transaction**. Today
malformed `ontology_updates` are silently skipped — the edge loop `continue`s
on unknown source/target types (`utils/ontology.ts:99`). D6 keeps `parent_type`
on that same lenient contract.

Three consequences, all accepted:

- The parent test is **declared-key presence, not usability**. A node carrying a
  `parent_type` key cannot serve as anyone's parent, whatever that value is — a
  real parent, a hallucinated slug, blank, or a non-string. Testing usability
  instead would split one input class across opposite outcomes: `b` with
  `parent_type: 'hallucinated'` would reject a child (the value is truthy),
  while `b` with `parent_type: 123` would accept one (the value normalizes
  away), even though both are malformed proposals that merge as top-level.
  Presence keeps a single rule.
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

### D10: A present-but-unusable `parent_type` is an error

`parent_type: ''` (or whitespace) is malformed authorship, not "no parent".
Treating it as absent would silently disable inheritance on a type the author
meant to nest. `validateManifest` throws; absence (`undefined`) stays valid and
means exactly what it says.

The same throw covers a **non-string** `parent_type`. The field is typed
`string | undefined`, but `validateManifest` runs on `JSON.parse` output from
`entity_manifests.manifest_json` on every read (`MetadataRepository.ts:164`), so
a legacy or hand-edited row can hold a number, an object, or `null`. Unguarded,
`.trim()` on those raises a bare `TypeError` instead of the manifest error the
caller can act on — hence
`Ontology parent_type must be a non-empty string when present`.

This matches how core already treats blank slugs elsewhere — `validateManifest`
throws `Ontology node type slug must be non-empty` and the equivalent for edge
types.

The untrusted merge path (D6) stays lenient: a blank `parent_type` from the LLM
is dropped like any other unusable value, never thrown.

### D11: Seed manifests are validated before use

`OntologyService.getEffectiveState` validates a seed manifest only on the
branch that persists it — with a `tx` it calls `metadataRepo.setManifest`,
which validates; without one it does a bare `this.cache.set(entityId, state)`
and the seed is never checked.

That gap predates this work but `parent_type` makes it dangerous: a seed with a
dangling parent reference would drive classification and edge matching, and
`typeSatisfies` would follow a pointer to a type that does not exist. Seeds are
host-supplied config, so failing fast is right — unlike D6's LLM input, there is
no one to be lenient toward.

`validateManifest(seed.manifest)` runs before either branch. Pre-`parent_type`
seeds that validate today still validate.

Two scope notes:

- The check is **lazy, not eager**: it fires on the first `getEffectiveState`
  that falls through to the seed, not at `WikiMemory` construction. Validating
  every configured seed up front would move the throw to `setup()` and is a
  larger behavior change than this work needs.
- `WikiMemory.getOntologyManifest` (`WikiMemory.ts:657-671`) has its own seed
  fallback and stays **unvalidated**. It is a read-only accessor that feeds no
  classification or edge matching, so a dangling parent cannot do damage
  through it, and making a getter throw would surprise hosts inspecting their
  own config. Accepted asymmetry: a bad seed is visible via
  `getOntologyManifest` and fatal via `getEffectiveState`.

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
  const parent = typeof node.parent_type === 'string'
    ? node.parent_type.trim().toLowerCase()
    : undefined;
  parentOf.set(node.type.trim().toLowerCase(), parent);
}
for (const node of manifest.node_types ?? []) {
  // D10: absent means "no parent"; present-but-blank is malformed.
  if (node.parent_type === undefined) continue;
  // Typed `string | undefined`, but this runs on JSON.parse output from
  // `entity_manifests.manifest_json` on every read — a legacy or hand-edited
  // row can carry a number or `null`, and `.trim()` on those throws a bare
  // TypeError instead of this manifest error.
  if (typeof node.parent_type !== 'string' || !node.parent_type.trim()) {
    throw new Error(`Ontology parent_type must be a non-empty string when present: ${node.type}`);
  }
  const p = node.parent_type.trim().toLowerCase();
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

**New shared primitive** — the single definition of "does this concrete type
satisfy that declared type", used by all four gates (D4):

```ts
export function typeSatisfies(
  declaredType: string,
  concreteType: string,
  manifest: OntologyManifest,
): boolean {
  const concrete = concreteType.trim().toLowerCase();
  const declared = declaredType.trim().toLowerCase();
  if (!concrete || !declared) return false;
  if (declared === concrete) return true;
  // `node_types` is typed non-optional but arrives from JSON.parse of a DB
  // row at runtime, so guard it the way validateManifest already does — and
  // for the same reason, `typeof`-check the fields rather than calling .trim()
  // on them. This runs inside the caller's transaction, so a TypeError here
  // aborts an ingest exactly like one in the merge path. Manifests reaching
  // this point have already passed validateManifest (getManifest:164, and
  // seeds via D11), so this is defense in depth, not the primary guard.
  const def = (manifest.node_types ?? []).find(
    n => typeof n?.type === 'string' && n.type.trim().toLowerCase() === concrete,
  );
  const parent = typeof def?.parent_type === 'string'
    ? def.parent_type.trim().toLowerCase()
    : '';
  return parent !== '' && parent === declared;
}
```

Exact match short-circuits before the node lookup, so manifests with no
`parent_type` behave bit-for-bit as before.

**`buildDeclaresParentIndex`** — extracted helper used by `mergeOntologyUpdates`
and exported for the test suite (test 14f). The helper builds the same
parent-presence map that the merge function needs, but does not run the
existing node loop — so a test can exercise the index's untrusted-input
contract without tripping the pre-existing `node?.type?.trim()` (line 82),
which Rev 6 deliberately left alone:

```ts
export function buildDeclaresParentIndex(
  nodes: ReadonlyArray<OntologyNodeType>,
): Map<string, boolean> {
  // First-seen wins, same as the dedup in mergeOntologyUpdates. Value:
  // declared-key presence, not usability — see D6.
  const declaresParent = new Map<string, boolean>();
  for (const n of nodes) {
    const slug = typeof n?.type === 'string' ? n.type.trim().toLowerCase() : '';
    if (!slug || declaresParent.has(slug)) continue;
    declaresParent.set(slug, n?.parent_type !== undefined);
  }
  return declaresParent;
}
```

Following the same export rule as `typeSatisfies` (line 419): exported from
`utils/ontology.ts` for internal use and the test suite, **not** re-exported
from `src/index.ts`. No host needs the index to author or validate a manifest.

**`validateInlineEdges`** (`:112`) — replace the source check at `:132`:

```ts
// Before:
const match = defs.find(d => d.source_type.toLowerCase() === sourceType.toLowerCase());
// After:
const match = defs.find(d => typeSatisfies(d.source_type, sourceType, manifest));
```

`manifest` is already a parameter, so no signature change. Only `match.type` is
read, and `validateManifest` enforces one casing per edge name, so which
candidate wins is immaterial here.

**`mergeOntologyUpdates`** (`:71`) — must preserve `parent_type` *defensively*
(D6). The current node loop rebuilds each node as `{ type, description }`
(`:86`), which would silently strip the field. Build the parent index via the
helper above with first-seen-wins (mirroring the dedup below), then gate the
field:

```ts
// `updates` is JSON.parse output: every field is `unknown` at runtime whatever
// the TS types say. Each read below is type-guarded — `.trim()` on a number or
// an object throws a TypeError straight out of the caller's transaction.
const declaresParent = buildDeclaresParentIndex([
  ...current.node_types,
  ...(updates.node_types ?? []),
]);

// …inside the existing node loop, replacing the `node_types.push` at :86:
const rawParent = typeof node?.parent_type === 'string' ? node.parent_type.trim() : '';
const parentSlug = rawParent.toLowerCase();
const keepParent = parentSlug !== ''
  && parentSlug !== key
  && declaresParent.get(parentSlug) === false;
node_types.push({
  type,
  description: String(node.description ?? ''),
  ...(keepParent ? { parent_type: rawParent } : {}),
});
```

`declaresParent.get(...) === false` is the whole gate, written explicitly:
`undefined` means the slug is unknown (dangling parent), `true` means that node
declared a `parent_type` of its own and so cannot be a parent, `false` means a
known top-level type. `rawParent` keeps the proposer's original casing, which
the manifest stores verbatim.

The node loop below still reads `node?.type?.trim()` (`:83`) and carries the
same latent `TypeError` on a non-string `type`. That line ships today and is
unchanged by this work, so it is **not** fixed here — but the new index loop
above must not add a second copy of the bug, hence the guard on `n?.type`.

Conditional spread keeps `parent_type` absent rather than `undefined`, matching
the existing serialization shape.

### `packages/core/src/services/OntologyService.ts`

**`resolveEdges`** — the source filter at `:134`:

```ts
.filter(d => typeSatisfies(d.source_type, sourceType, manifest));
```

and the target lookup at `:141`, which becomes the two-pass exact-first
resolution of D3:

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

The exact pass runs first so a narrower def always wins over a parent-derived
one. `typeSatisfies` returns false for an empty `concreteType`, so an untyped
target (`okf_type === null`) still matches nothing and the edge is skipped —
unchanged from today.

**`getEffectiveState`** — validate the seed before either branch (D11):

```ts
const seed = this.ontologyConfig?.seedManifests?.[entityId];
if (seed) {
  // The `tx` branch validates via setManifest; the cache branch did not.
  validateManifest(seed.manifest);
  const state = { … };
```

**Imports** — the `'../utils/ontology'` block (`:16-22`) currently pulls
`emptyManifest`, `normalizeTitleKey`, `resolveNodeType`,
`resolveEdgeDefinitions`, `validateInlineEdges`. This work adds **two** names:
`typeSatisfies` (for `resolveEdges`) and `validateManifest` (for
`getEffectiveState`).

**`validateAndNormalizeFact`** — no change. It already passes `manifest`.

**Export scope** — `typeSatisfies` is exported from `utils/ontology.ts` for the
other modules in `packages/core`, but is **not** added to `src/index.ts`, which
today re-exports only `validateManifest` from that module (`index.ts:14`). No
host needs the primitive to author or validate a manifest; publishing it would
freeze an internal matching rule into the package's public surface. Adding it
later is additive and cheap; removing it would not be.

### `packages/core/src/services/IngestionService.ts`

**`upsertGraph`** — replace the source clause at `:472-475`:

```ts
const candidates = (manifest.edge_types ?? []).filter(d =>
  d.type.toLowerCase() === edge.type.toLowerCase()
  && typeSatisfies(d.source_type, sourceType ?? '', manifest),
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
6. **`typeSatisfies` parent hit** — declared `creativework` is satisfied by
   `design_spec`.
7. **`typeSatisfies` wrong-parent miss** — declared `software_application` is
   not satisfied by `design_spec`.
7b. **`typeSatisfies` blank/guard cases** — empty `concreteType`, empty
    `declaredType`, and a manifest whose `node_types` is `undefined` all return
    `false` rather than throwing.
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

14b. **`validateManifest` rejects a present-but-blank `parent_type`** (D10) —
     `''` and `'   '` both throw `must be a non-empty string`; an absent field
     does not.
14c. **`mergeOntologyUpdates` drops a blank `parent_type`** without throwing —
     the untrusted path stays lenient (D6/D10).
14d. **`validateManifest` rejects a non-string `parent_type`** with the same
     manifest error, not a `TypeError` — `0`, `123`, `true`, `{}`, and `null`
     each throw `must be a non-empty string` (D10). `0` and `false` matter
     independently of `123`: a falsy non-string must not slip through a
     truthiness check.
14e. **`mergeOntologyUpdates` drops a non-string `parent_type`** without
     throwing (D6) — `123`, `null`, `{}`, and `[]` each merge the node as
     top-level, and the result passes `validateManifest`. This is the
     transaction-abort regression guard: unguarded, `.trim()` on any of them
     raises a `TypeError` out of `withTransactionAsync`.
14f. **`buildDeclaresParentIndex` skips a non-string `type`** — calling the
     helper with `[ { type: 42, description: 'bogus' }, { type: 'person', ... } ]`
     returns a map that contains `'person' → false` and omits the bogus slug
     entirely (no `TypeError` from `.trim()`). Asserts the new index helper's
     untrusted-input contract directly. The existing `mergeOntologyUpdates`
     node loop's behavior on a non-string `type` is unchanged and out of scope.
14g. **A node that declared an unusable `parent_type` cannot serve as a
     parent** (D6 presence rule) — updates proposing `b` with
     `parent_type: 123` and `a` with `parent_type: 'b'` merge `b` as top-level
     and drop `a`'s parent, matching the treatment of `b` with a hallucinated
     string parent.

### Service — `packages/core/__tests__/services/`

15. **`resolveEdges` persists a parent-satisfied edge**, and drops one whose
    parent does not match.
16. **`resolveEdges` resolves a parent-declared target** (D3) — a
    `design_spec → design_spec` edge matches a def declared
    `creativework → creativework`.
16b. **`resolveEdges` prefers an exact target def over a parent-derived one** —
     with both `about creativework → creativework` and
     `about creativework → design_spec` declared, a `design_spec` target
     resolves to the narrower row regardless of array order.
16c. **`resolveEdges` still skips an untyped target** — `okf_type === null`
     matches no def on either pass.
16d. **Seed manifests are validated (D11)** — a `seedManifests` entry whose
     `parent_type` dangles throws on first `getEffectiveState`, on both the
     `tx` and no-`tx` paths.
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
- No `is-a` inference on read queries — only on edge matching
- No ability for emergent updates to re-parent an existing type (D6)
- No `typeSatisfies` on the package's public surface (`src/index.ts`)
- No eager validation of every configured seed at construction (D11)
- No UI changes

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Manifest JSON grows slightly with `parent_type` | One optional string per type — negligible |
| Extra `find()` over `node_types` per non-exact edge candidate | Exact matches short-circuit before the lookup; `find()` over ~18 types |
| A future developer adds recursive resolution | `Parent chain too deep` makes D1 enforceable at every manifest read *and* write |
| Hallucinated parents in emergent mode abort an ingest | D6: drop the field in merge; `validateManifest` never sees an invalid parent from the LLM path |
| A non-string `parent_type` aborts an ingest via `TypeError` | D6: every read of `updates` is `typeof`-guarded before `.trim()`, so a number/object/`null` is dropped like any other unusable value (tests 14e-14g). D10 gives the persisted path the same guard, throwing a manifest error rather than a `TypeError` (test 14d) |
| Parent-satisfied edges validate but never persist | D4: one primitive across all four gates; integration-proven through `upsertGraph` and the backfill path |
| Both an exact and a parent-derived def match one target | Exact-first two-pass resolution (D3): the narrower pass runs first, so order never decides which pass wins. Ties *within* a pass are possible (the source filter is many-to-one) but immaterial — only `def.type` is read, and `validateManifest` enforces one casing per edge name |
| A dangling seed is fatal via `getEffectiveState` but visible via `getOntologyManifest` | Accepted and documented in D11 — the getter drives no matching |
| A `→ parent` def silently admits every child | Accepted and documented in D3; a type needing an exact-only target must not be given children |
| A malformed seed manifest drives classification unvalidated | D11: `validateManifest(seed.manifest)` before either branch of `getEffectiveState` |

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
- **Rev 4 (2026-08-30)** — PR #110 review. **D3 reversed**: target matching is
  now parent-aware too, resolved exact-first via a two-pass lookup in
  `resolveEdges`, so a `creativework → creativework` def serves a
  `design_spec → design_spec` edge. Rev 3's source-only rule forced consumers
  to enumerate one row per concrete type for every edge targeting a parent —
  an unbounded burden, and an asymmetry that surprised every reviewer. The
  source-only helper is replaced by one primitive,
  `typeSatisfies(declaredType, concreteType, manifest)`, used by all four
  gates; it now guards `manifest.node_types`, which is typed non-optional but
  `JSON.parse`d from a DB row at runtime and already guarded that way in
  `validateManifest` and `IngestionService`. Added **D10**: a present-but-blank
  `parent_type` throws rather than silently meaning "no parent", matching
  core's existing treatment of blank slugs. Added **D11**:
  `getEffectiveState` validated seed manifests only on the branch that
  persists them — the no-`tx` branch cached them unchecked, so a seed with a
  dangling parent would drive classification with `typeSatisfies` following a
  pointer to nothing.
- **Rev 5 (2026-08-30)** — accuracy pass, no design change. **D3's
  order-independence argument was wrong**: it claimed triple uniqueness left at
  most one def matching per pass, but the parent-aware source filter is
  many-to-one, so two legal triples (`about design_spec → person` and
  `about creativework → person`) can both match one target in the same pass.
  The outcome is still order-independent, for a different reason now stated —
  only `def.type` is read and casing is already enforced manifest-wide. The
  **Changes** section gained the `getEffectiveState` edit D11 decided but never
  specified, the second import D11 requires (`validateManifest`, not just
  `typeSatisfies`), and an explicit export-scope decision keeping
  `typeSatisfies` off `src/index.ts`. D11 now states its two real boundaries:
  validation is lazy at first `getEffectiveState`, not eager at construction
  (rev 4 said "failing fast at construction"), and
  `WikiMemory.getOntologyManifest`'s own seed fallback stays unvalidated.
- **Rev 6 (2026-08-30)** — PR #110 review (CodeRabbit). **Type-safety hole in
  the D6 recipe**: it called `.trim()` on `parent_type` straight off
  `JSON.parse` output, so a proposal carrying a number, an object, or `null`
  raised a `TypeError` out of `mergeOntologyUpdates` and aborted the ingest
  transaction — the exact failure D6 was written to prevent, reachable through
  a type rather than a bad slug. Every untrusted read is now `typeof`-guarded.
  D6's parent gate also changes from *usability* to **declared-key presence**,
  so a node proposing `parent_type: 123` and one proposing
  `parent_type: 'hallucinated'` are treated alike; previously the first could
  still serve as another node's parent and the second could not. The same guard
  is applied to D10's `validateManifest` snippet, which had the identical
  defect on the persisted path (`manifest_json` is `JSON.parse`d on every
  read), so a legacy row yields a manifest error instead of a `TypeError`; its
  message becomes `must be a non-empty string when present`. Tests 14d-14g
  added. The pre-existing unguarded `node?.type?.trim()` in the shipped merge
  loop (`utils/ontology.ts:83`) is noted but deliberately left alone.
- **Rev 7 (2026-08-30)** — PR #110 review (CodeRabbit). Test 14f's title
  claimed `mergeOntologyUpdates` survives a non-string `type`, but the shipped
  node loop still calls `node?.type?.trim()` and throws on a non-string `type`
  (the line Rev 6 deliberately left alone). Scoped 14f to the new index
  loop's contribution — the parent-satisfies index omits a `type: 42` slug
  rather than throwing, and well-formed peers still register — so the test
  asserts the guarded loop's behavior directly instead of making a false
  claim about the full merge.
- **Rev 8 (2026-08-30)** — plan alignment for rev 7. Test 14f scoped to
  "asserts the index loop's contribution directly, not via a full
  `mergeOntologyUpdates` call," but the index loop was inlined inside the
  merge function — no surface to call. Extracted it as `buildDeclaresParentIndex`,
  exported from `utils/ontology.ts` (same internal-only rule as `typeSatisfies`),
  and rewrote 14f to call the helper directly. `mergeOntologyUpdates` now
  delegates to the helper; observable behavior is unchanged. The plan
  (`2026-08-29-ontology-parent-field-implementation-plan.md`) was rewritten
  against rev 8 in lockstep — test 14f, the implementation step, the
  expected-failure step, and the test matrix.
