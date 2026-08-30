# @equationalapplications/schema-software-org

A custom minimal ontology manifest for an executive agent operating on behalf of a software organization — 17 node types, 40 edges, a superset of the warm-agent manifest in which the warm-agent rows are copied verbatim except for one intentional override of `product` (which delegates to `software_application` / `service`), data-only with no runtime code.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fschema-software-org?label=schema-software-org)](https://www.npmjs.com/package/@equationalapplications/schema-software-org) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fschema-software-org?label=downloads)](https://www.npmjs.com/package/@equationalapplications/schema-software-org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-software-org/LICENSE)

**[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

> Ontology manifest for [LLM Wiki Memory](https://github.com/equationalapplications/expo-llm-wiki).

## Node Catalog

| Type | Parent | Description |
|------|--------|-------------|
| `person` | — | A person—friend, family member, colleague, or public figure. Use this for any individual in the user's social, professional, or knowledge network. |
| `organization` | — | A company, nonprofit, club, sports team, or institution. Covers businesses, schools, local shops, and communities. |
| `place` | — | A geographic location, address, landmark, or venue. Use for cities, buildings, parks, restaurants, or any physical or conceptual location. |
| `event` | — | A scheduled or past gathering, meeting, conference, concert, or celebration. Links attendees and organizers to the event. |
| `project` | — | A multi-step initiative, goal, or endeavor. Use for personal projects, learning goals, business initiatives, or long-term objectives. |
| `action` | — | An individual task, chore, step, or completed action. Links to a parent Project and assigns responsibility to a Person. |
| `creativework` | — | A book, movie, article, song, recipe, blog post, or other creative content. Captures media the user consumes, learns from, or creates. |
| `review` | — | A personal review, opinion, or evaluation. The implicit subject is always the owning character—use to review a book, restaurant, place, product, or experience. Rating values stay inside the fact content. |
| `product` | — | A physical item, software tool, or device owned or under consideration. Covers electronics, vehicles, and household items. For software the organization builds, ships, or maintains, use software_application instead; for a hosted capability it consumes or operates, use service. |
| `software_application` | — | Software the organization itself builds, ships, or maintains — its own portfolio codebase. Not third-party software the organization merely uses (that is product), and not a running hosted capability (that is service). Expected frontmatter properties: repo_url, version, install_path, status (active/deprecated/in_dev). |
| `service` | — | A running hosted capability the organization consumes or operates, vendor-run or self-run — databases, APIs, CI, auth, monitoring. Distinct from software_application (the codebase the organization ships) and product (third-party tools it owns). The organization's own backend is a software_application as source and a service as a deployed dependency. Expected frontmatter properties: provider, dashboard_url, status, tier (critical/important/optional). |
| `role` | — | A functional role a person fills within the organization. Expected frontmatter properties: role_name, scope, capabilities. |
| `design_spec` | `creativework` | A technical or product design specification. Expected frontmatter properties: status (draft/approved/implemented/superseded), spec_for (software_application or service slug), branch. |
| `handoff` | `creativework` | An operational handoff or session transition document. Expected frontmatter properties: session_id, outcome (pending/complete/blocked), open_items. |
| `procedure` | `creativework` | A checklist, workflow, or how-to document. Expected frontmatter properties: trigger (when to use it), last_reviewed, applies_to (software_application or service slug). |
| `session_recap` | `creativework` | A dated recap of one working session. Use only for session records — ordinary facts are not memories. Expected frontmatter properties: session_date, key_decisions (comma-separated list). |
| `reference_doc` | `creativework` | A product doc, service description, or architecture reference. Expected frontmatter properties: source_url, application (software_application slug). |

## Edge Catalog

| Edge | Source → Target | Description |
|------|-----------------|-------------|
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

## Property Conventions

Property names follow [CodeMeta](https://codemeta.github.io/) shape: `snake_case`, single-word keys where possible, URL values for links. Status enums are written inline in parentheses — for example `status (active/deprecated/in_dev)` — rather than enumerated as separate properties.

`parent_type` is an **edge-matching rule only** (D4): it tells the runtime which parent row covers a subtype for edge validation, it does **not** inherit properties. Every subtype lists its own complete set of frontmatter properties, including any property the parent also lists.

Common schema.org fields (`name`, `url`, `dateCreated`, `author`, and the rest of the standard vocabulary) are deliberately **unlisted** in the property expectations. They come from the model's existing schema.org knowledge, not from this manifest, and that is not inheritance — the LLM supplies them from pretraining regardless of whether the manifest names them. The properties here are only the ones this manifest wants to elicit as structured frontmatter.

## Usage

Pass the manifest into `core-llm-wiki`'s `createWiki` via `config.ontology.seedManifests`:

```ts
import { createWiki } from '@equationalapplications/core-llm-wiki';
import { schemaSoftwareOrgManifest } from '@equationalapplications/schema-software-org';

const wiki = createWiki(db, {
  llmProvider,
  config: {
    ontology: {
      mode: 'strict',
      seedManifests: {
        [entityId]: { mode: 'strict', manifest: schemaSoftwareOrgManifest },
      },
    },
  },
});
```

Or seed an existing entity directly at runtime:

```ts
await wiki.setOntologyManifest(entityId, schemaSoftwareOrgManifest, { mode: 'strict' });
```

## Disambiguation

Three node types overlap in everyday language and are kept distinct on purpose (D8):

- **`product`** — a thing the organization **owns or evaluates**. Owned electronics, vehicles, household items, third-party software tools the team pays for. Reviews target this type.
- **`software_application`** — a **codebase** the organization **builds, ships, or maintains**. Its own portfolio repos. Has properties like `repo_url`, `version`, `install_path`.
- **`service`** — a **running hosted capability** something depends on, vendor-run or self-run. Databases, APIs, CI, auth, monitoring. Has properties like `provider`, `dashboard_url`, `tier`.

The organization's own backend illustrates the split: it is a `software_application` as source (the codebase being written) and a `service` as deployed dependency (the running thing other systems call into). The `dependsOn (software_application → service)` edge encodes exactly that relationship — a `software_application` declaring its runtime dependencies on one or more `service` nodes.

## Requirements

Requires `@equationalapplications/core-llm-wiki` **>= 6.1.0** — that is the release that shipped `OntologyNodeType.parent_type`, which the five `creativework` subtypes rely on. This manifest will validate against 6.0.1, but will silently fail at ingest edge matching because 6.0.1 ignores the `parent_type` field.

`@equationalapplications/schema-org-llm-wiki` is **not** a runtime dependency. This package is a verbatim superset of the warm-agent manifest except for one intentional override of `product` (which delegates to `software_application` / `service`), and stands alone — there is no need to install `schema-org-llm-wiki` to use `schema-software-org`.

## Monorepo Ecosystem

| Package | Purpose |
| ----- | ----- |
| [**@equationalapplications/schema-software-org**](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-software-org/README.md) | Software-organization executive ontology manifest — 17 node types, 40 edges, warm-agent superset, data-only |
| [@equationalapplications/core-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [@equationalapplications/expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [@equationalapplications/react-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
| [@equationalapplications/prisma-outbox](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/prisma-outbox/README.md) | Sync SQLite outbox events to Prisma |
| [@equationalapplications/core-llm-tools](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/README.md) | Gemini tool schemas and capability injector |
| [@equationalapplications/core-okf](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/okf/README.md) | Zero-dependency Open Knowledge Format (OKF) v0.1 + v0.2 primitives — parse and produce interoperable knowledge bundles. |
| [@equationalapplications/schema-org-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-org/README.md) | Curated schema.org warm-agent ontology manifest |

## License

MIT