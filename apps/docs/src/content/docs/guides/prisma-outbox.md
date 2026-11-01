---
title: Sync to a server database
description: Mirror on-device memory into Postgres (or any Prisma database) with the transactional outbox pattern.
sidebar:
  order: 15
---

With `enableOutbox: true`, every fact and task mutation also writes an **outbox event** to SQLite,
**in the same transaction**. `@equationalapplications/prisma-outbox` reads that table and replays
the events into your Prisma database, with at-least-once delivery and ordering preserved.

```bash
npm install @equationalapplications/prisma-outbox @equationalapplications/core-llm-wiki @prisma/client
```

```ts
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import { PrismaOutboxWorker } from '@equationalapplications/prisma-outbox';
import { PrismaClient } from '@prisma/client';

const wiki = new WikiMemory(db, { llmProvider, config: { enableOutbox: true } });
await wiki.setup();

const worker = new PrismaOutboxWorker({
  wikiMemory: wiki,
  prisma: new PrismaClient(),
  mapEvent: async (event, tx) => {
    // MUST be idempotent: an event can be redelivered if the ack fails after commit.
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
    console.error('outbox event failed', event.id, err);
    return false; // false = halt (preserve order); true = skip this poison event
  },
});

worker.start();
// on shutdown:
worker.stop();
```

## How it works

1. A mutation writes the domain row and an outbox row in one SQLite transaction.
2. The worker polls `getUnprocessedOutboxEvents()` and runs `mapEvent` inside a Prisma transaction.
3. Successful event IDs go to `markOutboxEventsProcessed()`, which deletes them.
4. If a full batch drained without errors, the worker polls again immediately to catch up.

## Config

| Field | Default | Description |
|---|---|---|
| `wikiMemory` | required | The instance to poll |
| `prisma` | required | Anything with `$transaction` (your `PrismaClient`) |
| `mapEvent(event, tx)` | required | Applies one event in a Prisma transaction |
| `batchSize` | `100` | Events per poll cycle |
| `pollIntervalMs` | `5000` | Time between polls |
| `onError(err, event)` | halt | Return `true` to skip the event, `false` to halt |
| `onWorkerError(err)` | — | Called for SQLite read or ack failures |

:::caution[Single worker per database]
The worker doesn't use leases or row locks. Run **exactly one** worker per SQLite file.
:::
