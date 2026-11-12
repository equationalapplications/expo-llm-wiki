---
title: Ontology packages
description: Ready-made, data-only ontology manifests — schema.org warm-agent and software-organization.
sidebar:
  order: 6
---

Both packages export a single manifest object and contain no runtime code. Use one with
`seedManifests` or `setOntologyManifest`:

```ts
config: {
  ontology: {
    mode: 'strict',
    seedManifests: { [entityId]: { mode: 'strict', manifest: schemaOrgWarmAgentManifest } },
  },
}
// or at runtime:
await wiki.setOntologyManifest(entityId, schemaOrgWarmAgentManifest, { mode: 'strict' });
```

## schema.org warm-agent

`@equationalapplications/schema-org-llm-wiki` · [npm](https://www.npmjs.com/package/@equationalapplications/schema-org-llm-wiki) · [source](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/schema-org)

```bash
npm install @equationalapplications/schema-org-llm-wiki
```

```ts
import { schemaOrgWarmAgentManifest } from '@equationalapplications/schema-org-llm-wiki';
```

A curated subset of schema.org covering personal and professional knowledge: **9 node types and
28 edge rows** (19 property names). It's about 2 KB serialized, compared with about 50 KB for
the full catalog, so prompts stay small. Every name is standard
schema.org, which keeps future JSON-LD export straightforward.

| Node types | |
|---|---|
| `person`, `organization`, `place`, `event`, `project` | People, groups, locations, gatherings, initiatives |
| `action`, `creativework`, `review`, `product` | Tasks, media, opinions, owned items |

Edges include `knows`, `spouse`, `parent`, `worksFor`, `memberOf`, `homeLocation`,
`workLocation`, `location`, `containedInPlace`, `subOrganization`, `object`, `agent`,
`attendee`, `organizer`, `author`, `publisher`, `about`, `itemReviewed`, and `owns`.
Polymorphic properties such as `about` appear once per source and target pair.

## Software organization

`@equationalapplications/schema-software-org` · [npm](https://www.npmjs.com/package/@equationalapplications/schema-software-org) · [source](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/schema-software-org)

```bash
npm install @equationalapplications/schema-software-org
```

```ts
import { schemaSoftwareOrgManifest } from '@equationalapplications/schema-software-org';
```

A superset of warm-agent for an **executive agent working for a software company**: **17 node
types and 40 edges**. It adds:

| Type | Parent | Meaning |
|---|---|---|
| `software_application` | — | A codebase the org builds, ships, or maintains |
| `service` | — | A running hosted capability (database, API, CI, auth…) |
| `role` | — | A function a person fills |
| `design_spec`, `handoff`, `procedure`, `session_recap`, `reference_doc` | `creativework` | Operational documents |

It also adds edges such as `dependsOn` (software_application → service), `specifies`,
`documents`, `handoffFor`, `supersedes`, `hasRole`, `operates`, `provides`, and `maintains`.

:::tip[product vs software_application vs service]
**product** is something the org owns or evaluates. **software_application** is a codebase the
org ships. **service** is a running thing that something depends on. The org's own backend is
both a `software_application` (the source code) and a `service` (the deployment).
:::
