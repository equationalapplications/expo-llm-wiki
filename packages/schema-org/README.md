# @equationalapplications/schema-org-llm-wiki

Curated [schema.org](https://schema.org/) warm-agent ontology manifest for hybrid LLM memory. Seeds a knowledge graph with 9 standard node types and 28 polymorphic edges — token-efficient, JSON-LD-ready, data-only with no runtime code.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fschema-org-llm-wiki?label=schema-org)](https://www.npmjs.com/package/@equationalapplications/schema-org-llm-wiki) [![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fschema-org-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/schema-org-llm-wiki)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-org/LICENSE)

**[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

> Ontology manifest for [LLM Wiki Memory](https://github.com/equationalapplications/expo-llm-wiki), inspired by [Andrej Karpathy's LLM Wiki memory spec](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Why curated?

Full schema.org has ~800 types and ~1,400 properties. Injecting that into every
librarian/ingest prompt would blow token budgets and collapse LLM classification
accuracy. This manifest selects the high-value warm-agent subset (~2 KB serialized,
9-way classification) while keeping every type and property standard, so stored
facts and edges map 1:1 onto schema.org for future JSON-LD export.

## Why this is the GraphRAG ontology

This manifest is designed as the canonical taxonomy bundle for warm-agent GraphRAG: the 9 node types and 28 polymorphic edges cover the people, places, organizations, projects, events, and creative works that dominate personal and professional knowledge graphs. Pair it with `core-llm-wiki`'s `traverseGraph()` and you get a SQL-only GraphRAG stack with no Neo4j.

### Why a curated ontology prevents hallucination in edge extraction

The librarian and ingest LLM passes that write `llm_wiki_edges` only see this manifest's node types and edge properties in their prompt context. Without that constraint, an unconstrained LLM will invent edge types and node types on every call — producing a noisy graph where `WITH RECURSIVE` walks return orphaned nodes and arbitrary relationships.

With the manifest:
- **Every edge has a valid `(type, source_type, target_type)` triple** — the manifest validates edge structure and reduces invalid relationships.
- **Polymorphic edges** (`knows`, `about`, `itemReviewed`, `object`, `agent`) cover the cases where a single property name applies to many source/target type combinations.
- **Token budget stays small** — ~2 KB serialized, vs ~50 KB for the full schema.org catalog. Edge classification accuracy stays high.

### Use it with `core-llm-wiki` for GraphRAG

```ts
import { createWiki } from '@equationalapplications/core-llm-wiki';
import { schemaOrgWarmAgentManifest } from '@equationalapplications/schema-org-llm-wiki';

const wiki = createWiki(db, {
  llmProvider,
  config: {
    ontology: {
      mode: 'strict',
      seedManifests: {
        [entityId]: { mode: 'strict', manifest: schemaOrgWarmAgentManifest },
      },
    },
  },
});

// After ingestDocument / runLibrarian populate edges:
const graph = await wiki.traverseGraph(entityId, { sourceId, maxDepth: 2 });
```

## Requirements

Requires `@equationalapplications/core-llm-wiki` at the same release or newer —
this manifest uses polymorphic edge rows (one property name with several
source/target types), which core validates by the `(type, source_type, target_type)`
triple.

## Installation

```bash
npm install @equationalapplications/schema-org-llm-wiki
```

## Usage

```ts
import { createWiki } from '@equationalapplications/core-llm-wiki';
import { schemaOrgWarmAgentManifest } from '@equationalapplications/schema-org-llm-wiki';

const wiki = createWiki(db, {
  llmProvider,
  config: {
    ontology: {
      mode: 'strict',
      seedManifests: {
        [entityId]: { mode: 'strict', manifest: schemaOrgWarmAgentManifest },
      },
    },
  },
});
```

Or seed an existing entity directly:

```ts
await wiki.setOntologyManifest(entityId, schemaOrgWarmAgentManifest, { mode: 'strict' });
```

## Node types

| Type | schema.org | Covers |
|------|-----------|--------|
| `person` | [Person](https://schema.org/Person) | Friends, family, colleagues, public figures |
| `organization` | [Organization](https://schema.org/Organization) | Companies, schools, clubs, teams, institutions |
| `place` | [Place](https://schema.org/Place) | Cities, venues, landmarks, addresses |
| `event` | [Event](https://schema.org/Event) | Meetings, conferences, concerts, celebrations |
| `project` | [Project](https://schema.org/Project) | Multi-step initiatives and goals |
| `action` | [Action](https://schema.org/Action) | Individual tasks, chores, steps |
| `creativework` | [CreativeWork](https://schema.org/CreativeWork) | Books, movies, articles, songs, recipes |
| `review` | [Review](https://schema.org/Review) | Personal opinions and evaluations |
| `product` | [Product](https://schema.org/Product) | Owned items, devices, software |

## Edge properties (19 names, 28 rows)

All standard schema.org properties: `knows`, `spouse`, `parent`, `worksFor`,
`memberOf`, `homeLocation`, `workLocation`, `location` (×2), `containedInPlace`,
`subOrganization`, `object`, `agent`, `attendee`, `organizer` (×2), `author`,
`publisher`, `about` (×4), `itemReviewed` (×5), `owns`.

Polymorphic properties appear as multiple rows with distinct source/target
types, mirroring schema.org's own domain/range definitions — e.g. `about`
targets `person`, `organization`, `place`, and `event`.

## JSON-LD export notes

- Property names keep schema.org camelCase (`worksFor`, `itemReviewed`); core
  validation compares case-insensitively but stores the given casing, so names
  survive to storage and future JSON-LD export unchanged.
- Literal-valued properties (`birthDate`, `startTime`, `reviewRating` values, …)
  live inside fact content, not as edges. Only object-valued properties
  (pointing at other facts) are edges.

## Monorepo Ecosystem

| Package | Purpose |
| ----- | ----- |
| [**@equationalapplications/schema-org-llm-wiki**](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/schema-org/README.md) | Curated schema.org warm-agent ontology manifest |
| [@equationalapplications/core-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [@equationalapplications/expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [@equationalapplications/react-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
| [@equationalapplications/prisma-outbox](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/prisma-outbox/README.md) | Sync SQLite outbox events to Prisma |
| [@equationalapplications/core-llm-tools](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/README.md) | Gemini tool schemas and capability injector |
| [@equationalapplications/core-okf](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/okf/README.md) | Zero-dependency Open Knowledge Format (OKF) v0.1 primitives — parse and produce interoperable knowledge bundles. |

## License

MIT

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
