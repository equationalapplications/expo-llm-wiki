# @equationalapplications/prisma-outbox

Prisma adapter for the [expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki) transactional outbox pattern.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fprisma-outbox?label=prisma-outbox)](https://www.npmjs.com/package/@equationalapplications/prisma-outbox)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Polls the SQLite outbox table written by `@equationalapplications/core-llm-wiki` and syncs events to your Prisma-backed system inside a Prisma transaction, with configurable batch size, poll interval, error handling, and a concurrency guard.

## Installation

```bash
npm install @equationalapplications/prisma-outbox
# peer deps
npm install @equationalapplications/core-llm-wiki @prisma/client
```

## Quick start

```typescript
import { PrismaOutboxWorker } from '@equationalapplications/prisma-outbox';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import { PrismaClient } from '@prisma/client';

const wiki = new WikiMemory(db, {
  llmProvider,
  config: { enableOutbox: true },
});
await wiki.setup();

const prisma = new PrismaClient();

const worker = new PrismaOutboxWorker({
  wikiMemory: wiki,
  prisma,
  mapEvent: async (event, tx) => {
    if (event.operation === 'INSERT' && event.table_name.includes('entries')) {
      await tx.wikiEntry.create({ data: { id: event.record_id, ...(event.payload as Record<string, unknown>) } });
    }
  },
  pollIntervalMs: 5000,
  batchSize: 100,
  onError: (err, event) => {
    console.error('Outbox event failed', event.id, err);
    return false; // halt to preserve ordering; return true to skip poison-pill
  },
});

worker.start();

// On shutdown:
worker.stop();
```

## API

### `PrismaOutboxWorker`

| Method | Description |
|--------|-------------|
| `start()` | Begins polling on the configured interval. Idempotent. |
| `stop()` | Clears the poll interval and any pending backlog timeout. |
| `syncBatch()` | Manually trigger one poll cycle (useful for testing). |

### `PrismaOutboxConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `wikiMemory` | `WikiMemory` | required | The `WikiMemory` instance to poll. |
| `prisma` | `PrismaLike<TTx>` | required | Any Prisma client with a `$transaction` method (your generated `PrismaClient` satisfies this). |
| `mapEvent` | `(event, tx: TTx) => Promise<void>` | required | Maps one outbox event to Prisma operations inside a transaction. `tx` is inferred from your `PrismaClient`. |
| `batchSize` | `number` | `100` | Max events fetched per cycle. |
| `pollIntervalMs` | `number` | `5000` | Milliseconds between poll cycles. |
| `onError` | `(err, event) => boolean \| undefined` | — | Return `true` to skip a failing event; `false`/`undefined` to halt. |

## How it works

1. Every `WikiMemory` mutation (when `enableOutbox: true`) atomically writes an event to the SQLite `outbox` table in the same transaction as the domain write.
2. `PrismaOutboxWorker` polls `getUnprocessedOutboxEvents()` and calls `mapEvent` inside a Prisma transaction for each event.
3. Successfully processed event IDs are passed to `markOutboxEventsProcessed()`, which deletes them from SQLite.
4. If a full batch is consumed without error, an immediate follow-up cycle runs (backlog optimization) to drain queues faster than the poll interval.
