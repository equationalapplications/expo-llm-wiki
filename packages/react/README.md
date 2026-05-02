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

// Create wiki instance (from @eq/wiki-core or @eq/wiki-expo)
const wiki = createWiki(db, options);

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
await execute('user-123', { type: 'observation', summary: '...' });
```

### `useWikiIngest()`

Ingest documents.

```typescript
const { execute, isPending, error } = useWikiIngest();
await execute('user-123', 'raw document text...');
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
const changed = await execute('user-123', 'doc://readme', 'sha256-abc');
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
