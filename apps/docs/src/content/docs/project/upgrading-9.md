---
title: Upgrading to 9.0.0
description: What 9.0.0 removes, how existing data is affected, and how to adopt the statement kinds.
---

9.0.0 removes one config option and three entries from the software-organization manifest. All
packages release in lockstep, so every package moves to 9.0.0.

## What is removed

**`prompts.librarianSystemPrompt`.** The value is ignored, and the engine logs one removal notice.
Migrate to `prompts.guidance`, which works under both librarian strategies and keeps the JSON
contract intact. See [Customize prompts](/expo-llm-wiki/guides/prompts/#host-guidance).

**`handoff`, `session_recap` and `handoffFor`.** These are removed from the
`schema-software-org` manifest. Nothing is dropped from your data: existing rows keep their stored
`okf_type`. The difference is in what writes accept:

- Strict-mode write paths (`remember()`, `upsertGraph()`) reject the removed types.
- `ingestDocument` and the librarian paths store such facts untyped.

## Adopt the new manifest

Seeded manifests do **not** re-seed. An entity that already has a manifest keeps it. Call
`setOntologyManifest` to adopt the new 21-type, 42-edge manifest:

```ts
import { schemaSoftwareOrgManifest } from '@equationalapplications/schema-software-org';

await wiki.setOntologyManifest(entityId, schemaSoftwareOrgManifest);
```

## What is new

The manifest gains four statement kinds (`rule`, `decision`, `lesson`, `trap`), defined by
content, an `area` type for a named part of an application, and the `partOf` and `about` edges that
attach them. Counts go from 17 node types and 40 edges to 21 and 42. Note: edge attachment is
prompt-steered; the first measured run recorded 0 of 28 persisted `about` edges (issue #381), so
treat attachment as unproven. See
[Ontologies](/expo-llm-wiki/packages/ontologies/#statements-and-areas) and the
[schema package README](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-software-org/README.md)
for the labels.

## Frozen and legacy pages

The frozen contract mirror and the legacy pages still name `handoff` and `session_recap`. That is
expected: they describe earlier releases and are not updated.
