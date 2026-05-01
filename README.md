# expo-llm-wiki

[![GitHub Tag](https://img.shields.io/github/v/tag/equationalapplications/expo-llm-wiki?label=github%20tag)](https://github.com/equationalapplications/expo-llm-wiki/tags)
[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fexpo-llm-wiki?label=npm)](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki)
[![npm downloads](https://img.shields.io/npm/dm/%40equationalapplications%2Fexpo-llm-wiki?label=downloads)](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Offline-first, SQLite-backed memory for LLM apps built with Expo. Handles FTS5 search, episodic event logging, background fact extraction, and memory healing — bring your own LLM.

## Key Principles

- **Bring Your Own Inference (BYOI):** Provide one `generateText` function. The package owns prompt construction, JSON parsing, and database writes.
- **Namespace Safe:** All tables are prefixed (default: `llm_wiki_`) — no collisions with your existing database.
- **Multi-Entity:** Multiple independent "brains" in one database via `entityId`.
- **Offline First:** Reads are fully local via SQLite FTS5, typically under 50ms.
- **Morphological Matching:** Porter stemming enables recall across word forms — queries for `running` match facts about `run`, `runs`, etc., without manual synonym configuration.
- **Full Unicode Support:** UTF-8 and UTF-16 (including surrogate pairs for emoji) are fully supported. Chunks are split safely at sentence boundaries; surrogate pairs are never fragmented.

## How It Works

```mermaid
flowchart TB
    subgraph API["API Layer"]
        direction TB
        write["write(event)"]
        ingest["ingestDocument()"]
        librarian["runLibrarian()"]
        heal["runHeal()"]
        read["read(entityId, query)"]
    end

    subgraph LLMLayer["LLM Provider"]
        LLM["LLMProvider.generateText()"]
    end

    subgraph SQLiteLayer["SQLite Database"]
        direction TB
        events[(events)]
        entries[("entries<br/>(facts)")]
        tasks[(tasks)]
    end

    subgraph ReadPath["Read Path"]
        FTS5(["FTS5 search"])
        Bundle(["MemoryBundle<br/>facts · tasks · events"])
    end

    %% Write paths
    write --> events
    events -. "≥ threshold" .-> librarian
    
    %% LLM calls
    librarian --> LLM
    heal --> LLM
    ingest --> LLM
    
    %% Database writes
    LLM --> entries
    LLM --> tasks
    
    %% Read path
    read --> FTS5
    FTS5 --> entries
    entries --> Bundle
    tasks --> Bundle
    events --> Bundle
```


## Installation

In your Expo project:

```bash
npx expo install expo-sqlite
npm install expo-llm-wiki
```

Use `npx expo install` for `expo-sqlite` so Expo's version resolver picks the correct native build for your SDK version.

## Setup

```typescript
import { createWiki } from 'expo-llm-wiki';
import * as SQLite from 'expo-sqlite';

const db = await SQLite.openDatabaseAsync('my-app.db');

const wiki = createWiki(db, {
  llmProvider: {
    generateText: async ({ systemPrompt, userPrompt }) => {
      // Connect to OpenAI, Gemini, a local model, etc.
      // Must return a raw string (JSON, optionally in a markdown code fence).
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return response.choices[0].message.content ?? '{}';
    },
  },
  config: {
    tablePrefix: 'llm_wiki_',       // optional, default: 'llm_wiki_'
    maxFtsResults: 10,              // optional, default: 10
    autoLibrarianThreshold: 20,     // optional, default: 20
    maxChunkLength: 6000,           // optional, default: 6000 (char count, not bytes)
    chunkOverlap: 400,              // optional, default: 400 (overlap between chunks in characters)
    chunkConcurrency: 1,            // optional, default: 1 (parallel LLM calls per ingestDocument)
    pruneRetainSoftDeletedFor: 7,   // optional, default: 7  (days before hard-deleting soft-deleted rows)
    pruneEventsAfter: 30,           // optional, default: 30 (days before hard-deleting old events)
  },
});

// Create tables and FTS5 indexes (call once on app startup)
await wiki.setup();
```

## Core API

### Read

FTS5 full-text search over facts, plus open tasks and recent events:

```typescript
const { facts, tasks, events } = await wiki.read('entity-123', 'weekend plans');
// facts: WikiFact[]   — matched by FTS5, ranked by confidence + access count
// tasks: WikiTask[]   — pending and in-progress only
// events: WikiEvent[] — 10 most recent, ascending
```

Pass an empty string to skip FTS and return the most recently updated facts.

### Write

Log an episodic event. Automatically triggers the librarian pass once enough events accumulate:

```typescript
await wiki.write('entity-123', {
  event_type: 'observation',
  summary: 'User mentioned they love hiking on weekends.',
});
// event_type: 'observation' | 'decision' | 'action' | 'outcome'
```

### Ingest Document

Extract facts from a document (chunked internally). Idempotent — re-calling with the same `sourceRef` replaces the prior extraction. Documents are automatically chunked at sentence boundaries; if a sentence exceeds `maxChunkLength`, it is hard-split.

```typescript
const result = await wiki.ingestDocument('entity-123', {
  // sourceRef is normalized: only [A-Za-z0-9._\- ] are kept, all other characters
  // (including `/`) are stripped. Use underscores or dots as path separators to
  // avoid accidental collisions (e.g. 'docs_preferences.md' not 'docs/preferences.md').
  sourceRef: 'preferences.md',        // stable identifier
  sourceHash: sha256(content),        // for change detection
  documentChunk: content,
  maxChunkLength: 12000,              // optional, character count
  chunkOverlap: 400,                  // optional, overlap in characters
  chunkConcurrency: 1,                // optional, parallel LLM calls per ingest (default: 1)
});
// result: { truncated: boolean; chunks: number }
// truncated: true if at least one hard-split was required (no sentence boundary)
// chunks: number of LLM calls made
```

### Background Maintenance

```typescript
// Consolidate recent events into durable facts (auto-triggered by write, or call manually)
await wiki.runLibrarian('entity-123');

// Resolve contradictions, downgrade stale claims, remove obsolete facts
await wiki.runHeal('entity-123');
```

### Format Context

Convert a `MemoryBundle` into a string ready for LLM prompt injection:

```typescript
import { formatContext } from 'expo-llm-wiki';

const bundle = await wiki.read('entity-123', 'weekend plans');
const context = formatContext(bundle, {
  format: 'markdown',        // 'markdown' (default) | 'plain'
  maxFacts: 10,              // default 10
  maxTasks: 10,              // default 10
  maxEvents: 10,             // default 10
  includeConfidence: true,   // default true — appends (certain/inferred/tentative)
  includeTags: true,         // default true — appends [tag1, tag2]
  factWeights: {
    confidence: 1.0,         // default 1.0
    accessCount: 0.3,        // default 0.3 — log(1 + access_count) * weight
    recency: 0.5,            // default 0.5 — decays over 30d
  },
});

// Inject into your system prompt:
const systemPrompt = `You are a helpful assistant.\n\n${context}`;
```

Facts are ranked by a weighted score combining confidence tier, access frequency, and recency. Returns an empty string for an empty bundle.

### Forget

```typescript
const result = await wiki.forget('entity-123', { entryId: 'fact_abc' });    // single fact
// result: { deleted: { entries: number; tasks: number } }

await wiki.forget('entity-123', { taskId: 'task_xyz' });     // single task
// sourceRef is normalized the same way as in ingestDocument (slashes stripped)
await wiki.forget('entity-123', { sourceRef: 'x.md' }); // all facts from a document
await wiki.forget('entity-123', { clearAll: true });          // wipe entity
```

Throws `Error` if `sourceRef` or `sourceHash` is provided but invalid. Soft-deletes are idempotent — calling again with the same parameters returns `{ deleted: { entries: 0; tasks: 0 } }`.

### Check for Changes

Skip re-ingest if a document's content hasn't changed since the last ingest:

```typescript
const changed = await wiki.hasChanged('entity-123', 'preferences.md', sha256(content));
if (changed) {
  await wiki.ingestDocument('entity-123', { sourceRef: 'preferences.md', sourceHash: sha256(content), documentChunk: content });
}
```

Returns `true` if the document has never been ingested, all prior ingest results were forgotten, or the stored hash differs from the supplied one. Returns `false` if the stored hash matches exactly.

Throws `Error` if `sourceRef` or `sourceHash` is invalid (same rules as `ingestDocument`).

### Prune (Hard Delete)

Hard-delete aged soft-deleted entries/tasks and old events to reclaim storage:

```typescript
const result = await wiki.runPrune('entity-123', {
  retainSoftDeletedFor: 7,    // days — hard-delete entries/tasks soft-deleted > 7d ago; null to skip
  retainEventsFor: 30,         // days since created_at — hard-delete old events; null to skip
  vacuum: false,               // set true to VACUUM (slow on mobile, rewrites entire DB)
});
// result: { entries: number; tasks: number; events: number }
```

Defaults: `retainSoftDeletedFor = config.pruneRetainSoftDeletedFor ?? 7`, `retainEventsFor = config.pruneEventsAfter ?? 30`, `vacuum = false`.

Throws `WikiBusyError` if librarian, heal, ingest, or another prune is in-flight for the same entity. `ingestDocument`, `runLibrarian`, and `runHeal` reciprocally throw `WikiBusyError` if a prune is in-flight.

---

## React / Expo Component API

Import from `expo-llm-wiki/react`. This entry point is separate so non-React consumers do not transitively import React.

### Provider

Wrap once at app root (or any subtree that needs memory access):

```typescript
import { WikiProvider } from 'expo-llm-wiki/react';
import { createWiki } from 'expo-llm-wiki';

const wiki = createWiki(db, { llmProvider });

export default function App() {
  return (
    <WikiProvider wiki={wiki}>
      <YourApp />
    </WikiProvider>
  );
}
```

### `useMemoryRead(entityId, query)`

Reactive read. Fetches on mount and whenever `entityId` or `query` changes. In-flight results always land before a queued re-fetch starts — results are never silently discarded.

```typescript
const { data, isPending, error, refetch } = useMemoryRead('entity-123', 'weekend plans');
// data: MemoryBundle | null
```

### `useWikiWrite()`

```typescript
const { execute, isPending, error } = useWikiWrite();

await execute('entity-123', {
  event_type: 'observation',
  summary: 'User mentioned they love hiking.',
});
```

### `useWikiMaintenance()`

Shared `isPending` — true if any operation is in-flight. See [extended form below](#usewikimaintenance-extended) for `runPrune`:

```typescript
const { runLibrarian, runHeal, runPrune, isPending, error } = useWikiMaintenance();

await runLibrarian('entity-123');
await runHeal('entity-123');
```

### `useWikiIngest()`

```typescript
const { execute, lastResult, isPending, error } = useWikiIngest();
// lastResult: { truncated: boolean; chunks: number } | null

const result = await execute('entity-123', {
  sourceRef: 'preferences.md',  // slashes are stripped by normalizeSourceRef
  sourceHash: sha256(content),
  documentChunk: content,
});
// result.truncated — true if any hard-splits were required
// result.chunks   — number of LLM calls made
```

### `useWikiForget()`

```typescript
const { execute, lastResult, isPending, error } = useWikiForget();
// lastResult: { deleted: { entries: number; tasks: number } } | null

const result = await execute('entity-123', { entryId: 'fact_abc' });
// result.deleted.entries — rows soft-deleted
```

### `useWikiHasChanged()`

```typescript
const { execute, lastResult, isPending, error } = useWikiHasChanged();
// lastResult: boolean | null

const changed = await execute('entity-123', 'preferences.md', sha256(content));
```

### `useWikiMaintenance()` (extended)

`runPrune` is now available alongside `runLibrarian` and `runHeal`. Shared `isPending` is true if any operation is in-flight:

```typescript
const { runLibrarian, runHeal, runPrune, isPending, error } = useWikiMaintenance();

const result = await runPrune('entity-123', { retainSoftDeletedFor: 7, retainEventsFor: 30 });
// result: { entries: number; tasks: number; events: number }
```

All mutation hooks follow the same pattern (`TResult` is specific per hook):

```typescript
{
  execute: (...args) => Promise<TResult>;
  lastResult: TResult | null;  // result of the last successful call; null before first call or after an error
  isPending: boolean;
  error: Error | null;         // cleared on the next execute call
}
```

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
