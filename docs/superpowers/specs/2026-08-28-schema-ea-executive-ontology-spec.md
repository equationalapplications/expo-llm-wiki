# @equationalapplications/schema-ea — Spec

**Date:** 2026-08-28
**Status:** Draft (rev 2 — 2026-08-30)
**Packages:** `@equationalapplications/schema-ea` (new)
**Depends on:** `@equationalapplications/core-llm-wiki` at the first release
shipping `OntologyNodeType.parent_type` (see
`2026-08-28-ontology-parent-field-spec.md`, rev 3). Pin the exact version in
`package.json` once that release lands — this manifest does not validate
against 6.0.1.

---

## Executive Summary

A new data-only package shipping a custom minimal ontology manifest for
Equational Applications' executive agent (Tessera). Merges the existing
warm-agent schema (9 types, 28 edges) with new software-company types
(3 base types, 5 concrete types, 17 edges) into a single 17-type,
45-edge manifest. Properties are baked into type descriptions (zero code
changes to core). Inspired by CodeMeta's property naming conventions but
fully custom — no external dependency.

---

## Problem Statement

Tessera operates as an executive agent for Equational Applications LLC,
managing products, services, procedures, and operational knowledge. The
current warm-agent schema (`schema-org-llm-wiki`) covers personal-life
concepts (friends, restaurants, events) but has no types for design specs,
handoffs, procedures, software products, or infrastructure services. A
separate executive schema is needed that:

1. Extends (does not replace) the warm-agent types.
2. Supports polymorphic queries via 2-level inheritance (parent spec).
3. Uses CodeMeta-shaped property conventions in frontmatter.
4. Stays minimal — only types Tessera actually traverses.

---

## Decisions

### D1: Single merged manifest, not two separate manifests

The warm-agent types and EA executive types live in one `schemaEaManifest`
export. A host that only wants warm-agent types can import
`schema-org-llm-wiki` instead. Tessera uses this merged manifest in strict
mode.

`schema-ea` takes **no runtime dependency** on `schema-org-llm-wiki`: one
package, one manifest, no version skew between two manifest packages for a
consumer to reconcile. The warm-agent rows are copied.

### D2: Copied rows are byte-identical, and a test proves it

The 9 warm-agent node types and 28 warm-agent edge types are copied
**verbatim** — full description text, not abridged. Descriptions are the
classification signal (D3); every clause dropped from a description is
classification guidance removed from the prompt.

Because copying invites drift, `schema-org-llm-wiki` is a **devDependency**
and a parity test asserts the copied rows deep-equal
`schemaOrgWarmAgentManifest`'s. Runtime stays dependency-free (D1); drift
fails CI instead of silently degrading classification.

**Rationale:** rev 1 of this spec abridged every warm-agent description by
roughly half (`product` lost "Covers electronics, vehicles, household items,
and software"; `creativework` lost "Captures media the user consumes, learns
from, or creates") while claiming the copy was verbatim. That is exactly the
failure this test catches.

### D3: Properties in type descriptions

Each node type's `description` string includes its expected frontmatter
properties. This requires zero code changes to `core-llm-wiki`:
`OntologyService.buildPromptContext` serializes the whole manifest with
`JSON.stringify(manifest, null, 2)` and hands it to
`buildOntologyPromptAppendix`, so description text — property list included —
reaches the classification prompt verbatim. Nothing needs expanding, because
nothing is expanded: the text is literally the field value.

### D4: Inheritance is a matching rule, not a property mechanism

`parent_type` affects **edge source matching only**. It does not merge,
expand, or inherit descriptions or properties anywhere in core.

A concrete type's description must therefore be self-contained. Any property
a subtype needs the LLM to populate is listed on that subtype, even if the
parent lists it too. There is no property inheritance to rely on.

### D5: Base types have no parent and no children

`software_application`, `service`, and `role` sit at the top level with no
`parent_type` and nothing beneath them. If subtypes are needed later (e.g.
`mobile_app` under `software_application`), add one level — never deeper than
2 total, which `validateManifest` enforces.

### D6: Target matching is exact — enumerate the pairs you need

Parent inheritance is **source-side only**. `OntologyService.resolveEdges`
matches `def.target_type` against the resolved target fact's `okf_type` with
an exact comparison, and the dependency spec's D3 keeps it that way.

Consequence: an edge declared `… → creativework` will **not** resolve to a
`design_spec`, `handoff`, `procedure`, `memory`, or `reference_doc` target.
It silently drops — `resolveEdges` skips the edge when no def's `target_type`
matches.

`supersedes` therefore cannot be declared once as `creativework →
creativework`; spec-supersedes-spec is its whole purpose and that row would
never resolve. It is enumerated as one row per concrete type instead (6 rows).

**Known limitation, accepted:** `itemReviewed review → creativework` likewise
cannot reach the five concrete subtypes. Reviewing a design spec is not a
Tessera workflow, so those rows are not enumerated. If that changes, add them
the same way.

### D7: CodeMeta as template, not dependency

Property naming follows CodeMeta conventions (snake_case, URL types for
links, single-word keys) but we define our own property set. No import of
`codemeta` terms or crosswalk. Properties live in OKF frontmatter, not in the
`OntologyManifest` type system.

---

## Node Types (17)

### Warm-Agent Types (9, verbatim from schema-org-llm-wiki)

| Type | Description |
|------|------------|
| `person` | A person—friend, family member, colleague, or public figure. Use this for any individual in the user's social, professional, or knowledge network. |
| `organization` | A company, nonprofit, club, sports team, or institution. Covers businesses, schools, local shops, and communities. |
| `place` | A geographic location, address, landmark, or venue. Use for cities, buildings, parks, restaurants, or any physical or conceptual location. |
| `event` | A scheduled or past gathering, meeting, conference, concert, or celebration. Links attendees and organizers to the event. |
| `project` | A multi-step initiative, goal, or endeavor. Use for personal projects, learning goals, business initiatives, or long-term objectives. |
| `action` | An individual task, chore, step, or completed action. Links to a parent Project and assigns responsibility to a Person. |
| `creativework` | A book, movie, article, song, recipe, blog post, or other creative content. Captures media the user consumes, learns from, or creates. |
| `review` | A personal review, opinion, or evaluation. The implicit subject is always the owning character—use to review a book, restaurant, place, product, or experience. Rating values stay inside the fact content. |
| `product` | A physical item, software tool, or device owned or under consideration. Covers electronics, vehicles, household items, and software. |

### EA Executive Base Types (3, no parent, no children)

| Type | Description |
|------|------------|
| `software_application` | A software product EA builds, ships, or maintains. Expected frontmatter properties: `repo_url`, `version`, `install_path`, `status` (active/deprecated/in_dev). |
| `service` | An external or internal service EA consumes or operates. Expected frontmatter properties: `provider`, `dashboard_url`, `status`, `tier` (critical/important/optional). |
| `role` | A functional role a person fills within EA. Expected frontmatter properties: `role_name`, `scope`, `capabilities`. |

### EA Executive Concrete Types (5, all `parent_type: 'creativework'`)

| Type | Parent | Description |
|------|--------|------------|
| `design_spec` | `creativework` | A technical or product design specification. Expected frontmatter properties: `status` (draft/approved/implemented/superseded), `spec_for` (product or service slug), `branch`. |
| `handoff` | `creativework` | An operational handoff or session transition document. Expected frontmatter properties: `session_id`, `outcome` (pending/complete/blocked), `open_items`. |
| `procedure` | `creativework` | A checklist, workflow, or how-to document. Expected frontmatter properties: `trigger` (when to use it), `last_reviewed`, `applies_to` (product or service slug). |
| `memory` | `creativework` | A dated recap of one working session. Use only for session records — ordinary facts are not memories. Expected frontmatter properties: `session_date`, `key_decisions` (comma-separated list). |
| `reference_doc` | `creativework` | A product doc, service description, or architecture reference. Expected frontmatter properties: `source_url`, `product` (slug). |

> **`software_application` vs `product` overlap.** The warm-agent `product`
> description covers "software tool" and "software." In strict mode both types
> compete for the same fact and nothing disambiguates them. The copy stays
> verbatim (D2), so the boundary is a prompt-level convention: `product` is
> something EA *owns or evaluates*; `software_application` is something EA
> *builds, ships, or maintains*. Watch classification output for drift here —
> if it misclassifies in practice, the fix is a description override on
> `product` (which then breaks D2's parity test deliberately, with a comment).

---

## Edge Types (45)

### Warm-Agent Edges (28, verbatim from schema-org-llm-wiki)

| Edge | Source → Target | Description |
|------|----------------|------------|
| `knows` | person → person | Friendship, acquaintance, or general connection between two people. |
| `spouse` | person → person | Spousal or long-term partner relationship. |
| `parent` | person → person | A parent of this person: the source is the child, the target is the parent. |
| `worksFor` | person → organization | Employment or primary professional affiliation. |
| `memberOf` | person → organization | Membership in clubs, associations, or communities. |
| `homeLocation` | person → place | Primary residence. |
| `workLocation` | person → place | Workplace or primary work location. |
| `location` | event → place | Venue or geographic location of an event. |
| `location` | organization → place | Physical headquarters or primary location. |
| `containedInPlace` | place → place | Hierarchical location containment. |
| `subOrganization` | project → project | Nested project hierarchy. |
| `object` | action → project | Project this task belongs to. |
| `agent` | action → person | Person responsible for or performing the action. |
| `attendee` | event → person | Person attending or participating in the event. |
| `organizer` | event → person | Person who organized the event. |
| `organizer` | event → organization | Organization hosting the event. |
| `author` | creativework → person | Author, creator, artist, or filmmaker. |
| `publisher` | creativework → organization | Publisher, platform, studio, or distributor. |
| `about` | creativework → person | Content centered on a specific person. |
| `about` | creativework → organization | Content centered on a company, institution, or group. |
| `about` | creativework → place | Content centered on a location. |
| `about` | creativework → event | Content centered on an event. |
| `itemReviewed` | review → creativework | The work this review evaluates. |
| `itemReviewed` | review → organization | The business this review evaluates. |
| `itemReviewed` | review → place | The venue this review evaluates. |
| `itemReviewed` | review → event | The event this review evaluates. |
| `itemReviewed` | review → product | The product this review evaluates. |
| `owns` | person → product | Item owned by the person. |

Note: the `about`, `author`, and `publisher` rows are declared on
`creativework` as **source**, so all five concrete subtypes satisfy them via
`parent_type` (D6). No enumeration needed on that side.

### EA Executive Edges (17, new)

| Edge | Source → Target | Description |
|------|----------------|------------|
| `dependsOn` | software_application → service | Product depends on this service. |
| `specifies` | design_spec → software_application | Spec is about this product. |
| `specifies` | design_spec → service | Spec is about this service. |
| `documents` | procedure → software_application | Procedure applies to this product. |
| `documents` | procedure → service | Procedure applies to this service. |
| `handoffFor` | handoff → software_application | Handoff is for this product. |
| `handoffFor` | handoff → service | Handoff is for this service. |
| `supersedes` | creativework → creativework | This document replaces an older one. |
| `supersedes` | design_spec → design_spec | This spec replaces an older spec. |
| `supersedes` | handoff → handoff | This handoff replaces an older handoff. |
| `supersedes` | procedure → procedure | This procedure replaces an older procedure. |
| `supersedes` | memory → memory | This recap replaces an older recap. |
| `supersedes` | reference_doc → reference_doc | This reference replaces an older one. |
| `hasRole` | person → role | Person fills this role. |
| `operates` | role → software_application | Role is responsible for this product. |
| `provides` | organization → service | Organization provides this service. |
| `maintains` | person → software_application | Person maintains this product. |

---

## Package Structure

```text
packages/schema-ea/
├── package.json          # @equationalapplications/schema-ea
├── tsconfig.json         # extends monorepo root
├── tsup.config.ts        # mirrors packages/schema-org
├── vitest.config.ts      # mirrors packages/schema-org
├── src/
│   └── index.ts          # exports schemaEaManifest
├── __tests__/
│   └── manifest.test.ts  # validation + warm-agent parity (D2)
└── README.md             # type catalog, usage, property conventions
```

`package.json` mirrors `packages/schema-org/package.json`: `main`/`module`/
`types` pointing into `dist`, the `exports` map, `files: ["dist", "LICENSE",
"README.md"]`, scripts `build` (tsup) / `dev` / `typecheck` / `test` /
`test:watch`, `publishConfig.access: "public"`, and
`repository.directory: "packages/schema-ea"`.

- **dependencies:** `@equationalapplications/core-llm-wiki` (workspace:\*)
- **devDependencies:** `@equationalapplications/schema-org-llm-wiki`
  (workspace:\*, for the D2 parity test only), `tsup`, `typescript`, `vitest`

### `src/index.ts`

```ts
import type { OntologyManifest } from '@equationalapplications/core-llm-wiki';

export const schemaEaManifest: OntologyManifest = {
  node_types: [
    // Warm-agent types — copied verbatim from schemaOrgWarmAgentManifest.
    // Do not abridge: descriptions are the classification signal (D2/D3).
    { type: 'person', description: "A person—friend, family member, colleague, or public figure. Use this for any individual in the user's social, professional, or knowledge network." },
    { type: 'organization', description: 'A company, nonprofit, club, sports team, or institution. Covers businesses, schools, local shops, and communities.' },
    { type: 'place', description: 'A geographic location, address, landmark, or venue. Use for cities, buildings, parks, restaurants, or any physical or conceptual location.' },
    { type: 'event', description: 'A scheduled or past gathering, meeting, conference, concert, or celebration. Links attendees and organizers to the event.' },
    { type: 'project', description: 'A multi-step initiative, goal, or endeavor. Use for personal projects, learning goals, business initiatives, or long-term objectives.' },
    { type: 'action', description: 'An individual task, chore, step, or completed action. Links to a parent Project and assigns responsibility to a Person.' },
    { type: 'creativework', description: 'A book, movie, article, song, recipe, blog post, or other creative content. Captures media the user consumes, learns from, or creates.' },
    { type: 'review', description: 'A personal review, opinion, or evaluation. The implicit subject is always the owning character—use to review a book, restaurant, place, product, or experience. Rating values stay inside the fact content.' },
    { type: 'product', description: 'A physical item, software tool, or device owned or under consideration. Covers electronics, vehicles, household items, and software.' },
    // EA executive base types (no parent_type, no children — D5)
    { type: 'software_application', description: 'A software product EA builds, ships, or maintains. Expected frontmatter properties: repo_url, version, install_path, status (active/deprecated/in_dev).' },
    { type: 'service', description: 'An external or internal service EA consumes or operates. Expected frontmatter properties: provider, dashboard_url, status, tier (critical/important/optional).' },
    { type: 'role', description: 'A functional role a person fills within EA. Expected frontmatter properties: role_name, scope, capabilities.' },
    // EA executive concrete types (one level under creativework)
    { type: 'design_spec', parent_type: 'creativework', description: 'A technical or product design specification. Expected frontmatter properties: status (draft/approved/implemented/superseded), spec_for (product or service slug), branch.' },
    { type: 'handoff', parent_type: 'creativework', description: 'An operational handoff or session transition document. Expected frontmatter properties: session_id, outcome (pending/complete/blocked), open_items.' },
    { type: 'procedure', parent_type: 'creativework', description: 'A checklist, workflow, or how-to document. Expected frontmatter properties: trigger (when to use it), last_reviewed, applies_to (product or service slug).' },
    { type: 'memory', parent_type: 'creativework', description: 'A dated recap of one working session. Use only for session records — ordinary facts are not memories. Expected frontmatter properties: session_date, key_decisions (comma-separated list).' },
    { type: 'reference_doc', parent_type: 'creativework', description: 'A product doc, service description, or architecture reference. Expected frontmatter properties: source_url, product (slug).' },
  ],
  edge_types: [
    // Warm-agent edges — copied verbatim from schemaOrgWarmAgentManifest (D2).
    { type: 'knows', source_type: 'person', target_type: 'person', description: 'Friendship, acquaintance, or general connection between two people.' },
    { type: 'spouse', source_type: 'person', target_type: 'person', description: 'Spousal or long-term partner relationship.' },
    { type: 'parent', source_type: 'person', target_type: 'person', description: 'A parent of this person: the source is the child, the target is the parent.' },
    { type: 'worksFor', source_type: 'person', target_type: 'organization', description: 'Employment or primary professional affiliation.' },
    { type: 'memberOf', source_type: 'person', target_type: 'organization', description: 'Membership in clubs, associations, or communities.' },
    { type: 'homeLocation', source_type: 'person', target_type: 'place', description: 'Primary residence.' },
    { type: 'workLocation', source_type: 'person', target_type: 'place', description: 'Workplace or primary work location.' },
    { type: 'location', source_type: 'event', target_type: 'place', description: 'Venue or geographic location of an event.' },
    { type: 'location', source_type: 'organization', target_type: 'place', description: 'Physical headquarters or primary location.' },
    { type: 'containedInPlace', source_type: 'place', target_type: 'place', description: 'Hierarchical location: the source place is inside the target place (e.g., Paris is contained in France).' },
    { type: 'subOrganization', source_type: 'project', target_type: 'project', description: 'Nested project hierarchy: the target is a sub-project contained in the source project.' },
    { type: 'object', source_type: 'action', target_type: 'project', description: 'Project this task belongs to; the object the action advances.' },
    { type: 'agent', source_type: 'action', target_type: 'person', description: 'Person responsible for or performing the action.' },
    { type: 'attendee', source_type: 'event', target_type: 'person', description: 'Person attending or participating in the event.' },
    { type: 'organizer', source_type: 'event', target_type: 'person', description: 'Person who organized the event.' },
    { type: 'organizer', source_type: 'event', target_type: 'organization', description: 'Organization hosting the event.' },
    { type: 'author', source_type: 'creativework', target_type: 'person', description: 'Author, creator, artist, or filmmaker.' },
    { type: 'publisher', source_type: 'creativework', target_type: 'organization', description: 'Publisher, platform, studio, or distributor.' },
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'Content centered on a specific person.' },
    { type: 'about', source_type: 'creativework', target_type: 'organization', description: 'Content centered on a company, institution, or group.' },
    { type: 'about', source_type: 'creativework', target_type: 'place', description: 'Content centered on a location (travel guide, history).' },
    { type: 'about', source_type: 'creativework', target_type: 'event', description: 'Content centered on an event (documentary, article).' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'creativework', description: 'The book, movie, article, or other work this review evaluates.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'organization', description: 'The business, restaurant, or institution this review evaluates.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'place', description: 'The venue, park, or location this review evaluates.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'event', description: 'The event this review evaluates.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'product', description: 'The tool, device, or product this review evaluates.' },
    { type: 'owns', source_type: 'person', target_type: 'product', description: 'Item owned by the person (electronics, vehicles, etc.).' },
    // EA executive edges (17, new)
    { type: 'dependsOn', source_type: 'software_application', target_type: 'service', description: 'Product depends on this service.' },
    { type: 'specifies', source_type: 'design_spec', target_type: 'software_application', description: 'Spec is about this product.' },
    { type: 'specifies', source_type: 'design_spec', target_type: 'service', description: 'Spec is about this service.' },
    { type: 'documents', source_type: 'procedure', target_type: 'software_application', description: 'Procedure applies to this product.' },
    { type: 'documents', source_type: 'procedure', target_type: 'service', description: 'Procedure applies to this service.' },
    { type: 'handoffFor', source_type: 'handoff', target_type: 'software_application', description: 'Handoff is for this product.' },
    { type: 'handoffFor', source_type: 'handoff', target_type: 'service', description: 'Handoff is for this service.' },
    // supersedes is enumerated per concrete type: target matching is exact,
    // so a lone creativework -> creativework row never resolves for a
    // design_spec -> design_spec pair (D6).
    { type: 'supersedes', source_type: 'creativework', target_type: 'creativework', description: 'This document replaces an older one.' },
    { type: 'supersedes', source_type: 'design_spec', target_type: 'design_spec', description: 'This spec replaces an older spec.' },
    { type: 'supersedes', source_type: 'handoff', target_type: 'handoff', description: 'This handoff replaces an older handoff.' },
    { type: 'supersedes', source_type: 'procedure', target_type: 'procedure', description: 'This procedure replaces an older procedure.' },
    { type: 'supersedes', source_type: 'memory', target_type: 'memory', description: 'This recap replaces an older recap.' },
    { type: 'supersedes', source_type: 'reference_doc', target_type: 'reference_doc', description: 'This reference replaces an older one.' },
    { type: 'hasRole', source_type: 'person', target_type: 'role', description: 'Person fills this role.' },
    { type: 'operates', source_type: 'role', target_type: 'software_application', description: 'Role is responsible for this product.' },
    { type: 'provides', source_type: 'organization', target_type: 'service', description: 'Organization provides this service.' },
    { type: 'maintains', source_type: 'person', target_type: 'software_application', description: 'Person maintains this product.' },
  ],
};
```

---

## Property Conventions (CodeMeta-shaped)

### Naming
- snake_case (e.g. `repo_url`, `install_path`)
- Single-word keys where possible
- URL values for links (not display text)

### No property inheritance

Per D4, `parent_type` is a matching rule for edge sources. Core does not
merge, expand, or inherit descriptions, and nothing propagates a parent's
properties to a subtype's prompt text.

So a subtype's description must list every property the LLM should populate,
including any the parent also lists. `creativework` declares no properties in
this manifest, so there is nothing to inherit from in the first place — the
five concrete types each carry their own complete list.

Common schema.org fields (`name`, `url`, `dateCreated`, `author`) are left
unlisted deliberately: they come from the model's schema.org knowledge, not
from anything in this manifest. Do not describe that as inheritance.

### Status enums
- Where a property has a fixed set of values, they are listed in the
  description in parentheses (e.g. `status (active/deprecated/in_dev)`).

---

## Relation to `schema-org-llm-wiki`

`schema-org-llm-wiki` ships the warm-agent manifest (9 types, 28 edges) for
personal-life knowledge graphs. It stays unchanged.

`schema-ea` is the superset: it copies the warm-agent rows verbatim and adds
the executive types. A consumer importing `schema-ea` does NOT need
`schema-org-llm-wiki` at runtime — it is a devDependency here solely for the
D2 parity test.

---

## Tests

1. **Manifest validates** — `validateManifest(schemaEaManifest)` does not
   throw (requires the core release with `parent_type`).
2. **Counts are what the spec claims** — 17 node types, 45 edge types.
3. **No duplicate node slugs** across warm-agent + EA types.
4. **Edge triples are unique** — polymorphic edges (`specifies`, `documents`,
   `handoffFor`, `supersedes`, `about`, `itemReviewed`, `location`,
   `organizer`) appear as distinct `(type, source, target)` rows.
5. **All `parent_type` references resolve** to a node in the same manifest,
   and no parent itself has a `parent_type` (one level — D5).
6. **Warm-agent parity (D2)** — the 9 node rows and 28 edge rows copied from
   `schemaOrgWarmAgentManifest` deep-equal their originals. This is the drift
   guard; it fails if anyone abridges a description.
7. **Type descriptions contain expected property names** — `repo_url`,
   `spec_for`, `session_id`, `dashboard_url`, `role_name`, `source_url`,
   `trigger`, `session_date`.
8. **`supersedes` resolves for a concrete pair** — with the core release in
   place, a `design_spec → design_spec` supersedes edge survives
   `resolveEdges` (regression guard for D6).

---

## What This Does NOT Include

- No property schema types — properties are frontmatter conventions, not
  `OntologyManifest` fields
- No property inheritance (D4) — core has none, and this spec does not ask
  for it
- No parent-aware target matching (D6) — pairs are enumerated instead
- No runtime logic — purely a data package
- No runtime dependency on `schema-org-llm-wiki` (devDependency only, for the
  parity test)
- No dependency on CodeMeta (inspired by, not imported from)
- No `itemReviewed` rows for the concrete `creativework` subtypes (D6)

---

## Revisions

- **Rev 1 (2026-08-28)** — initial draft.
- **Rev 2 (2026-08-30)** — review against source. Renamed `parent` →
  `parent_type` (dependency spec rev 3). Corrected counts: 17 nodes (was
  claimed 18 with "4 parent types"; only 3 exist) and 45 edges (was 40 —
  `supersedes` expanded from 1 row to 6). Added D6: target matching is exact,
  so the single `creativework → creativework` supersedes row could never
  resolve for a `design_spec → design_spec` pair — the edge was dead on
  arrival. Restored verbatim warm-agent descriptions (rev 1 abridged them
  ~50% while claiming verbatim) and added D2's parity test as a drift guard.
  Split rev 1's D3 into D3 (properties in descriptions — unchanged and
  correct: `buildPromptContext` JSON-serializes descriptions into the prompt,
  no core change needed) and D4 (there is no property inheritance; the
  "subtypes implicitly inherit from the parent" claim was false and is
  removed). Renamed "Parent Types" → "Base Types" (they have no children).
  Filled out the package skeleton (tsup/vitest configs, scripts, deps) to
  mirror `packages/schema-org`. Pinned the core dependency statement.
