# @eq/wiki-core

Pure TypeScript business logic for LLM Wiki Memory.

## Features

- **Platform-agnostic** — Zero runtime dependencies; works with any SQLite driver via the `SQLiteAdapter` interface
- **Full-featured memory** — Facts, tasks, events, semantic search, maintenance jobs
- **Type-safe** — Built with TypeScript, full type exports

## Installation

```bash
npm install @eq/wiki-core
```

## Usage

```typescript
import { WikiMemory, type SQLiteAdapter } from '@eq/wiki-core';

// Provide any SQLiteAdapter-compatible driver
const wikiMemory = new WikiMemory(db, {
  llmProvider: {
    generateText: async ({ systemPrompt, userPrompt }) => {
      // Your LLM call here
    },
  },
});

// Store facts
await wikiMemory.write('user-123', {
  type: 'observation',
  summary: 'User prefers async/await over promises',
});

// Query memory
const memory = await wikiMemory.read('user-123', 'coding style preferences');
```

## Adapter Interface

Implement `SQLiteAdapter` to use your platform's SQLite driver:

```typescript
export interface SQLiteAdapter {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}
```

Platform packages (`@eq/wiki-expo`, `@eq/wiki-react`) provide pre-built adapters.

## License

MIT
