import type { WikiMemory, WikiOutboxEvent } from '@equationalapplications/core-llm-wiki';
import type { PrismaClient, Prisma } from '@prisma/client';

export interface PrismaOutboxConfig {
  wikiMemory: WikiMemory;
  prisma: PrismaClient;
  /**
   * Maps one outbox event to Prisma operations executed inside a Prisma transaction.
   * Uses Prisma.TransactionClient — safer than the manual Omit<PrismaClient, ...> form
   * and automatically tracks new non-transactional properties added by Prisma.
   */
  mapEvent: (event: WikiOutboxEvent, tx: Prisma.TransactionClient) => Promise<void>;
  /** Max events fetched per poll cycle. Default: 100 */
  batchSize?: number;
  /** Milliseconds between poll cycles. Default: 5000 */
  pollIntervalMs?: number;
  /** Called when an event fails; return true to skip and continue, false/undefined to halt. */
  onError?: (error: Error, event: WikiOutboxEvent) => boolean | undefined;
}
