# @equationalapplications/schema-org-llm-wiki

Curated [schema.org](https://schema.org/) warm-agent ontology manifest for
[LLM Wiki Memory](https://github.com/equationalapplications/expo-llm-wiki):
**9 node types, 28 edges**, all schema.org-standard. Data-only — no runtime code.

## Why curated?

Full schema.org has ~800 types and ~1,400 properties. Injecting that into every
librarian/ingest prompt would blow token budgets and collapse LLM classification
accuracy. This manifest selects the high-value warm-agent subset (~2 KB serialized,
9-way classification) while keeping every type and property standard, so stored
facts and edges map 1:1 onto schema.org for future JSON-LD export.

## Requirements

Requires `@equationalapplications/core-llm-wiki` at the same release or newer —
this manifest uses polymorphic edge rows (one property name with several
source/target types), which core validates by the `(type, source_type, target_type)`
triple.

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
