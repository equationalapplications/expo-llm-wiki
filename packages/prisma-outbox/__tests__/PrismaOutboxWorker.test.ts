import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismaOutboxWorker } from '../src/PrismaOutboxWorker';
import type { PrismaOutboxConfig } from '../src/types';
import type { WikiOutboxEvent } from '@equationalapplications/core-llm-wiki';

function makeEvent(id: string): WikiOutboxEvent {
  return {
    id,
    entity_id: 'e1',
    table_name: 'entries',
    record_id: 'r1',
    operation: 'INSERT',
    payload: { key: 'val' },
    created_at: Date.now(),
  };
}

function makeConfig(overrides: Partial<PrismaOutboxConfig> = {}): PrismaOutboxConfig {
  return {
    wikiMemory: {
      getUnprocessedOutboxEvents: vi.fn().mockResolvedValue([]),
      markOutboxEventsProcessed: vi.fn().mockResolvedValue(undefined),
    } as any,
    prisma: {
      $transaction: vi.fn().mockResolvedValue(undefined),
    } as any,
    mapEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('PrismaOutboxWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start() / stop()', () => {
    it('start() fires syncBatch on interval', async () => {
      vi.useFakeTimers();
      const config = makeConfig();
      const worker = new PrismaOutboxWorker(config);
      const spy = vi.spyOn(worker, 'syncBatch').mockResolvedValue(undefined);

      worker.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(spy).toHaveBeenCalledTimes(1);

      worker.stop();
    });

    it('start() is idempotent — second call does not create a second interval', async () => {
      vi.useFakeTimers();
      const config = makeConfig();
      const worker = new PrismaOutboxWorker(config);
      const spy = vi.spyOn(worker, 'syncBatch').mockResolvedValue(undefined);

      worker.start();
      worker.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(spy).toHaveBeenCalledTimes(1);

      worker.stop();
    });

    it('stop() prevents further syncBatch calls', async () => {
      vi.useFakeTimers();
      const config = makeConfig();
      const worker = new PrismaOutboxWorker(config);
      const spy = vi.spyOn(worker, 'syncBatch').mockResolvedValue(undefined);

      worker.start();
      worker.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('uses custom pollIntervalMs', async () => {
      vi.useFakeTimers();
      const config = makeConfig({ pollIntervalMs: 1000 });
      const worker = new PrismaOutboxWorker(config);
      const spy = vi.spyOn(worker, 'syncBatch').mockResolvedValue(undefined);

      worker.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(spy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(spy).toHaveBeenCalledTimes(1);

      worker.stop();
    });
  });

  describe('syncBatch()', () => {
    it('does nothing when no events', async () => {
      const config = makeConfig();
      const worker = new PrismaOutboxWorker(config);
      await worker.syncBatch();
      expect(config.prisma.$transaction).not.toHaveBeenCalled();
      expect(config.wikiMemory.markOutboxEventsProcessed).not.toHaveBeenCalled();
    });

    it('maps events and acknowledges processed IDs', async () => {
      const events = [makeEvent('id1'), makeEvent('id2')];
      const config = makeConfig({
        wikiMemory: {
          getUnprocessedOutboxEvents: vi.fn().mockResolvedValue(events),
          markOutboxEventsProcessed: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const worker = new PrismaOutboxWorker(config);
      await worker.syncBatch();

      expect(config.prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(config.wikiMemory.markOutboxEventsProcessed).toHaveBeenCalledWith(['id1', 'id2']);
    });

    it('concurrency guard prevents overlapping runs', async () => {
      let resolveFirst!: () => void;
      const firstCallPromise = new Promise<void>(r => { resolveFirst = r; });
      const getEvents = vi.fn()
        .mockReturnValueOnce(firstCallPromise.then(() => []))
        .mockResolvedValue([]);

      const config = makeConfig({
        wikiMemory: {
          getUnprocessedOutboxEvents: getEvents,
          markOutboxEventsProcessed: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const worker = new PrismaOutboxWorker(config);

      const first = worker.syncBatch();
      const second = worker.syncBatch(); // should be a no-op
      resolveFirst();
      await Promise.all([first, second]);

      expect(getEvents).toHaveBeenCalledTimes(1);
    });

    it('halts processing on error when onError returns false/undefined', async () => {
      const events = [makeEvent('id1'), makeEvent('id2')];
      const transaction = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue(undefined);
      const config = makeConfig({
        wikiMemory: {
          getUnprocessedOutboxEvents: vi.fn().mockResolvedValue(events),
          markOutboxEventsProcessed: vi.fn().mockResolvedValue(undefined),
        } as any,
        prisma: { $transaction: transaction } as any,
        onError: () => false,
      });
      const worker = new PrismaOutboxWorker(config);
      await worker.syncBatch();

      // id1 failed and halt — only empty processedIds acknowledged
      expect(config.wikiMemory.markOutboxEventsProcessed).toHaveBeenCalledWith([]);
    });

    it('skips poison-pill event and continues when onError returns true', async () => {
      const events = [makeEvent('id1'), makeEvent('id2')];
      const transaction = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue(undefined);
      const config = makeConfig({
        wikiMemory: {
          getUnprocessedOutboxEvents: vi.fn().mockResolvedValue(events),
          markOutboxEventsProcessed: vi.fn().mockResolvedValue(undefined),
        } as any,
        prisma: { $transaction: transaction } as any,
        onError: () => true,
      });
      const worker = new PrismaOutboxWorker(config);
      await worker.syncBatch();

      // id1 skipped (acknowledged) + id2 processed
      expect(config.wikiMemory.markOutboxEventsProcessed).toHaveBeenCalledWith(['id1', 'id2']);
    });

    it('passes batchSize to getUnprocessedOutboxEvents', async () => {
      const getEvents = vi.fn().mockResolvedValue([]);
      const config = makeConfig({
        wikiMemory: {
          getUnprocessedOutboxEvents: getEvents,
          markOutboxEventsProcessed: vi.fn().mockResolvedValue(undefined),
        } as any,
        batchSize: 25,
      });
      const worker = new PrismaOutboxWorker(config);
      await worker.syncBatch();

      expect(getEvents).toHaveBeenCalledWith(25);
    });
  });
});
