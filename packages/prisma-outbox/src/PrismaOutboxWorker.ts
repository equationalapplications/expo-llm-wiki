import type { PrismaOutboxConfig } from './types';

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

  #workerError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.config.onWorkerError?.(error);
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
      const rawSize = this.config.batchSize ?? 100;
      const batchSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.trunc(rawSize) : 100;
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
            // thrown handler treated as halt; processedIds acknowledged below
            halted = true;
            break;
          }
          if (skip) {
            processedIds.push(event.id); // acknowledge so the event isn't re-fetched
          } else {
            halted = true;
            break; // halt to preserve ordering
          }
        }
      }

      await this.config.wikiMemory.markOutboxEventsProcessed(processedIds);

      // Backlog optimization: full batch without halt means more events likely waiting.
      // Only schedule when worker is still running (stop() not called) to avoid post-stop leaks.
      // Use setTimeout(0) instead of setImmediate for React Native / Hermes compatibility.
      if (!halted && events.length === batchSize && this.timer !== undefined) {
        clearTimeout(this.backlogTimer);
        this.backlogTimer = setTimeout(() => { this.syncBatch().catch(err => this.#workerError(err)); }, 0);
      }
    } finally {
      this.running = false;
    }
  }
}
