# @equationalapplications/schema-software-org — Spec

**Date:** 2026-08-28
**Status:** Implemented (rev 9, 2026-08-30 — implementation landed in PR #111, commits `d988406`..`9c048f4` on branch `docs/schema-ea-executive-ontology-spec`)
**Packages:** `@equationalapplications/schema-software-org` (new)
**Depends on:** `@equationalapplications/core-llm-wiki` **>= 6.1.0** — the
release that shipped `OntologyNodeType.parent_type` (see
`2026-08-28-ontology-parent-field-spec.md`, rev 8 — Implemented). This
manifest does not validate against 6.0.1. In-repo the dependency is
`workspace:*`, which resolves to the current workspace version (6.1.0) at
publish time; no manual pin is needed.

---

## Executive Summary

A new data-only package shipping a custom minimal ontology manifest for an
executive agent operating on behalf of a software organization. Merges the
existing warm-agent schema (9 types, 28 edges) with new software-company types
(3 base types, 5 concrete types, 12 edges) into a single 17-type,
40-edge manifest. Properties are baked into type descriptions (zero code
changes to core). Inspired by CodeMeta's property naming conventions but
fully custom — no external dependency.

The manifest is organization-neutral: descriptions say "the organization",
never a specific company name, so any software org can adopt it unmodified.
Equational Applications' executive agent (Tessera) is the first consumer and
the source of the requirements, not the audience limit.

**Accepted cost (D3).** Serializing this manifest costs ~11.3 KB
(~2.9k tokens) in every extraction prompt, against ~6.7 KB (~1.7k tokens) for
`schema-org-llm-wiki` — a ~68% increase per ingest call, permanently. That is
the price of D3 (properties live in descriptions) plus D2 (warm-agent rows
copied verbatim rather than abridged), and what it buys is zero code changes to
core. Measured over the manifest block below as
`JSON.stringify(manifest, null, 2)` — the exact form
`OntologyService.buildPromptContext` sends.

---

## Problem Statement

An executive agent for a software organization manages products, services,
procedures, and operational knowledge. The current warm-agent schema
(`schema-org-llm-wiki`) covers personal-life concepts (friends, restaurants,
events) but has no types for design specs, handoffs, procedures, software
products, or infrastructure services. A separate executive schema is needed
that:

1. Extends (does not replace) the warm-agent types.
2. Supports polymorphic queries via 2-level inheritance (parent spec).
3. Uses CodeMeta-shaped property conventions in frontmatter.
4. Stays minimal — only types an executive agent actually traverses.

---

## Decisions

### D1: Single merged manifest, not two separate manifests

The warm-agent types and the software-org types live in one
`schemaSoftwareOrgManifest` export. A host that only wants warm-agent types can
import `schema-org-llm-wiki` instead. Tessera uses this merged manifest in
strict mode.

`schema-software-org` takes **no runtime dependency** on
`schema-org-llm-wiki`: one package, one manifest, no version skew between two
manifest packages for a consumer to reconcile. The warm-agent rows are
copied.

### D2: Copied rows are byte-identical, and a test proves it

The 9 warm-agent node types and 28 warm-agent edge types are copied
**verbatim** — full description text, not abridged. Descriptions are the
classification signal (D3); every clause dropped from a description is
classification guidance removed from the prompt.

Because copying invites drift, `schema-org-llm-wiki` is a **devDependency**
and a parity test asserts the copied rows deep-equal
`schemaOrgWarmAgentManifest`'s. Runtime stays dependency-free (D1); drift
fails CI instead of silently degrading classification.

The catalog tables in this document are held to the same standard: they must
reproduce the same text as the manifest block, not a summary of it. Two
different values for one row is how rev 1 and rev 2 both went wrong.

The test exists to catch *accidental* drift, so it carries an explicit
allowlist of *intentional* divergences — currently one row, `product` (D8).
An entry in that allowlist must state its reason, and the test asserts each
entry still actually diverges from upstream, so a stale exception cannot sit
there masking real drift.

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

`parent_type` affects **edge matching only** — source *and* target, per D6.
It does not merge, expand, or inherit descriptions or properties anywhere in
core.

A concrete type's description must therefore be self-contained. Any property
a subtype needs the LLM to populate is listed on that subtype, even if the
parent lists it too. There is no property inheritance to rely on.

### D5: Base types have no parent and no children

`software_application`, `service`, and `role` sit at the top level with no
`parent_type` and nothing beneath them. If subtypes are needed later (e.g.
`mobile_app` under `software_application`), add one level — never deeper than
2 total, which `validateManifest` enforces.

### D6: Matching is parent-aware on both sides — declare on the parent

Core matches a concrete type against an edge definition's declared type on
**both** sides via a one-hop `parent_type` lookup, with targets resolved
**exact-first** (`OntologyService.resolveEdges` runs an exact `target_type`
pass, then a parent pass). See the dependency spec's D3.

So an edge declared on `creativework` covers all five concrete subtypes as
source *and* as target, and each polymorphic relationship needs exactly one
row. `supersedes` is declared once as `creativework → creativework` and
resolves a `design_spec → design_spec` pair; `itemReviewed review →
creativework` reaches every subtype the same way, with no extra rows.

**Accepted cost:** declaring `→ creativework` admits every child, with no way
to mean "the parent type only". Where a narrower target is wanted, declare the
concrete row explicitly — the exact-first pass makes it win over the broad one.

*Rev 2 of this spec enumerated `supersedes` per concrete type, because target
matching was exact at the time. The dependency spec's rev 4 made matching
symmetric, so the enumeration is gone.*

### D7: CodeMeta as template, not dependency

Property naming follows CodeMeta conventions (snake_case, URL types for
links, single-word keys) but we define our own property set. No import of
`codemeta` terms or crosswalk. Properties live in OKF frontmatter, not in the
`OntologyManifest` type system.

### D8: `product` diverges from upstream, deliberately

The warm-agent `product` description ends "Covers electronics, vehicles,
household items, **and software**." Fed to the model alongside
`software_application`, that clause pulls the organization's own repositories
into `product` on the word "software" alone. An executive agent's notion of
"product" is not a warm personal agent's.

So `schema-software-org` overrides that one row: the trailing "and software" is
dropped and the description hands off explicitly — "For software the
organization builds, ships, or maintains, use software_application instead; for
a hosted capability it consumes or operates, use service."
`software_application` and `service` name each other back, so the
disambiguation is mutual rather than one-way.

**Rationale:** the alternatives are worse. Injecting the rule into the system
prompt requires profile-specific classification logic in core, which is the
code change D3 exists to avoid. Renaming `software_application` to something
like `org_portfolio_product` dodges the collision by making the slug clunky
while leaving the misleading `product` text in the prompt unchanged. Putting
the rule where the model makes the decision is the only fix that acts on the
actual input.

This is the one sanctioned exception to D2. It is registered in the parity
test's allowlist with this reason; anything else that diverges is a bug.

---

## Node Types (17)

### Warm-Agent Types (9, verbatim from schema-org-llm-wiki except `product` — D8)

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
| `product` | A physical item, software tool, or device owned or under consideration. Covers electronics, vehicles, and household items. For software the organization builds, ships, or maintains, use software_application instead; for a hosted capability it consumes or operates, use service. **(D8: diverges from upstream.)** |

### Software-Org Base Types (3, no parent, no children)

| Type | Description |
|------|------------|
| `software_application` | Software the organization itself builds, ships, or maintains — its own portfolio codebase. Not third-party software the organization merely uses (that is `product`), and not a running hosted capability (that is `service`). Expected frontmatter properties: `repo_url`, `version`, `install_path`, `status` (active/deprecated/in_dev). |
| `service` | A running hosted capability the organization consumes or operates, vendor-run or self-run — databases, APIs, CI, auth, monitoring. Distinct from `software_application` (the codebase the organization ships) and `product` (third-party tools it owns). The organization's own backend is a `software_application` as source and a `service` as a deployed dependency. Expected frontmatter properties: `provider`, `dashboard_url`, `status`, `tier` (critical/important/optional). |
| `role` | A functional role a person fills within the organization. Expected frontmatter properties: `role_name`, `scope`, `capabilities`. |

### Software-Org Concrete Types (5, all `parent_type: 'creativework'`)

| Type | Parent | Description |
|------|--------|------------|
| `design_spec` | `creativework` | A technical or product design specification. Expected frontmatter properties: `status` (draft/approved/implemented/superseded), `spec_for` (`software_application` or `service` slug), `branch`. |
| `handoff` | `creativework` | An operational handoff or session transition document. Expected frontmatter properties: `session_id`, `outcome` (pending/complete/blocked), `open_items`. |
| `procedure` | `creativework` | A checklist, workflow, or how-to document. Expected frontmatter properties: `trigger` (when to use it), `last_reviewed`, `applies_to` (`software_application` or `service` slug). |
| `session_recap` | `creativework` | A dated recap of one working session. Use only for session records — ordinary facts are not memories. Expected frontmatter properties: `session_date`, `key_decisions` (comma-separated list). |
| `reference_doc` | `creativework` | A product doc, service description, or architecture reference. Expected frontmatter properties: `source_url`, `application` (`software_application` slug). |

> **Disambiguation.** Three types could plausibly claim a piece of software.
> The manifest resolves this inline, in the descriptions the model actually
> reads, rather than by convention (D8):
>
> - `product` — a thing the organization **owns or evaluates**. Explicitly
>   hands off software it builds to `software_application`.
> - `software_application` — a codebase the organization **builds, ships, or
>   maintains**.
> - `service` — a **running hosted capability** something depends on, whether
>   vendor-run or self-run.
>
> The organization's own backend is a `software_application` as source and a
> `service` as a deployed dependency — which is exactly what `dependsOn`
> (software_application → service) is for.

---

## Edge Types (40)

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
| `containedInPlace` | place → place | Hierarchical location: the source place is inside the target place (e.g., Paris is contained in France). |
| `subOrganization` | project → project | Nested project hierarchy: the target is a sub-project contained in the source project. |
| `object` | action → project | Project this task belongs to; the object the action advances. |
| `agent` | action → person | Person responsible for or performing the action. |
| `attendee` | event → person | Person attending or participating in the event. |
| `organizer` | event → person | Person who organized the event. |
| `organizer` | event → organization | Organization hosting the event. |
| `author` | creativework → person | Author, creator, artist, or filmmaker. |
| `publisher` | creativework → organization | Publisher, platform, studio, or distributor. |
| `about` | creativework → person | Content centered on a specific person. |
| `about` | creativework → organization | Content centered on a company, institution, or group. |
| `about` | creativework → place | Content centered on a location (travel guide, history). |
| `about` | creativework → event | Content centered on an event (documentary, article). |
| `itemReviewed` | review → creativework | The book, movie, article, or other work this review evaluates. |
| `itemReviewed` | review → organization | The business, restaurant, or institution this review evaluates. |
| `itemReviewed` | review → place | The venue, park, or location this review evaluates. |
| `itemReviewed` | review → event | The event this review evaluates. |
| `itemReviewed` | review → product | The tool, device, or product this review evaluates. |
| `owns` | person → product | Item owned by the person (electronics, vehicles, etc.). |

Note: the `about`, `author`, and `publisher` rows are declared on
`creativework` as **source**, so all five concrete subtypes satisfy them via
`parent_type` (D6). No enumeration needed on that side.

### Software-Org Edges (12, new)

| Edge | Source → Target | Description |
|------|----------------|------------|
| `dependsOn` | software_application → service | This software application depends on this service. |
| `specifies` | design_spec → software_application | Spec is about this software application. |
| `specifies` | design_spec → service | Spec is about this service. |
| `documents` | procedure → software_application | Procedure applies to this software application. |
| `documents` | procedure → service | Procedure applies to this service. |
| `handoffFor` | handoff → software_application | Handoff is for this software application. |
| `handoffFor` | handoff → service | Handoff is for this service. |
| `supersedes` | creativework → creativework | This document replaces an older one. |
| `hasRole` | person → role | Person fills this role. |
| `operates` | role → software_application | Role operates this software application. |
| `provides` | organization → service | Organization provides this service. |
| `maintains` | person → software_application | Person maintains this software application. |

---

## Package Structure

```text
packages/schema-software-org/
├── package.json          # @equationalapplications/schema-software-org
├── tsconfig.json         # extends monorepo root
├── tsup.config.ts        # mirrors packages/schema-org
├── vitest.config.ts      # mirrors packages/schema-org
├── src/
│   └── index.ts          # exports schemaSoftwareOrgManifest
├── __tests__/
│   ├── manifest.test.ts  # validation + warm-agent parity (D2)
│   └── __snapshots__/    # content drift guard for the 8 new rows (Test 10)
└── README.md             # type catalog (nodes/edges), usage, conventions
```

`package.json` mirrors `packages/schema-org/package.json`: `main`/`module`/
`types` pointing into `dist`, the `exports` map, `files: ["dist", "LICENSE",
"README.md"]`, `description` and `keywords` for npm search, `license`,
`bugs`, `homepage`, scripts `build` (tsup) / `dev` / `typecheck` / `test` /
`test:watch`, `engines: { "node": ">=20" }`,
`publishConfig.access: "public"`, and
`repository.directory: "packages/schema-software-org"`.

- **dependencies:** `@equationalapplications/core-llm-wiki` (workspace:\*)
- **devDependencies:** `@equationalapplications/schema-org-llm-wiki`
  (workspace:\*, for the D2 parity test only), `tsup`, `typescript`, `vitest`

---

## Monorepo Integration

Creating the package directory is not enough to ship it. Two files carry
**hardcoded package lists** that a `packages/*` glob does not cover, and a new
package is invisible to the release pipeline until it appears in both. Missing
either fails silently — no error, just a package that never reaches npm.

1. **`.releaserc.json`** — the `@semantic-release/exec` `prepareCmd` inlines
   the list `['core','react','expo','prisma-outbox','core-llm-tools','okf',
   'schema-org']`. Add `schema-software-org`. This is the step that writes
   `nextRelease.version` into each `packages/*/package.json`; omitted, the new
   package's version is never bumped and it publishes stale or not at all.

2. **`.github/workflows/release.yml`** — the `publish_if_needed` block
   (currently seven explicit lines). Add:

   ```bash
   publish_if_needed "./packages/schema-software-org/package.json" \
     pnpm --filter "./packages/schema-software-org" publish --no-git-checks --access public
   ```

   Order matters — the block is commented "Publish in dependency order so each
   package exists on npm before dependents are published", and `pnpm publish`
   replaces `workspace:*` with the real version at pack time. This package
   depends on `core`, so its line goes **after** the `core` line. Placing it
   next to `schema-org` satisfies that.

3. **npm trusted publishing** — configure it for the new package name on
   npmjs.com before the first release. Publishing is OIDC-based here; an
   unconfigured package name fails at publish time, after the tag exists.

4. **Root `README.md`** — two hand-maintained lists: the npm badge row (~line
   12) and the package table (~line 239). Neither is generated.

No change is needed to `pnpm-workspace.yaml` (`packages/*` already globs it),
the root `build`/`typecheck`/`test` scripts (`pnpm -r`), or `tsconfig.json`
(no project references, no `paths`).

### `src/index.ts`

```ts
import type { OntologyManifest } from '@equationalapplications/core-llm-wiki';

export const schemaSoftwareOrgManifest: OntologyManifest = {
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
    // D8: intentional divergence from the warm-agent original — the upstream
    // row claims "and software", which pulls the org's own repositories here.
    { type: 'product', description: 'A physical item, software tool, or device owned or under consideration. Covers electronics, vehicles, and household items. For software the organization builds, ships, or maintains, use software_application instead; for a hosted capability it consumes or operates, use service.' },
    // Software-org base types (no parent_type, no children — D5)
    { type: 'software_application', description: 'Software the organization itself builds, ships, or maintains — its own portfolio codebase. Not third-party software the organization merely uses (that is product), and not a running hosted capability (that is service). Expected frontmatter properties: repo_url, version, install_path, status (active/deprecated/in_dev).' },
    { type: 'service', description: "A running hosted capability the organization consumes or operates, vendor-run or self-run — databases, APIs, CI, auth, monitoring. Distinct from software_application (the codebase the organization ships) and product (third-party tools it owns). The organization's own backend is a software_application as source and a service as a deployed dependency. Expected frontmatter properties: provider, dashboard_url, status, tier (critical/important/optional)." },
    { type: 'role', description: 'A functional role a person fills within the organization. Expected frontmatter properties: role_name, scope, capabilities.' },
    // Software-org concrete types (one level under creativework)
    { type: 'design_spec', parent_type: 'creativework', description: 'A technical or product design specification. Expected frontmatter properties: status (draft/approved/implemented/superseded), spec_for (software_application or service slug), branch.' },
    { type: 'handoff', parent_type: 'creativework', description: 'An operational handoff or session transition document. Expected frontmatter properties: session_id, outcome (pending/complete/blocked), open_items.' },
    { type: 'procedure', parent_type: 'creativework', description: 'A checklist, workflow, or how-to document. Expected frontmatter properties: trigger (when to use it), last_reviewed, applies_to (software_application or service slug).' },
    { type: 'session_recap', parent_type: 'creativework', description: 'A dated recap of one working session. Use only for session records — ordinary facts are not memories. Expected frontmatter properties: session_date, key_decisions (comma-separated list).' },
    { type: 'reference_doc', parent_type: 'creativework', description: 'A product doc, service description, or architecture reference. Expected frontmatter properties: source_url, application (software_application slug).' },
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
    // Software-org edges (12, new)
    { type: 'dependsOn', source_type: 'software_application', target_type: 'service', description: 'This software application depends on this service.' },
    { type: 'specifies', source_type: 'design_spec', target_type: 'software_application', description: 'Spec is about this software application.' },
    { type: 'specifies', source_type: 'design_spec', target_type: 'service', description: 'Spec is about this service.' },
    { type: 'documents', source_type: 'procedure', target_type: 'software_application', description: 'Procedure applies to this software application.' },
    { type: 'documents', source_type: 'procedure', target_type: 'service', description: 'Procedure applies to this service.' },
    { type: 'handoffFor', source_type: 'handoff', target_type: 'software_application', description: 'Handoff is for this software application.' },
    { type: 'handoffFor', source_type: 'handoff', target_type: 'service', description: 'Handoff is for this service.' },
    // One row covers every creativework subtype on both sides: matching is
    // parent-aware on source and target alike, exact-first (D6).
    { type: 'supersedes', source_type: 'creativework', target_type: 'creativework', description: 'This document replaces an older one.' },
    { type: 'hasRole', source_type: 'person', target_type: 'role', description: 'Person fills this role.' },
    { type: 'operates', source_type: 'role', target_type: 'software_application', description: 'Role operates this software application.' },
    { type: 'provides', source_type: 'organization', target_type: 'service', description: 'Organization provides this service.' },
    { type: 'maintains', source_type: 'person', target_type: 'software_application', description: 'Person maintains this software application.' },
  ],
};
```

### `README.md`

Sections, in order:

- Title + one-sentence description of what the package ships
- **Node Catalog** — every node type and its description, with the property
  list from each description
- **Edge Catalog** — every edge type, its `(source, target)`, and description
- **Property Conventions** — CodeMeta-shaped naming, status enums,
  no-inheritance note (D4)
- **Usage** — `import { schemaSoftwareOrgManifest } from
  '@equationalapplications/schema-software-org'` and a one-paragraph note on handing it
  to `WikiMemory`, either at construction via
  `config.ontology.seedManifests[entityId] = { manifest, mode }`
  (`OntologyConfig` in core's `types.ts`) or at runtime via
  `WikiMemory.setOntologyManifest(entityId, manifest, { mode })`. There is no
  `ontologyConfig.manifest` field — do not invent one.
- **Disambiguation** (D8) — three-way cross-reference among `product`,
  `software_application`, and `service`

---

## Property Conventions (CodeMeta-shaped)

### Naming
- snake_case (e.g. `repo_url`, `install_path`)
- Single-word keys where possible
- URL values for links (not display text)

### No property inheritance

Per D4, `parent_type` is a matching rule for edge matching. Core does not
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

`schema-software-org` is the superset: it copies the warm-agent rows verbatim
and adds the software-org types. A consumer importing `schema-software-org`
does NOT need `schema-org-llm-wiki` at runtime — it is a devDependency here
solely for the D2 parity test.

---

## Tests

> **Build order.** The D2 parity test imports `schemaOrgWarmAgentManifest` by
> package name, which resolves to `packages/schema-org/dist` — this repo has no
> tsconfig `paths` and no cross-package `src` imports. CI is fine (`test.yml`
> runs `pnpm run build` before `pnpm test`), but on a clean checkout a bare
> `pnpm --filter schema-software-org test` fails on a missing `dist` rather
> than on anything real. Run `pnpm build` first.

> **Overlap with Test 1.** Tests 3, 4, and 5 re-assert invariants
> `validateManifest` already enforces — duplicate node slugs, duplicate edge
> triples, unresolvable parents, and 2-deep chains all throw in Test 1. They
> are kept because they name the specific invariants this manifest depends on
> and fail with a precise message instead of a generic throw, but they are
> documentation of core's guarantees, not independent coverage.

1. **Manifest validates** — `validateManifest(schemaSoftwareOrgManifest)` does not
   throw (requires the core release with `parent_type`).
2. **Counts are what the spec claims** — 17 node types, 40 edge types.
   The count alone is not enough: a dropped type is masked by any unique
   replacement, and warm-agent parity (Test 6) only covers the 9 upstream
   rows, so the 8 software-org additions are otherwise unguarded. Assert the
   exact
   slug set:

   ```ts
   it('ships exactly the 17 declared node types', () => {
     expect(new Set(schemaSoftwareOrgManifest.node_types.map(n => n.type))).toEqual(
       new Set([
         // 9 warm-agent (D2)
         'person', 'organization', 'place', 'event', 'project', 'action',
         'creativework', 'review', 'product',
         // 3 software-org base types (D5)
         'software_application', 'service', 'role',
         // 5 software-org creativework subtypes
         'design_spec', 'handoff', 'procedure', 'session_recap',
         'reference_doc',
       ]),
     );
   });
   ```
3. **No duplicate node slugs** across warm-agent + software-org types.
4. **Edge triples are unique** — polymorphic edges (`specifies`, `documents`,
   `handoffFor`, `supersedes`, `about`, `itemReviewed`, `location`,
   `organizer`) appear as distinct `(type, source, target)` rows.
5. **All `parent_type` references resolve** to a node in the same manifest,
   and no parent itself has a `parent_type` (one level — D5).
6. **Warm-agent parity (D2/D8)** — the 9 node rows and 28 edge rows copied
   from `schemaOrgWarmAgentManifest` deep-equal their originals, except rows
   named in an explicit override allowlist. This is the drift guard; it fails
   if anyone abridges a description. Shape:

   ```ts
   /**
    * Intentional divergences from the warm-agent original. Every entry needs
    * a reason. Anything not listed here must match byte-for-byte (D2).
    */
   const INTENTIONAL_NODE_OVERRIDES: Record<string, string> = {
     // D8: upstream says "Covers electronics, vehicles, household items, and
     // software", which pulls the organization's own repositories into
     // `product`. This row drops that clause and hands off to
     // software_application/service.
     product:
       'A physical item, software tool, or device owned or under consideration. '
       + 'Covers electronics, vehicles, and household items. For software the '
       + 'organization builds, ships, or maintains, use software_application '
       + 'instead; for a hosted capability it consumes or operates, use service.',
   };

   describe('warm-agent parity (D2)', () => {
     const manifestByType = new Map(schemaSoftwareOrgManifest.node_types.map(n => [n.type, n]));

     for (const original of schemaOrgWarmAgentManifest.node_types) {
       it(`node "${original.type}" tracks the warm-agent original`, () => {
         const copied = manifestByType.get(original.type);
         expect(copied).toBeDefined();
         const override = INTENTIONAL_NODE_OVERRIDES[original.type];
         if (override) {
           // A stale exception that no longer diverges would silently mask
           // real drift, so assert the divergence is still real.
           expect(original.description).not.toBe(override);
           expect(copied!.description).toBe(override);
         } else {
           expect(copied).toEqual(original);
         }
         expect(copied!.parent_type).toBeUndefined();
       });
     }

     it('every override still names an upstream type', () => {
       const upstream = new Set(schemaOrgWarmAgentManifest.node_types.map(n => n.type));
       for (const slug of Object.keys(INTENTIONAL_NODE_OVERRIDES)) {
         expect(upstream.has(slug)).toBe(true);
       }
     });

     it('warm-agent edges are copied with no exceptions', () => {
       // Order is part of the contract: `copied` preserves this manifest's order,
       // so this fails on any reshuffle of the warm block, not just on
       // description drift. Keep the 28 warm rows first and in upstream order.
       const triples = new Set(schemaOrgWarmAgentManifest.edge_types.map(
         e => `${e.type}|${e.source_type}|${e.target_type}`));
       const copied = schemaSoftwareOrgManifest.edge_types.filter(
         e => triples.has(`${e.type}|${e.source_type}|${e.target_type}`));
       expect(copied).toEqual(schemaOrgWarmAgentManifest.edge_types);
     });
   });
   ```
7. **Type descriptions contain expected property names** — `repo_url`,
   `spec_for`, `session_id`, `dashboard_url`, `role_name`, `source_url`,
   `trigger`, `session_date`.
8. **`supersedes` stays declared on the parent** — the single
   `creativework → creativework` row is what lets core's exact-first symmetric
   matching cover a `design_spec → design_spec` pair (shape guard for D6).
   This asserts the manifest's declared shape, not the resolution itself.
   `typeSatisfies` is exported from `core/src/utils/ontology.ts` but not
   re-exported from core's index (which exposes only `validateManifest` from
   that module), so a *unit*-level matching assertion inside this package would
   require a core change — which D3 rules out. An *integration*-level assertion
   is available and needs no core change: `packages/integration` already drives
   a manifest end-to-end through `WikiMemory` with a scripted LLM in
   `__tests__/ontologySchemaOrg.test.ts`, and already takes
   `schema-org-llm-wiki` as a dependency. A `design_spec → design_spec`
   `supersedes` round-trip belongs there if we want the combination proven.
   Core's own `ontologyParentInheritance.test.ts` covers the mechanism, so
   this is optional; the declared row below is what this spec owns:

   ```ts
   it('supersedes stays declared on the parent (D6 shape guard)', () => {
     // exact-first symmetric matching in core means this single parent row
     // covers a design_spec -> design_spec relationship.
     const edge = schemaSoftwareOrgManifest.edge_types.find(e => e.type === 'supersedes');
     expect(edge?.source_type).toBe('creativework');
     expect(edge?.target_type).toBe('creativework');
   });
   ```
9. **Disambiguation text is present (D8)** — `product`'s description does not
   end in "and software"; all three (`product`, `software_application`,
   `service`) name each other in their descriptions. Cheap guard against
   someone "restoring" the upstream row.
10. **Snapshot of the whole manifest (drift guard for the 8 new rows)** —
    D2's parity test protects only the 9 copied rows, and Tests 2, 7, and 9
    check the new rows for *slug presence*, *property substrings*, and *mutual
    naming* respectively. None of that stops someone halving
    `software_application`'s or `service`'s description — the longest and most
    load-bearing text in the manifest, where all of D8's disambiguation lives.
    That is precisely the failure D2 exists to prevent, left open on the rows
    that have no upstream to compare against. `packages/schema-org` already
    solves this the same way (`__tests__/manifest.test.ts`, "matches snapshot
    (content drift guard)"), so follow the established convention:

    ```ts
    it('matches snapshot (content drift guard)', () => {
      expect(schemaSoftwareOrgManifest).toMatchSnapshot();
    });
    ```

    An intentional wording change then shows up as a reviewable snapshot diff
    rather than passing silently.

---

## What This Does NOT Include

- No property schema types — properties are frontmatter conventions, not
  `OntologyManifest` fields
- No property inheritance (D4) — core has none, and this spec does not ask
  for it
- No runtime logic — purely a data package
- No runtime dependency on `schema-org-llm-wiki` (devDependency only, for the
  parity test)
- No profile-specific classification rules injected into core prompts —
  disambiguation lives in the manifest descriptions (D8)
- No dependency on CodeMeta (inspired by, not imported from)
- No narrowing of warm-agent polymorphic edges against the new concrete
  subtypes
  — verbatim copy (D2) means `author`, `publisher`, `about`, `itemReviewed`
  declared on `creativework` now reach every `creativework` child
  (`design_spec`, `session_recap`, `handoff`, `procedure`, `reference_doc`).
  Narrowing would force a divergence from upstream; deferred until
  classification evidence shows it is actually misclassifying.

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
- **Rev 3 (2026-08-30)** — resolved the `software_application` / `product`
  overlap structurally instead of by convention (D8). Rev 2 documented it as a
  prompt-level understanding, which the model never reads: fed both rows, it
  would classify EA repositories as `product` on the word "software" alone.
  `product` now drops upstream's "and software" and hands off explicitly, and
  `software_application` / `service` name each other back so the
  disambiguation is mutual. `service` was retitled to a running hosted
  capability (vendor- or EA-run) to settle the same ambiguity for EA's own
  backends, which are a `software_application` as source and a `service` as a
  deployed dependency. D2 gains an override allowlist — reason required, and
  the test asserts each entry still diverges so a stale exception cannot mask
  real drift. `product` is the only sanctioned entry.
- **Rev 4 (2026-08-30)** — PR #111 review: rev 2 restored the warm-agent rows
  verbatim in the manifest code block but left 10 of the 28 edge rows
  abbreviated in the catalog *table*, so the document still defined two
  different values for one row — the exact defect rev 2 set out to fix. Table
  rows are now verbatim, and D2 states that the tables are held to the same
  standard as the manifest.
- **Rev 5 (2026-08-30)** — the dependency spec (#110 rev 4) made type matching
  symmetric: targets are now parent-aware too, resolved exact-first. Rev 2's
  six enumerated `supersedes` rows collapse back to the single
  `creativework → creativework` row they were expanded from, and the accepted
  `itemReviewed → creativework` limitation is gone — it reaches every subtype
  natively. Edge count 45 → 40. D6 rewritten from "enumerate the pairs you
  need" to "declare on the parent".
- **Rev 6 (2026-08-30)** — review pass. Updated the `service` description to
  name `product` and `software_application` mutually — fixing the
  table/code-block divergence D2 was supposed to prevent and the false claim
  in rev 5's Test 9 about which descriptions name which. Renamed `memory` →
  `session_recap` to avoid namespace collision with `WikiMemory` in core.
  Disambiguated `design_spec.spec_for`, `procedure.applies_to`, and
  `reference_doc.product` — all refer to `software_application` (or
  `service`) slugs in EA, not the `product` ontology type. Aligned the
  `operates` edge description with its verb. Pinned the
  dependency reference to the parent spec's implemented (rev 8) revision.
  Expanded the `package.json` outline (`description`, `keywords`, `license`,
  `bugs`, `homepage`, `engines`) and outlined the `README.md` sections.
  Added Test 8's implementation snippet. Documented the polymorphic-edge
  expansion under "What This Does NOT Include". Corrected the stale
  `// EA executive edges (17, new)` comment to `(12, new)`.
- **Rev 7 (2026-08-30)** — review pass, no design changes. The dependency
  header was stale: core 6.1.0 shipped that day and *is* the `parent_type`
  release, so the "pin once it lands" instruction both named a release that
  had already arrived and contradicted the `workspace:*` dependency two
  sections down. Header now states `>= 6.1.0` and explains that
  `workspace:*` resolves to it. D4 still said `parent_type` affects "edge
  source matching only" — pre-rev-5 wording that rev 5's symmetric D6
  contradicted two sections later; corrected in D4 and in Property
  Conventions. Five of the twelve EA edge descriptions (`dependsOn`,
  `specifies`, `documents`, `handoffFor`, `maintains`) still called their
  `software_application` endpoint "this product", which per D3 ships that
  word into the classification prompt and undercuts the entire point of D8;
  rev 6 fixed `operates` and missed these. `reference_doc.product` renamed to
  `reference_doc.application` for the same reason — a frontmatter key named
  `product` holding a `software_application` slug reintroduced the collision
  D8 removes. The README outline cited a nonexistent `ontologyConfig.manifest`
  API; the real surfaces are `config.ontology.seedManifests[entityId]` and
  `WikiMemory.setOntologyManifest`. Test 8's prose claimed it exercised
  resolution when the snippet only asserts the declared row — retitled as a
  shape guard, with a note that `typeSatisfies` is not exported from core so
  a DB-free matching assertion would require a core change D3 rules out.
  Added a comment to the edge parity test recording that row order is part of
  the contract.
- **Rev 8 (2026-08-30)** — CodeRabbit review on PR. Two of its three findings
  were already fixed at HEAD: the `// EA executive edges (17, new)` comment
  was corrected to `(12, new)` in rev 6, and D4's "source matching only"
  wording in rev 7 — the bot reviewed the merge commit, two revisions behind.
  Its third finding stands: Test 2 asserted only a node *count*, so dropping
  a type and adding any other unique one passes, and Test 6's parity check
  covers only the 9 warm-agent rows, leaving the 8 EA additions unguarded.
  Test 2 now asserts exact set equality over all 17 slugs. (The bot's example
  named `memory`, renamed to `session_recap` in rev 6 — same staleness, but
  the gap it points at was real.) D4's wording also tidied to name both
  sides explicitly.
- **Rev 9 (2026-08-30)** — review pass against source; six findings, plus a
  rename. **Renamed** `@equationalapplications/schema-ea` →
  `@equationalapplications/schema-software-org` (export `schemaEaManifest` →
  `schemaSoftwareOrgManifest`, directory `packages/schema-software-org`) and
  **generalized the text to match the name**: the four rows that hard-coded
  "EA" (`product`'s D8 override, `software_application`, `service`, `role`)
  now say "the organization", so the manifest is adoptable unmodified by any
  software org rather than promising generality its contents did not deliver.
  Tessera is recorded as the first consumer, not the audience limit. The
  concatenated `INTENTIONAL_NODE_OVERRIDES.product` string in Test 6 was
  updated in lockstep — it must equal the manifest description byte-for-byte
  or the parity test fails on its own allowlist. Note the spec *filename*
  keeps its `schema-ea` slug: it is tied to the branch and PR history.
  **New `## Monorepo Integration` section** — the blocker. `.releaserc.json`'s
  `prepareCmd` and `release.yml`'s `publish_if_needed` block both carry
  hardcoded package lists that `packages/*` globs do not cover; a package
  absent from either never gets its version bumped or never publishes, with no
  error. Also records npm trusted publishing and the two hand-maintained root
  `README.md` lists, and states what needs no change (workspace glob, root
  scripts, tsconfig). **New Test 10** — a `toMatchSnapshot()` drift guard, the
  convention `packages/schema-org` already uses. D2's parity test covers only
  the 9 copied rows, so the 8 new ones — carrying the longest and most
  load-bearing descriptions, where D8's disambiguation lives — could be
  abridged with every existing test still green. That is the exact failure D2
  exists to prevent, left open on the rows with no upstream to compare
  against; rev 8 closed the slug gap CodeRabbit found and left this one.
  **Accepted cost recorded** in the Executive Summary: this manifest costs
  ~11.3 KB (~2.9k tokens) per extraction prompt against `schema-org-llm-wiki`'s
  ~6.7 KB (~1.7k), a ~68% permanent increase per ingest call — the measured
  price of D3 plus D2, previously undocumented. **Test 8 corrected**: it
  claimed a matching assertion needs a core change, true only at unit level.
  `packages/integration` already drives a manifest end-to-end through
  `WikiMemory` and depends on `schema-org-llm-wiki`, so an integration-level
  `design_spec → design_spec` round-trip is available with no core change;
  noted as optional since core's `ontologyParentInheritance.test.ts` covers the
  mechanism. Added a **Tests preamble** noting that Tests 3/4/5 are structurally
  guaranteed by `validateManifest` (kept for precise failure messages, not
  independent coverage), and that `pnpm build` must precede `pnpm test` on a
  clean checkout because the parity test resolves `schema-org` through `dist`.
  Verified unchanged: all 37 warm-agent rows still byte-identical to
  `packages/schema-org/src/index.ts` except `product` (D8), all 57 catalog-table
  rows still equal to the manifest block, counts still 17/40.
