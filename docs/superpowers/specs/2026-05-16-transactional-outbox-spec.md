# Spec: Transactional Outbox Pattern

**Date:** 2026-05-16
**Status:** Fully implemented

---

## Problem

Developers using `expo-llm-wiki` need to synchronize the local SQLite memory graph with external systems (PostgreSQL via Prisma, search indexes, analytics pipelines) without risking dual-write failures. There is no current mechanism to safely observe mutations after they commit.

---

## Solution

Implement a Transactional Outbox pattern inside the core library. Every mutation writes an event to an internal `llm_wiki_outbox` SQLite table **within the same `withTransactionAsync` call** as the domain write. External consumers poll this table and delete rows after successful processing.

---

## Current Implementation State

`OutboxRepository` already exists at `packages/core/src/repositories/OutboxRepository.ts` with:

- `push(params, tx)` — inserts a row atomically within the caller's transaction
- `fetchPending(limit)` — reads pending rows ordered by `created_at ASC`
- `acknowledge(ids)` — deletes processed rows by ID

`EntryRepository` and `TaskRepository` instantiate `OutboxRepository` and call `outboxRepo.push()` on every mutation; the `enableOutbox` flag in `OutboxRepository`'s constructor gates those writes.

`WikiMemory` exposes `getUnprocessedOutboxEvents` and `markOutboxEventsProcessed` as thin delegations to `OutboxRepository`.

---

## Design Decisions

### Outbox lives inside core SQLite (not a separate store)

The outbox table lives in the same SQLite database as `facts`, `tasks`, and `events`. This gives:

- **100% atomicity:** if the domain write rolls back, the outbox event is aborted with it — no divergence possible
- **Zero new dependencies:** no message broker, no network, no additional processes
- **Strict total ordering:** events are fetched `ORDER BY created_at ASC, rowid ASC`; `created_at` is millisecond-resolution and IDs are random (`out_<uuid>`), so rowid is the deterministic tie-breaker for same-millisecond writes

### Opt-in via `WikiConfig.enableOutbox` (implemented)

The feature is off by default. The gate lives in `OutboxRepository.push()` — it returns early when `enableOutbox` is `false`. This is the single chokepoint for all 14 call sites across `EntryRepository` and `TaskRepository`, so no per-call-site wrapping is needed.

`WikiMemory` passes `!!options.config?.enableOutbox` into `OutboxRepository`'s constructor. `EntryRepository` and `TaskRepository` call sites are unchanged.

### Schema always created, writes conditional

`setup()` always runs `CREATE TABLE IF NOT EXISTS llm_wiki_outbox`. An empty SQLite table costs ~bytes. Toggling `enableOutbox: true` after initial deployment requires no migration — the table is already present.

### Delete on process (not update `processed_at`)

`OutboxRepository.acknowledge()` issues a `DELETE` rather than setting `processed_at`. The outbox is a delivery mechanism, not a historical ledger — that role belongs to the `events` table already managed by `runPrune`. Deleting processed rows keeps the outbox at ~zero bytes when the consumer is running.

### Consumer APIs work even when `enableOutbox: false`

If a developer disables the outbox after a period of use, `getUnprocessedOutboxEvents` and `markOutboxEventsProcessed` continue to function so the background worker can drain the remaining queue gracefully before going idle.

### Prisma integration lives in a separate package

Core stays zero-dependency. The Prisma adapter ships as `@equationalapplications/prisma-outbox` with `@prisma/client` declared as a **peer dependency** (not a bundled dependency) so the adapter uses the host app's generated Prisma schema.

### Mapping via callback, not fixed schema

The adapter does not assume Prisma model names. Developers supply a mapping function that receives a `WikiOutboxEvent` and executes arbitrary Prisma operations. This decouples the library from any specific Prisma schema shape.

---

## Event Schema

The actual SQLite outbox table schema (defined in `packages/core/src/db/schema.ts` and `migrations.ts`) is:

```sql
CREATE TABLE IF NOT EXISTS ${prefix}outbox (
  id         TEXT    PRIMARY KEY,
  entity_id  TEXT    NOT NULL,
  table_name TEXT    NOT NULL,   -- e.g. 'entries', 'tasks'
  record_id  TEXT    NOT NULL,   -- primary key of the mutated row
  operation  TEXT    NOT NULL,   -- 'INSERT' | 'UPDATE' | 'DELETE'
  payload    TEXT    NOT NULL,   -- JSON-serialized domain object
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ${prefix}outbox_entity_id_created_at
  ON ${prefix}outbox (entity_id, created_at);

CREATE INDEX IF NOT EXISTS ${prefix}outbox_created_at
  ON ${prefix}outbox (created_at);
```

Note: `processed_at` column is **not** included — rows are deleted on processing.

The corresponding TypeScript type exposed to consumers:

```typescript
// packages/core/src/outbox/types.ts

export interface WikiOutboxEvent<T = unknown> {
  id: string;           // prefixed ID, e.g. 'out_abc123'
  entity_id: string;    // namespace / user identifier
  table_name: string;   // which table was mutated
  record_id: string;    // primary key of the mutated row
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  payload: T;           // deserialized domain object
  created_at: number;   // epoch ms
}
```

---

## `WikiConfig` Extension

```typescript
export interface WikiConfig {
  // ... existing fields ...

  /**
   * When true, every mutation appends an event to the internal outbox table.
   * The table is always created; this flag only controls whether writes occur.
   *
   * @default false
   */
  enableOutbox?: boolean;
}
```

---

## Internal Write Pattern

Every domain mutation in `EntryRepository` and `TaskRepository` calls `outboxRepo.push()` unconditionally. The gate lives inside `OutboxRepository.push()` — it returns early when `enableOutbox` is false:

```typescript
// OutboxRepository.push() — single gate for all 14 call sites
async push(params, tx): Promise<void> {
  if (!this.enableOutbox) return;
  // ... INSERT INTO outbox ...
}
```

Call sites in the repositories are unchanged:

```typescript
await this.db.withTransactionAsync(async (tx) => {
  // Domain write
  await tx.runAsync(`INSERT INTO ${prefix}entries (...) VALUES (...)`, [...]);

  // Outbox — no-op when enableOutbox: false
  await this.outbox.push(
    { entityId, tableName: 'entries', recordId: id, operation: 'INSERT', payload: fact },
    tx,
  );
});
```

---

## Consumer API on `WikiMemory`

`WikiMemory` exposes these methods as thin delegations to `OutboxRepository`.

```typescript
export interface WikiMemory {
  // ... existing methods ...

  /**
   * Returns up to `limit` unprocessed outbox events, oldest first.
   * Delegates to OutboxRepository.fetchPending().
   * Works regardless of enableOutbox value (allows draining after disabling).
   */
  getUnprocessedOutboxEvents(limit?: number): Promise<WikiOutboxEvent[]>;

  /**
   * Deletes the given event IDs from the outbox table.
   * Delegates to OutboxRepository.acknowledge().
   * Call after successfully committing events to the external system.
   */
  markOutboxEventsProcessed(eventIds: string[]): Promise<void>;
}
```

### Implementation (additions to `WikiMemory.ts`)

```typescript
async getUnprocessedOutboxEvents(limit = 100): Promise<WikiOutboxEvent[]> {
  const rows = await this.outboxRepo.fetchPending(limit);
  return rows.map(row => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // corrupted row — surface null payload rather than poisoning the batch
    }
    return { ...row, payload } as WikiOutboxEvent;
  });
}

async markOutboxEventsProcessed(eventIds: string[]): Promise<void> {
  await this.outboxRepo.acknowledge(eventIds);
}
```

Defensive JSON parse: a single malformed row returns `payload: null` rather than throwing and halting the entire batch. `outboxRepo` is already a private field — no structural changes needed, only the two method additions.

---

## Prisma Adapter Package

### Monorepo location

```
expo-llm-wiki/
└── packages/
    ├── core/
    ├── expo/
    ├── react/
    └── prisma-outbox/          # new
        ├── package.json
        ├── tsup.config.ts
        └── src/
            ├── index.ts
            ├── PrismaOutboxWorker.ts
            └── types.ts
```

### `package.json` (key fields)

```json
{
  "name": "@equationalapplications/prisma-outbox",
  "version": "1.0.0",
  "peerDependencies": {
    "@equationalapplications/core-llm-wiki": "workspace:*",
    "@prisma/client": "^5.0.0 || ^6.0.0"
  },
  "devDependencies": {
    "@prisma/client": "^5.0.0",
    "prisma": "^5.0.0"
  }
}
```

### Adapter API

```typescript
// packages/prisma-outbox/src/types.ts

import type { WikiMemory, WikiOutboxEvent } from '@equationalapplications/core-llm-wiki';

/** Minimal Prisma client shape required by the worker — avoids depending on generated types. */
export interface PrismaLike<TTx> {
  $transaction: (fn: (tx: TTx) => Promise<void>) => Promise<unknown>;
}

export interface PrismaOutboxConfig<TTx = unknown> {
  wikiMemory: WikiMemory;
  prisma: PrismaLike<TTx>;
  /**
   * Maps one outbox event to Prisma operations executed inside a Prisma transaction.
   * `tx` is the Prisma transaction client passed by `prisma.$transaction`.
   */
  mapEvent: (event: WikiOutboxEvent, tx: TTx) => Promise<void>;
  /** Max events fetched per poll cycle. Default: 100 */
  batchSize?: number;
  /** Milliseconds between poll cycles. Default: 5000 */
  pollIntervalMs?: number;
  /** Called when an event fails; return true to skip and continue, false/undefined to halt. */
  onError?: (error: Error, event: WikiOutboxEvent) => boolean | undefined;
  /** Called when a worker-level error occurs (e.g. SQLite read/ack failure). Not called for per-event errors handled by onError. */
  onWorkerError?: (error: Error) => void;
}
```

```typescript
// packages/prisma-outbox/src/PrismaOutboxWorker.ts

export class PrismaOutboxWorker<TTx = unknown> {
  private timer?: ReturnType<typeof setInterval>;
  private backlogTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(private config: PrismaOutboxConfig<TTx>) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => { this.syncBatch().catch(err => this.#workerError(err)); },
      this.config.pollIntervalMs ?? 5000
    );
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.backlogTimer);
    this.backlogTimer = undefined;
  }

  async syncBatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const batchSize = this.config.batchSize ?? 100;
      const events = await this.config.wikiMemory.getUnprocessedOutboxEvents(batchSize);
      if (events.length === 0) return;

      const processedIds: string[] = [];
      let halted = false;

      for (const event of events) {
        try {
          await this.config.prisma.$transaction(tx => this.config.mapEvent(event, tx));
          processedIds.push(event.id);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          let skip = false;
          try {
            skip = this.config.onError?.(error, event) ?? false;
          } catch {
            halted = true;
            break;
          }
          if (skip) {
            processedIds.push(event.id);
          } else {
            halted = true;
            break; // halt to preserve ordering
          }
        }
      }

      await this.config.wikiMemory.markOutboxEventsProcessed(processedIds);

      // Backlog optimization: full batch without halt means more events likely waiting.
      // Only schedule when worker is still running (stop() not called) to avoid post-stop leaks.
      if (!halted && events.length === batchSize && this.timer !== undefined) {
        clearTimeout(this.backlogTimer);
        this.backlogTimer = setTimeout(() => { this.syncBatch().catch(err => this.#workerError(err)); }, 0);
      }
    } finally {
      this.running = false;
    }
  }
}
```

### Developer usage example

Note that `event.table_name` + `event.operation` replace the former `event.event_type` field:

```typescript
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import { PrismaOutboxWorker } from '@equationalapplications/prisma-outbox';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const worker = new PrismaOutboxWorker({
  wikiMemory,
  prisma,
  batchSize: 50,
  pollIntervalMs: 3000,
  async mapEvent(event, tx) {
    if (event.table_name.endsWith('entries')) {
      switch (event.operation) {
        case 'INSERT':
          // mapEvent must be idempotent; use upsert so retries after ack failure are safe.
          await tx.myFact.upsert({
            where: { id: event.record_id },
            create: {
              id: event.record_id,
              ownerId: event.entity_id,
              title: event.payload.title,
              body: event.payload.body,
            },
            update: { title: event.payload.title, body: event.payload.body },
          });
          break;
        case 'UPDATE':
          await tx.myFact.update({
            where: { id: event.record_id },
            data: { title: event.payload.title, body: event.payload.body },
          });
          break;
        case 'DELETE':
          await tx.myFact.delete({ where: { id: event.record_id } });
          break;
      }
    }
    // handle other table_name values (tasks, etc.) similarly
  },
  onError(error, event) {
    console.error(`Outbox event ${event.id} failed:`, error);
    return false; // halt
  },
});

worker.start();
```

---

## Behaviour Matrix

| `enableOutbox` | Outbox table exists | New events written | Consumer APIs functional |
|---|---|---|---|
| `false` (default) | Yes | No | Yes (drain remaining rows) |
| `true` | Yes | Yes | Yes |
| Toggled `true → false` | Yes | No | Yes (graceful drain) |

---

## Out of Scope

- **Replay from outbox:** If the Prisma database needs a full rebuild, consumers should query `facts`/`tasks` tables directly rather than replaying transient outbox history.
- **Outbox pruning job:** Not needed — `markOutboxEventsProcessed` deletes rows immediately.
- **`processed_at` column:** Not included — rows are deleted, not marked.
- **Fixed Prisma schema names:** The adapter uses developer-supplied `mapEvent` callbacks; no model name conventions are imposed.
- **React Native / Expo background workers:** Scheduling `PrismaOutboxWorker` in a mobile runtime is the host app's responsibility (e.g., via Expo background tasks). The worker exposes `syncBatch()` for manual invocation in addition to `start()`/`stop()`.

---

## Files Affected

| Package | File | Action | Status |
|---|---|---|---|
| `core` | `src/outbox/types.ts` | Create — `WikiOutboxEvent` interface | Done |
| `core` | `src/types.ts` | Modify — add `enableOutbox?: boolean` to `WikiConfig` | Done |
| `core` | `src/repositories/OutboxRepository.ts` | Modify — accept `enableOutbox` flag in constructor; `push()` returns early when false | Done |
| `core` | `src/WikiMemory.ts` | Modify — pass `enableOutbox` to `OutboxRepository`; add `getUnprocessedOutboxEvents`, `markOutboxEventsProcessed` | Done |
| `core` | `src/index.ts` | Modify — export `WikiOutboxEvent` | Done |
| `prisma-outbox` | `packages/prisma-outbox/src/types.ts` | Create | Done |
| `prisma-outbox` | `packages/prisma-outbox/src/PrismaOutboxWorker.ts` | Create | Done |
| `prisma-outbox` | `packages/prisma-outbox/src/index.ts` | Create | Done |
| `prisma-outbox` | `packages/prisma-outbox/package.json` | Create | Done |
| `prisma-outbox` | `packages/prisma-outbox/tsup.config.ts` | Create | Done |

---

## Open Questions

None — all design decisions resolved above.
