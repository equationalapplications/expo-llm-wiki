# @equationalapplications/schema-ea — Spec

**Date:** 2026-08-28
**Status:** Draft
**Packages:** `@equationalapplications/schema-ea` (new)
**Depends on:** `@equationalapplications/core-llm-wiki` (with parent field, 2026-08-28-ontology-parent-field-spec)

---

## Executive Summary

A new data-only package shipping a custom minimal ontology manifest for
Equational Applications' executive agent (Tessera). Merges the existing
warm-agent schema (9 types, 28 edges) with new software-company types
(4 parent types, 5 concrete types, 12 edges) into a single 18-type,
40-edge manifest. Properties are baked into type descriptions (zero code
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

The warm-agent types and EA executive types live in one
`schemaEaManifest` export. A host that only wants warm-agent types can
import `schema-org-llm-wiki` instead. Tessera uses this merged manifest
in strict mode.

### D2: CodeMeta as template, not dependency

Property naming follows CodeMeta conventions (snake_case, URL types for
links, single-word keys) but we define our own property set. No import
of `codemeta` terms or crosswalk. Properties live in OKF frontmatter,
not in the OntologyManifest type system.

### D3: Properties in type descriptions

Each node type's `description` string includes its expected frontmatter
properties. This requires zero code changes to `core-llm-wiki` — the
description is already injected into classification prompts via
`buildOntologyPromptAppendix`.

### D4: Leaf types have no children

`software_application`, `service`, and `role` are leaf types today. If
subtypes are needed later (e.g. `mobile_app` under
`software_application`), add one level — never deeper than 2 total.

---

## Node Types (18)

### Warm-Agent Types (9, unchanged from schema-org-llm-wiki)

| Type | Description |
|------|------------|
| `person` | A person — friend, family member, colleague, or public figure. |
| `organization` | A company, nonprofit, club, or institution. |
| `place` | A geographic location, address, landmark, or venue. |
| `event` | A scheduled or past gathering, meeting, or celebration. |
| `project` | A multi-step initiative, goal, or endeavor. |
| `action` | An individual task, chore, step, or completed action. |
| `creativework` | A book, movie, article, or other creative content. |
| `review` | A personal review or evaluation. |
| `product` | A physical item, software tool, or device. |

### EA Executive Parent Types (3, all leaf — no children)

| Type | Description |
|------|------------|
| `software_application` | A software product EA builds, ships, or maintains. Leaf type. Expected frontmatter properties: `repo_url`, `version`, `install_path`, `status` (active/deprecated/in_dev). |
| `service` | An external or internal service EA consumes or operates. Leaf type. Expected frontmatter properties: `provider`, `dashboard_url`, `status`, `tier` (critical/important/optional). |
| `role` | A functional role a person fills within EA. Leaf type. Expected frontmatter properties: `role_name`, `scope`, `capabilities`. |

### EA Executive Concrete Types (5, all under `creativework`)

| Type | Parent | Description |
|------|--------|------------|
| `design_spec` | `creativework` | A technical or product design specification. Expected frontmatter properties: `status` (draft/approved/implemented/superseded), `spec_for` (product or service slug), `branch`. |
| `handoff` | `creativework` | An operational handoff or session transition document. Expected frontmatter properties: `session_id`, `outcome` (pending/complete/blocked), `open_items`. |
| `procedure` | `creativework` | A checklist, workflow, or how-to document. Expected frontmatter properties: `trigger` (when to use it), `last_reviewed`, `applies_to` (product or service slug). |
| `memory` | `creativework` | An episodic memory or session recap. Expected frontmatter properties: `session_date`, `key_decisions` (comma-separated list). |
| `reference_doc` | `creativework` | A product doc, service description, or architecture reference. Expected frontmatter properties: `source_url`, `product` (slug). |

---

## Edge Types (40)

### Warm-Agent Edges (28, unchanged from schema-org-llm-wiki)

| Edge | Source → Target | Description |
|------|----------------|------------|
| `knows` | person → person | Friendship or general connection. |
| `spouse` | person → person | Spousal or long-term partner relationship. |
| `parent` | person → person | The source is the child, target is the parent. |
| `worksFor` | person → organization | Employment or primary professional affiliation. |
| `memberOf` | person → organization | Membership in clubs or communities. |
| `homeLocation` | person → place | Primary residence. |
| `workLocation` | person → place | Workplace or primary work location. |
| `location` | event → place | Venue of an event. |
| `location` | organization → place | Physical headquarters. |
| `containedInPlace` | place → place | Hierarchical location containment. |
| `subOrganization` | project → project | Nested project hierarchy. |
| `object` | action → project | Project this task advances. |
| `agent` | action → person | Person performing the action. |
| `attendee` | event → person | Person attending. |
| `organizer` | event → person | Person who organized. |
| `organizer` | event → organization | Organization hosting. |
| `author` | creativework → person | Author or creator. |
| `publisher` | creativework → organization | Publisher or platform. |
| `about` | creativework → person | Content centered on a person. |
| `about` | creativework → organization | Content centered on a company. |
| `about` | creativework → place | Content centered on a location. |
| `about` | creativework → event | Content centered on an event. |
| `itemReviewed` | review → creativework | Review evaluates this work. |
| `itemReviewed` | review → organization | Review evaluates this business. |
| `itemReviewed` | review → place | Review evaluates this venue. |
| `itemReviewed` | review → event | Review evaluates this event. |
| `itemReviewed` | review → product | Review evaluates this product. |
| `owns` | person → product | Item owned by the person. |

### EA Executive Edges (12, new)

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
| `hasRole` | person → role | Person fills this role. |
| `operates` | role → software_application | Role is responsible for this product. |
| `provides` | organization → service | Organization provides this service. |
| `maintains` | person → software_application | Person maintains this product. |

---

## Package Structure

```
packages/schema-ea/
├── package.json          # @equationalapplications/schema-ea
├── tsconfig.json         # extends monorepo root
├── src/
│   └── index.ts          # exports schemaEaManifest
└── README.md             # type catalog, usage, property conventions
```

### `src/index.ts`

```ts
import type { OntologyManifest } from '@equationalapplications/core-llm-wiki';

export const schemaEaManifest: OntologyManifest = {
  node_types: [
    // Warm-agent types
    { type: 'person', description: 'A person — friend, family member, colleague, or public figure.' },
    { type: 'organization', description: 'A company, nonprofit, club, or institution.' },
    { type: 'place', description: 'A geographic location, address, landmark, or venue.' },
    { type: 'event', description: 'A scheduled or past gathering, meeting, or celebration.' },
    { type: 'project', description: 'A multi-step initiative, goal, or endeavor.' },
    { type: 'action', description: 'An individual task, chore, step, or completed action.' },
    { type: 'creativework', description: 'A book, movie, article, or other creative content.' },
    { type: 'review', description: 'A personal review or evaluation.' },
    { type: 'product', description: 'A physical item, software tool, or device.' },
    // EA executive parent types
    { type: 'software_application', description: 'A software product EA builds, ships, or maintains. Leaf type. Expected frontmatter properties: repo_url, version, install_path, status (active/deprecated/in_dev).' },
    { type: 'service', description: 'An external or internal service EA consumes or operates. Leaf type. Expected frontmatter properties: provider, dashboard_url, status, tier (critical/important/optional).' },
    { type: 'role', description: 'A functional role a person fills within EA. Leaf type. Expected frontmatter properties: role_name, scope, capabilities.' },
    // EA executive concrete types (under creativework)
    { type: 'design_spec', parent: 'creativework', description: 'A technical or product design specification. Expected frontmatter properties: status (draft/approved/implemented/superseded), spec_for (product or service slug), branch.' },
    { type: 'handoff', parent: 'creativework', description: 'An operational handoff or session transition document. Expected frontmatter properties: session_id, outcome (pending/complete/blocked), open_items.' },
    { type: 'procedure', parent: 'creativework', description: 'A checklist, workflow, or how-to document. Expected frontmatter properties: trigger (when to use it), last_reviewed, applies_to (product or service slug).' },
    { type: 'memory', parent: 'creativework', description: 'An episodic memory or session recap. Expected frontmatter properties: session_date, key_decisions (comma-separated list).' },
    { type: 'reference_doc', parent: 'creativework', description: 'A product doc, service description, or architecture reference. Expected frontmatter properties: source_url, product (slug).' },
  ],
  edge_types: [
    // Warm-agent edges (28, unchanged — see Edge Types table above)
    { type: 'knows', source_type: 'person', target_type: 'person', description: 'Friendship or general connection.' },
    { type: 'spouse', source_type: 'person', target_type: 'person', description: 'Spousal or long-term partner relationship.' },
    { type: 'parent', source_type: 'person', target_type: 'person', description: 'The source is the child, target is the parent.' },
    { type: 'worksFor', source_type: 'person', target_type: 'organization', description: 'Employment or primary professional affiliation.' },
    { type: 'memberOf', source_type: 'person', target_type: 'organization', description: 'Membership in clubs or communities.' },
    { type: 'homeLocation', source_type: 'person', target_type: 'place', description: 'Primary residence.' },
    { type: 'workLocation', source_type: 'person', target_type: 'place', description: 'Workplace or primary work location.' },
    { type: 'location', source_type: 'event', target_type: 'place', description: 'Venue of an event.' },
    { type: 'location', source_type: 'organization', target_type: 'place', description: 'Physical headquarters.' },
    { type: 'containedInPlace', source_type: 'place', target_type: 'place', description: 'Hierarchical location containment.' },
    { type: 'subOrganization', source_type: 'project', target_type: 'project', description: 'Nested project hierarchy.' },
    { type: 'object', source_type: 'action', target_type: 'project', description: 'Project this task advances.' },
    { type: 'agent', source_type: 'action', target_type: 'person', description: 'Person performing the action.' },
    { type: 'attendee', source_type: 'event', target_type: 'person', description: 'Person attending.' },
    { type: 'organizer', source_type: 'event', target_type: 'person', description: 'Person who organized.' },
    { type: 'organizer', source_type: 'event', target_type: 'organization', description: 'Organization hosting.' },
    { type: 'author', source_type: 'creativework', target_type: 'person', description: 'Author or creator.' },
    { type: 'publisher', source_type: 'creativework', target_type: 'organization', description: 'Publisher or platform.' },
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'Content centered on a person.' },
    { type: 'about', source_type: 'creativework', target_type: 'organization', description: 'Content centered on a company.' },
    { type: 'about', source_type: 'creativework', target_type: 'place', description: 'Content centered on a location.' },
    { type: 'about', source_type: 'creativework', target_type: 'event', description: 'Content centered on an event.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'creativework', description: 'Review evaluates this work.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'organization', description: 'Review evaluates this business.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'place', description: 'Review evaluates this venue.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'event', description: 'Review evaluates this event.' },
    { type: 'itemReviewed', source_type: 'review', target_type: 'product', description: 'Review evaluates this product.' },
    { type: 'owns', source_type: 'person', target_type: 'product', description: 'Item owned by the person.' },
    // EA executive edges (12, new)
    { type: 'dependsOn', source_type: 'software_application', target_type: 'service', description: 'Product depends on this service.' },
    { type: 'specifies', source_type: 'design_spec', target_type: 'software_application', description: 'Spec is about this product.' },
    { type: 'specifies', source_type: 'design_spec', target_type: 'service', description: 'Spec is about this service.' },
    { type: 'documents', source_type: 'procedure', target_type: 'software_application', description: 'Procedure applies to this product.' },
    { type: 'documents', source_type: 'procedure', target_type: 'service', description: 'Procedure applies to this service.' },
    { type: 'handoffFor', source_type: 'handoff', target_type: 'software_application', description: 'Handoff is for this product.' },
    { type: 'handoffFor', source_type: 'handoff', target_type: 'service', description: 'Handoff is for this service.' },
    { type: 'supersedes', source_type: 'creativework', target_type: 'creativework', description: 'This document replaces an older one.' },
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

### Inheritance
- All `creativework` subtypes implicitly have `name`, `url`, `dateCreated`,
  `author` from schema.org base types. These are NOT redeclared in the
  type description — the LLM knows them from the parent.
- Only EA-specific properties are listed in descriptions.

### Status enums
- Where a property has a fixed set of values, they are listed in the
  description in parentheses (e.g. `status (active/deprecated/in_dev)`).

---

## Relation to `schema-org-llm-wiki`

`schema-org-llm-wiki` ships the warm-agent manifest (9 types, 28 edges)
for personal-life knowledge graphs. It stays unchanged.

`schema-ea` is the superset: it copies the warm-agent types verbatim and
adds the executive types. A consumer importing `schema-ea` does NOT need
`schema-org-llm-wiki`.

---

## Tests

1. **Manifest validates** against `validateManifest` from core-llm-wiki
   (after parent field is implemented).
2. **No duplicate slugs** across warm-agent + EA types.
3. **All parent references resolve** — `design_spec.parent` → `creativework`
   exists.
4. **Edge type/source/target triples are unique** — polymorphic edges
   like `specifies` appear as distinct rows.
5. **Type descriptions contain expected property names** — grep for
   `repo_url`, `spec_for`, `session_id`, etc.

---

## What This Does NOT Include

- No property schema types — properties are frontmatter conventions, not
  OntologyManifest fields
- No runtime logic — purely a data package
- No dependency on `schema-org-llm-wiki` (warm-agent types are copied)
- No dependency on CodeMeta (inspired by, not imported from)
