# @equationalapplications/expo-llm-wiki

Local-first LLM memory for Expo and React Native. Combines the core semantic search and extraction engine with [`expo-sqlite`](https://docs.expo.dev/versions/latest/sdk/sqlite/) and ready-to-use React hooks.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fexpo-llm-wiki?label=npm)](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki)
[![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fexpo-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/LICENSE)

**[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[Playground](https://equationalapplications.github.io/expo-llm-wiki/playground/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

> Inspired by [Andrej Karpathy's LLM Wiki memory spec](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Features

- **Expo-ready** — Pre-configured for React Native + Expo
- **Built on `expo-sqlite`** — Stable, well-supported SQLite driver
- **Semantic search** — Vector embeddings via `embed` function, with MiniSearch fallback
- **Retrieval tuning** — Per-call overrides for search behavior (pre-filter, hybrid blend, tier weights)
- **Multi-entity reads** — Search across multiple `entity_id` namespaces in one pass with `tierWeights`
- **Source provenance** — `WikiFact.source_type` distinguishes immutable document facts (`immutable_document`) from mutable derived/user facts. Immutable document content is protected from librarian/heal rewriting and only changed by `forget()` or re-ingest.
- **React hooks** — `WikiProvider`, `useMemoryRead`, and all other hooks are re-exported directly from `@equationalapplications/expo-llm-wiki`
- **Full-featured memory** — Facts, tasks, events, maintenance jobs (librarian, heal, reembed, prune)

## Installation

```bash
npx expo install expo-sqlite
npm install @equationalapplications/expo-llm-wiki
```

## Semantic Search

Enable vector-based retrieval by providing an `embed` function:

```typescript
import { createWiki } from '@equationalapplications/expo-llm-wiki';
import { openDatabaseSync } from 'expo-sqlite';

const db = openDatabaseSync('wiki.db');

const wiki = createWiki(db, {
  config: {
    // Optimize retrieval for large memory stores
    preFilterLimit: 50,    // Limit cosine scoring to top-50 keyword matches
    hybridWeight: 0.7,     // Blend semantic (0.7) + keyword (0.3)
  },
  llmProvider: {
    generateText: async ({ systemPrompt, userPrompt }) => {
      // Your LLM call — must return the model output as a string
      return 'Model output';
    },
    embed: async (text: string) => {
      // Your embedding service (e.g., OpenAI, Cohere)
      // Use an absolute URL — React Native / Expo apps do not have a browser
      // origin to resolve relative URLs against on device or simulator.
      const response = await fetch('https://your-api.example.com/api/embed', { 
        method: 'POST', 
        body: JSON.stringify({ text }) 
      });
      const { embedding } = await response.json();
      return embedding; // number[]
    },
  },
  onRetrievalFallback: (error) => {
    console.warn('Embedding unavailable, using keyword search:', error);
  },
});

await wiki.setup();

// Semantic query
const memory = await wiki.read('user-123', 'what activities should I do this weekend?');
// Matches facts like "Saturday hiking trip" even with no lexical overlap

// Per-call overrides
const fasterSearch = await wiki.read('user-123', 'activities', {
  maxResults: 5,
  preFilterLimit: 20,      // Tighter pre-filter for speed
  hybridWeight: 0.5,       // More keyword weight
});

// Multi-entity with tier weights
const multiMemory = await wiki.read(['tier_wisdom', 'tier_fact', 'tier_working'], 'activities', {
  maxResults: 8,
  tierWeights: {
    tier_wisdom: 2,      // boost curated notes 2×
    tier_fact: 1,        // neutral baseline
    tier_working: 0.25,  // downrank unvetted context
  },
  // includeZeroWeightEntities: true — include 0-weight entities as bottom-ranked filler
});
// multiMemory.factScores — Record<factId, weightedScore> | undefined (array entityId only, populated when query is non-empty and at least one fact scored)
// multiMemory.metadata  — { query, entityIds, tierWeights }
```

## Configuration

All `WikiConfig` fields are optional:

```typescript
const wiki = createWiki(db, {
  llmProvider: { /* ... */ },
  config: {
    tablePrefix: 'llm_wiki_',          // default: 'llm_wiki_'
    maxResults: 10,                    // default: 10
    autoLibrarianThreshold: 20,        // default: 20 — events before librarian auto-runs
    autoHealThreshold: 100,            // default: 100 — events before heal auto-runs
    maxChunkLength: 12000,             // default: 12000 (char count per ingestDocument chunk)
    chunkOverlap: 400,                 // default: 400 (overlap between chunks in characters)
    chunkConcurrency: 1,               // default: 1 (parallel LLM calls per ingestDocument)
    pruneRetainSoftDeletedFor: 7,      // default: 7 (days before hard-deleting soft-deleted facts)
    pruneEventsAfter: 30,              // default: 30 (days before hard-deleting old events)
    orphanAfterDays: 30,               // default: 30 (days before runHeal flags sourceless facts; null to disable)
    staleInferredAfterDays: 60,        // default: 60 (days before runHeal downgrades inferred facts; null to disable)
    preFilterLimit: 50,                // default: undefined — MiniSearch pre-filter before cosine scan; recommended for >500 facts
    hybridWeight: 0.7,                 // default: undefined — blend semantic (1.0) ↔ keyword (0.0); pure semantic when unset

    // Global prompt overrides — librarianSystemPrompt and healSystemPrompt apply to write() auto-runs;
    // ingestSystemPrompt applies only to explicit ingestDocument() calls.
    // ⚠ Overrides replace the entire default prompt, including the JSON output contract.
    // Your prompt must instruct the LLM to return the required JSON shape — see packages/core/README.md#prompt-management--overrides.
    prompts: {
      ingestSystemPrompt: `Extract core facts from this document: {{documentChunk}}\n\nReturn ONLY valid JSON: { "facts": [{ "title": "string", "body": "string", "tags": ["string"], "confidence": "certain|inferred|tentative" }] }. No markdown.`,
      librarianSystemPrompt: `Synthesize these thoughts into insights:\n{{events}}\n\nReturn ONLY valid JSON: { "facts": [{ "title": "string", "body": "string", "tags": ["string"], "confidence": "certain|inferred|tentative" }], "tasks": [{ "description": "string", "priority": 0 }] }. No markdown.`,
      healSystemPrompt: `Fix the memory graph based on these candidates: {{healCandidates}}\n\nReturn ONLY valid JSON: { "downgraded": ["factId"], "deleted": ["factId"], "newFacts": [{ "title": "string", "body": "string", "tags": ["string"], "confidence": "certain|inferred|tentative" }] }. No markdown.`,
    },
  },
});
```

## Retrieval Tuning

Optimize `read()` performance and blend retrieval strategies:

```typescript
const config = {
  // Limit cosine similarity scoring to top-K MiniSearch keyword candidates
  preFilterLimit: 50,
  
  // Blend semantic and keyword scores (0.0 = pure keyword, 1.0 = pure semantic)
  hybridWeight: 0.7,
  
  // Max results returned per read
  maxResults: 10,
};

const wiki = createWiki(db, {
  config,
  llmProvider: { /* ... */ },
});
```

**Hybrid scoring blends:**
- `hybridWeight: 1.0` → pure semantic ranking among the candidates being scored; if `preFilterLimit` is set, semantic scoring is still limited to the top-K MiniSearch matches
- `hybridWeight: 0.5` → balanced semantic + keyword (50/50 blend)
- `hybridWeight: 0.0` → pure keyword ranking, skips `embed()` entirely (no LLM API cost)

**Pre-filtering optimization:**
When `preFilterLimit: 50` is set with 1000 facts, cosine similarity is computed only for the top 50 MiniSearch keyword matches, reducing O(N) scoring to O(50).

## Usage

```typescript
import { createWiki } from '@equationalapplications/expo-llm-wiki';
import { openDatabaseSync } from 'expo-sqlite';

const db = openDatabaseSync('wiki.db');

const wiki = createWiki(db, {
  llmProvider: {
    generateText: async ({ systemPrompt, userPrompt }) => {
      // Your LLM call — must return the model output as a string
      return 'Model output';
    },
  },
});

// Initialize tables (call once on app startup)
await wiki.setup();

// Auto-runs: uses config.prompts for background librarian/heal triggers
await wiki.write('user-123', { event_type: 'observation', summary: '...' });

// Manual executions: runtime promptOverride applies only to this single call.
// Must include the JSON output contract — overrides replace the entire default prompt.
await wiki.runLibrarian('user-123', {
  promptOverride: `Strict domain extraction task:\n{{events}}\n\nReturn ONLY valid JSON: { "facts": [{ "title": "string", "body": "string", "tags": ["string"], "confidence": "certain|inferred|tentative" }], "tasks": [{ "description": "string", "priority": 0 }] }. No markdown.`,
});

await wiki.ingestDocument('user-123', {
  sourceRef: 'doc-1',
  sourceHash: sha256(content),
  documentChunk: content,
  promptOverride: `Focus strictly on technical APIs: {{documentChunk}}\n\nReturn ONLY valid JSON: { "facts": [{ "title": "string", "body": "string", "tags": ["string"], "confidence": "certain|inferred|tentative" }] }. No markdown.`,
});
```

## With React

`@equationalapplications/expo-llm-wiki` re-exports all hooks and `WikiProvider` from `@equationalapplications/react-llm-wiki`:

```typescript
import { WikiProvider } from '@equationalapplications/expo-llm-wiki';

<WikiProvider wiki={wiki}>
  <MyApp />
</WikiProvider>
```

Then use hooks in components:

```typescript
import { useMemoryRead } from '@equationalapplications/expo-llm-wiki';

export function UserProfile({ userId }: { userId: string }) {
  const { data, isPending } = useMemoryRead(userId, 'preferences');
  
  if (isPending) return <Text>Loading...</Text>;
  return <Text>{data?.facts.map(f => f.title).join(', ')}</Text>;
}
```

## Component Lifecycle

```mermaid
flowchart TD
    A["<WikiProvider wiki={wiki}>"] --> B["App Components"]
    B --> C{"Use Hook?"}
    C -->|"useMemoryRead(entityId, query, options?)"| D["[Read Memory]"]
    C -->|"useWikiWrite()"| E["[Write Memory]"]
    C -->|"useWikiIngest()"| F["[Ingest Document]"]
    C -->|"useWikiForget()"| G["[Delete Memory]"]
    C -->|"useWikiMaintenance()"| H["[Run Jobs]"]
    D --> I{"entityId, query, wiki,<br/>or ReadOptions changed?"}
    I -->|"Yes"| J["Auto-refetch"]
    I -->|"No"| K["Return cached data"]
    J --> L["Trigger read()"]
    L --> M["Embed query<br/>if embed available"]
    M --> N["Phase 1: Score facts<br/>Phase 2: Fetch winners"]
    N --> O["Update component state"]
    O --> P["Re-render with data"]
    E --> Q["Execute write()"]
    F --> Q
    G --> Q
    H --> Q
    Q --> R["Write completes"]
```

**Data flow:**
1. **Wrap app** with `<WikiProvider wiki={wiki}>` — provides wiki context
2. **Use hooks** in components — access memory reactively
3. **Read operations** auto-refetch when `entityId`, `query`, `wiki`, or `ReadOptions` values change; call `refetch()` to refresh manually
4. **Write operations** (write, ingest, forget, maintenance) do not automatically re-trigger `useMemoryRead`; call `refetch()` after a write to refresh read results
5. **Re-render** with new data flowing back to UI

## Retrieval Engine Internals

```mermaid
flowchart TD
    A["read(entityId | entityId[], query, options?)"] --> B{hybridWeight = 0?}
    B -->|Yes| C["MiniSearch only<br/>(skip embed)"]
    B -->|No| D{embed available?}
    D -->|No| C
    D -->|Yes| F["Embed query"]
    F -->|throws| E["onRetrievalFallback<br/>callback"]
    E --> C
    F -->|succeeds| G{preFilterLimit<br/>active?}
    G -->|Yes| H["MiniSearch pre-filter<br/>top K candidates"]
    H --> I["Phase 1: Cosine score<br/>top K candidates"]
    G -->|No| J["Phase 1: Cosine score<br/>all facts"]
    J --> K["Cache vectors<br/>in-memory<br/>(full scan only)"]
    K --> L{hybridWeight = 1?}
    I --> L
    L -->|Yes| M["Pure semantic<br/>ranking"]
    L -->|No| N["Hybrid blend:<br/>semantic + keyword<br/>via MiniSearch"]
    M --> O["Phase 2: Fetch full rows<br/>top maxResults"]
    N --> O
    C --> P["MiniSearch ranking"]
    P --> O
    O --> R["Track access"]
    R --> Q["Return MemoryBundle"]
```

The flowchart shows:
1. **Fast-path** when `hybridWeight = 0` (pure keyword, no embed cost)
2. **Fallback chain** when embed unavailable (MiniSearch silently) or throws (`onRetrievalFallback` callback, then MiniSearch)
3. **Pre-filtering** to limit cosine scoring to top-K keyword matches (O(N) → O(K))
4. **Two-phase SELECT**: phase 1 scores all/filtered facts with minimal columns, phase 2 fetches full rows for winners
5. **Hybrid scoring** to blend semantic and keyword rankings
6. **Vector caching** on full scans only; reads with `preFilterLimit` active skip cache population

## Multi-Entity Reads

`read()` accepts a single entity ID or an array to search across namespaces in one retrieval pass. Pass `tierWeights` to control per-entity ranking before the final top-K results:

```typescript
const memory = await wiki.read(
  ['tier_wisdom', 'tier_fact', 'tier_working'],
  'What do I know about this topic?',
  {
    maxResults: 8,
    tierWeights: {
      tier_wisdom: 2,      // boost curated notes 2×
      tier_fact: 1,        // neutral
      tier_working: 0.25,  // downrank unvetted context
    },
  }
);
// memory.factScores — Record<factId, weightedScore> | undefined
//   attached for array-shaped reads when the query is non-empty and at least one fact is scored
// memory.metadata  — { query, entityIds, tierWeights }
// tasks capped at min(20 × entityCount, 200); events at min(10 × entityCount, 100)
```

For full details on `{{mustache}}` prompt templating and the strict distinction between global auto-runs and runtime overrides, see [Prompt Management & Overrides](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md#prompt-management--overrides) in `@equationalapplications/core-llm-wiki`.

## Monorepo Ecosystem

| Package | Description |
|---------|-------------|
| [`@equationalapplications/core-llm-wiki`](https://www.npmjs.com/package/@equationalapplications/core-llm-wiki) | Pure TypeScript core — DB-agnostic, bring your own SQLite adapter |
| **`@equationalapplications/expo-llm-wiki`** | Expo / React Native adapter with `expo-sqlite` |
| [`@equationalapplications/react-llm-wiki`](https://www.npmjs.com/package/@equationalapplications/react-llm-wiki) | React hooks + web adapter with `sql.js` |
| [`@equationalapplications/prisma-outbox`](https://www.npmjs.com/package/@equationalapplications/prisma-outbox) | Sync SQLite outbox events to Prisma in a transaction |
| [`@equationalapplications/core-llm-tools`](https://www.npmjs.com/package/@equationalapplications/core-llm-tools) | Platform-agnostic Gemini tool schemas + capability scope injector |

## License

MIT

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
