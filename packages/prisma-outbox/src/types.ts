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
}
