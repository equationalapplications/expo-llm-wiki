---
title: Ingest documents
description: Extract facts from documents with ingestDocument — chunking, idempotent re-ingest, change detection, partial failures, and duplicates.
sidebar:
  order: 3
---

`ingestDocument()` splits a document into chunks, asks the model to extract facts from each one,
and stores them as `immutable_document` facts that the librarian and heal won't rewrite.

```ts
const result = await wiki.ingestDocument('team', {
  sourceRef: 'handbook.md',            // stable identifier for this document
  sourceHash: sha256(content),         // 64-char hex SHA-256 of the content
  documentChunk: content,              // the whole document; chunking is automatic
});
// → { chunks, ingestedChunks, failedChunks, truncated, parseFailures? }
```

## Only re-ingest what changed

`hasChanged()` compares the hash you pass with the stored one, without calling the LLM:

```ts
if (await wiki.hasChanged('team', 'handbook.md', hash)) {
  await wiki.ingestDocument('team', { sourceRef: 'handbook.md', sourceHash: hash, documentChunk: content });
}
```

When a full ingest succeeds, re-ingesting the same `sourceRef` with a new hash **replaces the
old facts atomically**.

For many documents at once, use the batch form or `pendingSources()`, which also detects
partial ingests:

```ts
const statuses = await wiki.pendingSources('team', [
  { sourceRef: 'a.md', sourceHash: hashA },
  { sourceRef: 'b.md', sourceHash: hashB },
]);
// [{ sourceRef: 'a.md', status: 'current' }, { sourceRef: 'b.md', status: 'partial' }]
```

| Status | Meaning | Action |
|---|---|---|
| `new` | Never ingested, or forgotten | Ingest |
| `changed` | The stored hash differs | Re-ingest |
| `partial` | Facts exist, but none has a stored hash (for example, a chunk failed on first ingest) | Re-ingest to retry |
| `current` | Up to date | Skip |

## Handle partial failures

A chunk fails when the model's response can't be parsed. The engine doesn't throw for partial
failures. Check the result instead:

```ts
const r = await wiki.ingestDocument('team', params);
if (r.failedChunks > 0) {
  console.warn(`${r.failedChunks}/${r.chunks} chunks failed`, r.parseFailures);
  // The hash is NOT recorded, so hasChanged() stays true and a retry re-attempts.
}
```

Only a **total** failure, where every chunk fails, throws `WikiIngestEmptyError`.

## Choose a `sourceRef`

`sourceRef` is normalized: only `A–Z a–z 0–9 . _ -` and spaces are kept. **Slashes are
removed**, so `docs/a.md` and `docsa.md` would collide. Use separators that survive:

```ts
sourceRef: 'docs_onboarding.md'  // ✅
sourceRef: 'docs/onboarding.md'  // ⚠ becomes 'docsonboarding.md'
```

## Chunking options

| Option | Default | Notes |
|---|---|---|
| `maxChunkLength` | `12000` characters | The engine splits at a paragraph break, then a sentence end, then whitespace, then a hard cut. `truncated: true` means a hard cut happened. |
| `chunkOverlap` | `400` characters | Context repeated across chunk boundaries |
| `chunkConcurrency` | `1` | Parallel LLM calls per ingest |

Set these globally in `config` or per call. Surrogate pairs are never split.

To check a batch of sources at once, pass an array to `hasChanged`. Each result is
`{ sourceRef, changed, duplicateOf? }`. `duplicateOf`, when present, names the different stored
`sourceRef` that already holds the same hash (in the database's normalized spelling).

### Reproduce chunk boundaries

The same chunker is exported, so you can re-chunk a source exactly as ingest did. That's useful
for finding the passage a fact came from:

```ts
import {
  chunkText,
  safeSlice,
  DEFAULT_MAX_CHUNK_LENGTH, // 12000
  DEFAULT_CHUNK_OVERLAP,    // 400
} from '@equationalapplications/core-llm-wiki';

const { chunks, truncated } = chunkText(source, DEFAULT_MAX_CHUNK_LENGTH, DEFAULT_CHUNK_OVERLAP);
```

- Empty or whitespace-only input returns `{ chunks: [], truncated: false }` without checking the
  other arguments.
- Otherwise `chunkText` throws unless `maxChunkLength` is an integer of at least 2 and `overlap` is
  a non-negative integer smaller than `maxChunkLength`.
- `ingestDocument()` quietly clamps overlap to `maxChunkLength - 1` and rounds non-integer values
  down, but `chunkText` rejects both. If
  you configured a custom `maxChunkLength`, apply `Math.min(overlap, maxChunkLength - 1)` yourself
  before calling it. (For example, `maxChunkLength: 100` with the default overlap ingests at an
  overlap of `99`.)
- `safeSlice(value, start, end?)` works like `String.prototype.slice`, but clamps out-of-range
  indices, swaps a reversed range, and never splits a surrogate pair.

## Duplicate content under another name

If the same content (the same hash) is already stored under a *different* `sourceRef`, the third
argument decides what happens:

```ts
await wiki.ingestDocument('team', params, { onDuplicateHash: 'skip' });
```

| Mode | Behavior |
|---|---|
| `'ingest'` (default) | No pre-check. A collision caught at commit time throws `WikiDuplicateHashError`. |
| `'skip'` | Checks before calling the LLM and returns a zero-chunk result if a duplicate exists |
| `'throw'` | Checks before calling the LLM and throws `WikiDuplicateHashError` (which carries the existing `sourceRef`) |

Only live references count. Soft-deleted ones never trigger the check.

Calls on the same `WikiMemory` instance are serialized per hash. A writer in another process, or
another `WikiMemory` instance on the same database, can still claim the hash after the pre-check
passes. The transaction then rolls back after the LLM extraction already ran. You still get the
diagnostics that describe the extraction (`fact_rejected`, `fact_deduplicated`). Diagnostics tied to the
rolled-back write (`grounding_*`, `edge_dropped`) are dropped, because the fact IDs they name were
never committed.

## Inventory and deletion

```ts
await wiki.listSourceRefs('team');
// [{ sourceRef, sourceHash, factCount, lastIngestedAt }]

await wiki.forget('team', { sourceRef: 'handbook.md' }, { dryRun: true }); // preview the blast radius
await wiki.forget('team', { sourceRef: 'handbook.md' });                   // remove its facts
```

## Skip the LLM: `upsertGraph`

Already have structured data, such as a parser output, a CSV, or a code index? Write nodes and
edges directly. See [GraphRAG → seed a graph without an LLM](/expo-llm-wiki/guides/graphrag/#seed-a-graph-without-an-llm).
