import type { PrismaOutboxConfig } from './types';

export class PrismaOutboxWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private config: PrismaOutboxConfig) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.syncBatch(),
      this.config.pollIntervalMs ?? 5000
    );
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async syncBatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const batchSize = this.config.batchSize ?? 100;
      const events = await this.config.wikiMemory.getUnprocessedOutboxEvents(batchSize);
      if (events.length === 0) return;

      const processedIds: string[] = [];

      for (const event of events) {
        try {
          await this.config.prisma.$transaction(tx => this.config.mapEvent(event, tx));
          processedIds.push(event.id);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const skip = this.config.onError?.(error, event);
          if (!skip) break; // halt to preserve ordering
        }
      }

      await this.config.wikiMemory.markOutboxEventsProcessed(processedIds);

      // Backlog optimization: full batch means more events likely waiting — skip the interval delay.
      // Use setTimeout(0) instead of setImmediate for React Native / Hermes compatibility.
      if (events.length === batchSize) {
        setTimeout(() => void this.syncBatch(), 0);
      }
    } finally {
      this.running = false;
    }
  }
}
