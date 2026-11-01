---
title: React hooks
description: Signatures and behavior of every hook in react-llm-wiki and expo-llm-wiki.
sidebar:
  order: 3
---

Import the hooks from `@equationalapplications/react-llm-wiki` on the web, or from
`@equationalapplications/expo-llm-wiki` in Expo. They're the same hooks.

## Setup

```tsx
<WikiProvider wiki={wiki}>
  <App />
</WikiProvider>
```

`useWiki()` returns the `WikiMemory` instance. It throws outside a provider. Use it for any
method that has no hook, such as `listDrafts`, `lint`, or `getInstructions`.

## Conventions

**Mutation hooks** share one shape:

```ts
{
  execute: (...args) => Promise<TResult>;
  lastResult: TResult | null; // last successful result; null before the first call or after an error
  isPending: boolean;
  error: Error | null;        // cleared on the next execute()
}
```

**Writes don't refresh reads.** After a mutation, call `refetch()` on any `useMemoryRead`,
`useOntologyManifest`, or `useWikiTraversal` that should update.

## Read hooks

### `useMemoryRead`

```ts
const { data, isPending, error, refetch } = useMemoryRead(entityId, query, options?);
// data: MemoryBundle | null
```

It fetches on mount, and again when `entityId`, `query`, `wiki`, or relevant `options` change
(`maxResults`, `preFilterLimit`, `hybridWeight`, `tierWeights`). `entityId` may be an array. An
in-flight result always lands before a queued refetch starts.

### `useWikiTraversal`

```ts
const { nodes, edges, isPending, error, refetch } = useWikiTraversal(entityId, { sourceId, maxDepth: 2 });
```

Accepts the same options as [`traverseGraph()`](/expo-llm-wiki/guides/graphrag/#traversal-options).

### `useOntologyManifest`

```ts
const { manifest, mode, isPending, error, refetch } = useOntologyManifest(entityId);
```

`manifest` and `mode` are `null` when the entity has no persisted or seeded manifest.

### `useEntityStatus`

```ts
const { ingesting, librarian, heal } = useEntityStatus(entityId);
```

It's push-based, with no polling, and updates on every job transition.

## Mutation hooks

| Hook | `execute(...)` | `lastResult` |
|---|---|---|
| `useWikiWrite()` | `(entityId, event)` | — |
| `useWikiIngest()` | `(entityId, params)` | `IngestResult` |
| `useWikiForget()` | `(entityId, params)` | `{ deleted: { entries, tasks } }` |
| `useWikiHasChanged()` | `(entityId, sourceRef, sourceHash)` | `boolean` |
| `useWikiExport()` | `(entityIds)` | `MemoryDump` |
| `useSetOntologyManifest()` | `(entityId, manifest, { mode? })` | — |

### `useWikiMaintenance`

```ts
const { runLibrarian, runHeal, runReembed, runPrune, isPending, lastResult, error } = useWikiMaintenance();
```

- `isPending` is shared, so it's `true` while **any** of the operations is running.
- `lastResult` is a discriminated union: `{ operation: 'librarian' | 'heal' | 'prune', result }`.
  Narrow it by checking `operation`.
- `runReembed` deliberately leaves `lastResult` as `null`. Use its returned promise instead.

```ts
import type { MaintenanceResult } from '@equationalapplications/react-llm-wiki';

if (lastResult?.operation === 'prune') console.log(lastResult.result.entries);
```
