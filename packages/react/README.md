# @eq/wiki-react

React hooks for @eq/wiki-core, designed for web and Expo.

## Features

- **Reactive reads** — Auto-refetch on `entityId` or query changes
- **Mutation hooks** — `useWikiWrite`, `useWikiIngest`, `useWikiForget`, etc.
- **Shared context** — Single `WikiProvider` per app, use anywhere

## Installation

```bash
npm install @eq/wiki-react @eq/wiki-core
```

## Setup

```typescript
import { WikiProvider } from '@eq/wiki-react';
import { createWiki } from '@eq/wiki-core'; // or '@eq/wiki-expo' for Expo apps

// Create wiki instance and initialize tables
const wiki = createWiki(adapter, options);
await wiki.setup();

// Wrap app
<WikiProvider wiki={wiki}>
  <App />
</WikiProvider>
```

## Hooks

### `useMemoryRead(entityId, query)`

Fetch memory reactively.

```typescript
const { data, isPending, error, refetch } = useMemoryRead('user-123', 'preferences');
```

### `useWikiWrite()`

Mutate facts.

```typescript
const { execute, isPending, error } = useWikiWrite();
await execute('user-123', { event_type: 'observation', summary: '...' });
```

### `useWikiIngest()`

Ingest documents.

```typescript
const { execute, isPending, error } = useWikiIngest();
await execute('user-123', {
  sourceRef: 'doc://readme',
  sourceHash: 'a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2',
  documentChunk: 'raw document text...',
});
```

### `useWikiForget()`

Forget entries.

```typescript
const { execute, isPending, error } = useWikiForget();
await execute('user-123', { entryId: 'fact-456' });
```

### `useWikiMaintenance()`

Run background maintenance.

```typescript
const { runLibrarian, runHeal, isPending, error } = useWikiMaintenance();
await runLibrarian('user-123');
```

### `useWikiHasChanged()`

Check if a source document has changed since last ingest.

```typescript
const { execute, lastResult, isPending, error } = useWikiHasChanged();
const changed = await execute('user-123', 'doc://readme', 'a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2');
```

### `useWikiExport()`

Export memory dump.

```typescript
const { execute, lastResult, isPending, error } = useWikiExport();
await execute(['user-123']);
// lastResult: MemoryDump | null
```

## License

MIT
