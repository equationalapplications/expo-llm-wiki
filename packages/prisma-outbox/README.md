# @equationalapplications/prisma-outbox

Sync [`@equationalapplications/core-llm-wiki`](https://www.npmjs.com/package/@equationalapplications/core-llm-wiki) SQLite outbox events to your Prisma-backed database using the transactional outbox pattern — at-least-once delivery with ordering guarantees.

[![npm version](https://img.shields.io/npm/v/%40equationalapplications%2Fprisma-outbox?label=prisma-outbox)](https://www.npmjs.com/package/@equationalapplications/prisma-outbox)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/prisma-outbox/LICENSE)

**[GitHub](https://github.com/equationalapplications/expo-llm-wiki)** · **[ScopeLab](https://equationalapplications.github.io/expo-llm-wiki/scopelab/)** · **[WikiDemo](https://equationalapplications.github.io/expo-llm-wiki/wiki-demo/)** · **[Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md)** · **[Issues](https://github.com/equationalapplications/expo-llm-wiki/issues)**

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
    // mapEvent must be idempotent: at-least-once delivery means the same event
    // can be retried if acknowledgement fails after the Prisma transaction commits.
    if (event.operation === 'INSERT' && event.table_name.includes('entries')) {
      await tx.wikiEntry.upsert({
        where: { id: event.record_id },
        create: { id: event.record_id, ...(event.payload as Record<string, unknown>) },
        update: {},
      });
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
| `onWorkerError` | `(err: Error) => void` | — | Called for worker-level errors (SQLite read/ack failures) not delivered to `onError`. |

## How it works

1. Every `WikiMemory` mutation (when `enableOutbox: true`) atomically writes an event to the SQLite `outbox` table in the same transaction as the domain write.
2. `PrismaOutboxWorker` polls `getUnprocessedOutboxEvents()` and calls `mapEvent` inside a Prisma transaction for each event.
3. Successfully processed event IDs are passed to `markOutboxEventsProcessed()`, which deletes them from SQLite.
4. If a full batch is consumed without error, an immediate follow-up cycle runs (backlog optimization) to drain queues faster than the poll interval.

## Limitations

- **Single-instance only.** The worker does not use row-level locking or leases. Running two `PrismaOutboxWorker` instances against the same SQLite file will cause duplicate Prisma writes. Run exactly one worker per SQLite database. `mapEvent` must still be idempotent to tolerate at-least-once delivery (acknowledgement can fail after a successful Prisma commit).

## Monorepo Ecosystem

| Package | Purpose |
| ----- | ----- |
| [@equationalapplications/core-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md) | Persistent episodic memory |
| [@equationalapplications/expo-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/expo/README.md) | Persistent episodic memory for Expo/React Native |
| [@equationalapplications/react-llm-wiki](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/react/README.md) | Persistent episodic memory for Web |
| **@equationalapplications/prisma-outbox** | Sync SQLite outbox events to Prisma |
| [@equationalapplications/core-llm-tools](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core-llm-tools/README.md) | Gemini tool schemas and capability injector |
| [@equationalapplications/core-okf](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/okf/README.md) | Zero-dependency Open Knowledge Format (OKF) v0.1 primitives — parse and produce interoperable knowledge bundles. |

---

Made with ❤️ by Equational Applications LLC. [https://equationalapplications.com/](https://equationalapplications.com/)
