import type { WikiMemory, WikiOutboxEvent } from '@equationalapplications/core-llm-wiki';

/** Minimal Prisma client shape required by the worker — avoids depending on generated types. */
export interface PrismaLike<TTx> {
  $transaction: (fn: (tx: TTx) => Promise<void>) => Promise<unknown>;
}

export interface PrismaOutboxConfig<TTx = unknown> {
  /**
   * The WikiMemory instance to poll for outbox events.
   *
   * **Singleton requirement:** run at most one `PrismaOutboxWorker` per SQLite database
   * at a time. The in-process `running` guard prevents overlapping calls within a single
   * worker, but two workers (or two processes) sharing the same database can fetch and
   * process the same unclaimed rows concurrently, producing duplicate Prisma writes.
   * If you need multi-process fan-out, add a claim/lease column to the outbox table.
   */
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
}
