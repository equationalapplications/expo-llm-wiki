# Polymorphic Edge Triples + `@equationalapplications/schema-org-llm-wiki` — Spec

**Date:** 2026-07-14
**Status:** Design Complete (Pending Implementation)
**Packages:** `@equationalapplications/core-llm-wiki` (validation change), `@equationalapplications/schema-org-llm-wiki` (new)

---

## Executive Summary

Two coupled deliverables:

1. **Core library change:** ontology edge definitions become unique by the
   `(type, source_type, target_type)` triple instead of by `type` alone, so one
   schema.org property name (`about`, `itemReviewed`, `location`, `organizer`)
   can appear as multiple manifest rows with different source/target types —
   mirroring schema.org's own polymorphic domain/range model.
2. **New data-only package** `@equationalapplications/schema-org-llm-wiki`
   shipping a curated, fully schema.org-standard warm-agent ontology manifest
   (9 node types, 28 edges) that any consumer can drop into `OntologyConfig`.

The `OntologyEdgeType` wire format is unchanged. Every manifest that validates
today still validates. The change is strictly permissive.

---

## Problem Statement

`validateManifest` in `packages/core/src/utils/ontology.ts` dedupes edges by
lowercased `type` alone and throws `Duplicate edge type` on the second
occurrence of a name. Schema.org properties are polymorphic — `about` legally
targets Person, Organization, Place, and Event. A curated schema.org manifest
(Clanker spec `2026-07-14-curated-schema-ontology-design.md`) needs 28 edges
but only 19 unique property names; it is rejected at load today.

Flattening names (`aboutPerson`, `aboutPlace`, …) would leak non-standard
vocabulary into prompts, stored edges, and future JSON-LD export. The right
fix is in the library, and it benefits every consumer of the packages.

---

## Part 1 — Core: Triple-Keyed Edge Definitions

### `packages/core/src/utils/ontology.ts`

**`validateManifest`**
- Edge uniqueness key: `` `${type}|${source_type}|${target_type}` ``
  (each part trimmed + lowercased).
- Error message for a true duplicate:
  `Duplicate edge definition: ${type} (${source_type} → ${target_type})`.
- Node-type validation unchanged. Unknown source/target node check unchanged.

**`mergeOntologyUpdates`** (emergent mode)
- Skip-existing check uses the same triple key. An emergent update may now add
  a new source/target variant of an existing property name.

**`resolveEdgeDefinition` → `resolveEdgeDefinitions`**
- Returns **all** case-insensitive name matches (`OntologyEdgeType[]`) instead
  of the first. Internal utility — not exported from the package index, so no
  public API break.

**`validateInlineEdges`**
- An extracted edge is kept if **any** definition matches its name and the
  fact's source type (target type is unknown at extraction time —
  `target_title` is not yet resolved to a typed fact).
- The emitted `edge_type` uses the canonical casing of a matching definition.
  When multiple rows share the name, casing is identical by construction
  (same property name), so which match supplies casing is immaterial.

### `packages/core/src/services/OntologyService.ts`

**`resolveAndPersistEdges`**
- Current code resolves one definition by name, then rejects when the actual
  target's `okf_type` differs from `def.target_type` (line 129). New behavior:
  among definitions matching name + source type, **select** the one whose
  `target_type` equals the resolved target's `okf_type` (case-insensitive).
- No matching row → edge skipped (same outcome as today).
- Untyped target (`okf_type` null) → skipped, unchanged.
- Persisted `WikiEdge.edge_type` stores the property name only, as today —
  source/target types live on the nodes themselves.

### `packages/core/src/prompts/ontology.ts`

Append one line to `FACT_ONTOLOGY_FIELDS`:

> An edge_type may appear in the manifest multiple times with different
> source_type/target_type; use the row whose types match your fact and target.

Manifest JSON injection is otherwise unchanged.

### Backward compatibility

- `OntologyEdgeType` shape unchanged; stored manifests untouched; no
  migration.
- Any manifest valid before this change remains valid (name-unique implies
  triple-unique).
- Backfill (`runOntologyBackfill`) reuses these same code paths; no backfill
  changes.
- Ships as a `feat:` commit — semantic-release derives the version bump and
  changelog (no manual version edits anywhere in this work).

---

## Part 2 — New Package: `@equationalapplications/schema-org-llm-wiki`

### Layout

```
packages/schema-org/
  package.json          # name @equationalapplications/schema-org-llm-wiki
  tsconfig.json         # same pattern as sibling packages
  src/index.ts          # manifest constant + re-exported types
  __tests__/manifest.test.ts
  README.md
```

- **Data-only** — no runtime logic.
- `dependencies`: `@equationalapplications/core-llm-wiki: workspace:*`
  (types only; matches sibling-package convention, e.g. `packages/react`).
- Build: same tsup setup as siblings; picked up by root `pnpm -r build` and
  the existing release workflow with no workflow changes.
- Versioning/changelog: semantic-release lockstep — nothing manual.

### Exports

```ts
import type { OntologyManifest } from '@equationalapplications/core-llm-wiki';

/** Curated schema.org warm-agent ontology: 9 node types, 28 edges. */
export const schemaOrgWarmAgentManifest: OntologyManifest = { ... };
```

Consumer adoption:

```ts
import { schemaOrgWarmAgentManifest } from '@equationalapplications/schema-org-llm-wiki';

const wiki = createWiki(db, {
  ontology: {
    mode: 'strict',
    seedManifests: { [entityId]: { mode: 'strict', manifest: schemaOrgWarmAgentManifest } },
  },
});
```

(Exact `OntologyConfig` wiring per core's interface; snippet in README.)

### Manifest content — 9 node types

`person`, `organization`, `place`, `event`, `project`, `action`,
`creativework`, `review`, `product`.

Changes vs. the Clanker draft spec (all in service of full schema.org
standardness — zero deviations, exact JSON-LD mapping):

| Draft | Final | Why |
|-------|-------|-----|
| `rating` node | `review` node | `itemReviewed` domain is Review/AggregateRating, not Rating (schema.org) |
| `participant` edge | `attendee` edge | `participant` domain is Action; Event's standard property is `attendee` |
| `subProject` edge | `subOrganization` edge | `subProject` is not a schema.org property; Project ⊂ Organization, so `subOrganization` is the standard hierarchy property |
| `object` (loose description) | `object` (tightened description) | Kept — standard Action property with range Thing; description reads "Project this task belongs to; the object the action advances" to steer the LLM |
| `parent` (ambiguous direction) | `parent` (direction stated) | Description states: source = child, target = parent ("a parent of this person") |

Node descriptions follow the Clanker draft spec, with `review` description
adapted from `rating` (implicit subject remains the owning character;
`reviewRating` value stays inside fact content per the literal-property rule).

### Manifest content — 28 edges

| # | type | source | target |
|---|------|--------|--------|
| 1 | `knows` | person | person |
| 2 | `spouse` | person | person |
| 3 | `parent` | person | person |
| 4 | `worksFor` | person | organization |
| 5 | `memberOf` | person | organization |
| 6 | `homeLocation` | person | place |
| 7 | `workLocation` | person | place |
| 8 | `location` | event | place |
| 9 | `location` | organization | place |
| 10 | `containedInPlace` | place | place |
| 11 | `subOrganization` | project | project |
| 12 | `object` | action | project |
| 13 | `agent` | action | person |
| 14 | `attendee` | event | person |
| 15 | `organizer` | event | person |
| 16 | `organizer` | event | organization |
| 17 | `author` | creativework | person |
| 18 | `publisher` | creativework | organization |
| 19 | `about` | creativework | person |
| 20 | `about` | creativework | organization |
| 21 | `about` | creativework | place |
| 22 | `about` | creativework | event |
| 23 | `itemReviewed` | review | creativework |
| 24 | `itemReviewed` | review | organization |
| 25 | `itemReviewed` | review | place |
| 26 | `itemReviewed` | review | event |
| 27 | `itemReviewed` | review | product |
| 28 | `owns` | person | product |

19 unique property names; polymorphic rows: `location` ×2, `organizer` ×2,
`about` ×4, `itemReviewed` ×5. Edge descriptions follow the Clanker draft
spec, adjusted for the renames above.

Casing: property names keep schema.org camelCase (`worksFor`,
`itemReviewed`). Validation compares lowercase but stores the given casing,
so camelCase survives to storage and future JSON-LD export.

### README contents

- What the package is; why curated (prompt size, classification accuracy).
- Adoption snippet (above).
- Schema.org alignment table (types + properties, all standard).
- JSON-LD export notes (camelCase preserved; literal properties like
  `birthDate`/`startTime` live in fact content, not edges).
- Requires a core version with triple-keyed edge validation (same release).

---

## Data Flow (unchanged paths, new behavior)

Librarian/ingest prompt carries manifest JSON (now with polymorphic rows) →
LLM emits `okf_type` + `edges` → `validateAndNormalizeFact` (name + source
check) → `resolveAndPersistEdges` (target-type selection among rows) →
`wiki_edges`. Backfill uses the same path.

## Error Handling

- True duplicate triple in a manifest → throw at `setOntologyManifest`/seed
  load (same failure point as today, narrower condition).
- LLM emits an edge whose name matches but no row fits source/target →
  silently dropped; the existing prompt fallback rule already instructs the
  model to omit rather than invent.

---

## Testing

### Unit — `packages/core/__tests__` (utils)
- `validateManifest` accepts a manifest with `about` ×4 (distinct triples).
- `validateManifest` rejects an exact duplicate triple with the new message.
- `mergeOntologyUpdates` adds a new source/target variant of an existing
  name; skips an exact-triple duplicate.
- `resolveEdgeDefinitions` returns all name matches, case-insensitive.
- `validateInlineEdges` keeps an edge when any row matches name + source;
  drops it when only the name matches (wrong source).

### Unit — `OntologyService`
- `resolveAndPersistEdges` picks the correct row among 4 `about` rows based
  on target `okf_type`; persists one edge.
- Skips when target's `okf_type` matches no row; skips untyped target.

### Package — `packages/schema-org/__tests__`
- Manifest passes `validateManifest`.
- Exactly 9 node types, 28 edges; every edge's source/target exists in the
  node list.
- Snapshot test to catch accidental content drift.

### Integration — `packages/integration`
- Seed the full manifest; librarian round-trip classifies facts into
  polymorphic edges (e.g. one `about` → place, one `itemReviewed` → product).

---

## Out of Scope

- Type hierarchy/inheritance, emergent-mode guardrails, multi-property edge
  aliases, literal-valued properties — unchanged from the Clanker draft spec.
- **Clanker adoption** (follow-up in Clanker repo): bump to the release
  carrying this work, import the package manifest instead of an inline
  constant, and revise Clanker's
  `2026-07-14-curated-schema-ontology-design.md` (rating→review,
  participant→attendee, subProject→subOrganization, duplicate-name section,
  and the `OntologyConfig` reference — the interface lives in core-llm-wiki,
  not Clanker's `src/database/schema.ts`).

---

## References

- Clanker draft spec: `clanker/docs/superpowers/specs/2026-07-14-curated-schema-ontology-design.md`
- Prior spec: `2026-07-13-ontology-backfill-spec.md`
- Validation code: `packages/core/src/utils/ontology.ts`,
  `packages/core/src/services/OntologyService.ts`
- Schema.org: https://schema.org/
