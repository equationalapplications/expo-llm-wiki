---
title: Core types
description: The shapes of facts, tasks, events, edges, bundles, and manifests.
sidebar:
  order: 5
---

All types are exported from `@equationalapplications/core-llm-wiki`. This is an abridged view.
Your editor's IntelliSense has the full JSDoc.

## `WikiFact`

```ts
interface WikiFact {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  tags: string[];
  confidence: 'certain' | 'inferred' | 'tentative';
  source_type: 'user_stated' | 'librarian_inferred' | 'user_confirmed' | 'immutable_document';
  source_ref: string | null;
  source_hash: string | null;
  created_at: number;           // epoch ms
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number;
  deleted_at: number | null;    // soft delete
  okf_type?: string | null;     // ontology node type
  lifecycle_status?: 'draft' | 'stable' | 'deprecated';
  valid_from?: number | null;   // temporal window [valid_from, valid_to)
  valid_to?: number | null;
  superseded_by?: string | null;
  // …plus OKF provenance: okf_sources, okf_verified, generated_by, stale_after, …
}
```

## `WikiEvent`

```ts
interface WikiEvent {
  id: string;
  entity_id: string;
  event_type: 'observation' | 'decision' | 'action' | 'outcome';
  summary: string;
  related_entry_id?: string | null;
  created_at: number;           // ingestion time (ordering key)
  occurred_at?: number | null;  // real-world time
}
```

## `MemoryBundle`

```ts
interface MemoryBundle {
  facts: WikiFact[];
  sources?: SourcePassage[];           // present only when read() got the sources option
  tasks: WikiTask[];
  events: WikiEvent[];
  edges?: WikiEdge[];
  summary?: string;
  librarian_watermark?: { at: number; id: string }; // set by export only
  factScores?: Record<string, number>; // multi-entity reads with a non-empty query
  metadata?: {                         // multi-entity reads
    query: string;
    entityIds: string[];
    tierWeights?: Record<string, number>;
    tierFloors?: Record<string, number>;
  };
}
```

`librarian_watermark` is the exporting database's librarian position, set by `exportDump()` and
`getMemoryBundle()` when the entity has one. A merge import trusts events at or before it as
already consolidated at the source and keeps their dates. Events dated *after* the watermark
are not trusted that way: if such an event's date would sort behind the local librarian
position (or its date is unusable), the import re-dates it just after the current time — or
just after the librarian position, if that is later — keeping its order, and reports
`event_created_at_restamped`. **The watermark is not the source text store** —
it tracks the librarian, not stored text.

## `WikiEdge`

```ts
interface WikiEdge {
  id: string;
  entity_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  created_at: number;
}
```

## `OntologyManifest`

```ts
interface OntologyManifest {
  node_types: Array<{ type: string; description: string; parent_type?: string }>;
  edge_types: Array<{ type: string; source_type: string; target_type: string; description: string }>;
}
type OntologyMode = 'off' | 'strict' | 'emergent';
```

## `ReadOptions`

```ts
interface ReadOptions {
  sources?: { query: string; maxPassages?: number; charBudget?: number }; // stored-source passages
  maxResults?: number;
  preFilterLimit?: number | null;   // null disables a config-level value
  hybridWeight?: number;
  tierWeights?: Record<string, number>;
  tierFloors?: Record<string, number>;
  includeZeroWeightEntities?: boolean;
  excludeDrafts?: boolean;
  asOf?: number;
  tokenBudget?: number;
}
```

## Ingest result

```ts
{
  chunks: number;           // LLM calls made
  ingestedChunks: number;   // chunks whose facts were committed
  failedChunks: number;
  truncated: boolean;       // a hard split happened
  parseFailures?: ChunkFailure[]; // present when failedChunks > 0
}
```

## Source text store

Added in 9.2.0. See [Source text store](/expo-llm-wiki/guides/source-store/).

```ts
type StoreSourceResult =
  | { stored: true; sourceRef: string; sourceHash: string;
      charCount: number; passageCount: number; storedAt: number }
  | { stored: false; diagnostics: WikiDiagnostic[] };

interface StoredSource {          // getStoredSource()
  sourceRef: string;
  sourceHash: string;
  text: string;
  charCount: number;
  storedAt: number;
}

interface StoredSourceSummary {   // one entry of listStoredSources()
  sourceRef: string;
  sourceHash: string;
  charCount: number;
  passageCount: number;
  storedAt: number;
}

interface SourcePassage {         // one windowed passage in a read() sources group
  entityId: string;
  sourceRef: string;
  sourceHash: string;
  seq: number;
  startOffset: number;            // UTF-16 offset into the stored text, inclusive
  endOffset: number;              // UTF-16 offset, exclusive
  truncated: boolean;             // the window was cut from a larger passage
  text: string;
}

interface StoredSourceDump {      // one stored source in a MemoryDump
  sourceRef: string;
  sourceHash: string;
  text: string;
  textHash: string;
  charCount: number;
  storedAt: number;
  passages: Array<{ seq: number; startOffset: number; endOffset: number }>; // fidelity only
}

interface ImportDumpResult {
  skippedSources: Array<{ sourceRef: string; code: WikiDiagnosticCode }>;
}

type MemoryDumpEntity = MemoryBundle & { storedSources?: StoredSourceDump[] };
```
