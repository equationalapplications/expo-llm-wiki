import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriteService } from '../../src/services/WriteService';
import { WikiBusyError } from '../../src/types';
import type { WikiOptions } from '../../src/types';

describe('WriteService', () => {
  let mockDb: any;
  let mockOptions: WikiOptions;
  let mockEntryRepo: any;
  let mockEventRepo: any;
  let mockMetadataRepo: any;
  let mockJobManager: any;
  let mockMaintenanceService: any;
  let writeService: WriteService;

  beforeEach(() => {
    // 1. Setup Transactional DB Mock
    mockDb = {
      // Automatically execute the transaction callback synchronously for testing
      withTransactionAsync: vi.fn(async (cb: (tx: unknown) => Promise<void>) => await cb(mockDb)),
    };

    // 2. Setup Config
    mockOptions = {
      llmProvider: { generateText: vi.fn().mockResolvedValue('{}') },
      config: {
        autoLibrarianThreshold: 20,
        autoHealThreshold: 100,
      },
    };

    // 3. Setup Repositories
    mockEntryRepo = {
      findByIds: vi.fn().mockResolvedValue([]),
    };

    mockEventRepo = {
      add: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(10), // Default: 10 total events
    };

    mockMetadataRepo = {
      getCheckpoint: vi.fn().mockResolvedValue({ memory: 0, heal: 0 }),
      updateCheckpoint: vi.fn().mockResolvedValue(undefined),
    };

    // 4. Setup Services & Managers
    mockJobManager = {
      isBlocked: vi.fn().mockReturnValue(false),
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
      tryAcquireAutoHealLock: vi.fn().mockReturnValue(true),
    };

    mockMaintenanceService = {
      doRunLibrarian: vi.fn().mockResolvedValue(undefined),
      doRunHeal: vi.fn().mockResolvedValue(undefined),
    };

    writeService = new WriteService(
      mockDb,
      mockOptions,
      mockEntryRepo,
      mockEventRepo,
      mockMetadataRepo,
      mockJobManager,
      mockMaintenanceService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Event Appending', () => {
    it('wraps event addition and checkpoint checking in a single transaction', async () => {
      await writeService.write('user_1', { summary: 'test event', event_type: 'observation' });

      // Verify transaction was used
      expect(mockDb.withTransactionAsync).toHaveBeenCalled();
      // Verify event was added with the transaction adapter
      expect(mockEventRepo.add).toHaveBeenCalledWith(
        expect.objectContaining({ summary: 'test event', entity_id: 'user_1' }),
        mockDb,
      );
    });

    it('normalizes unknown event_type strings to "observation"', async () => {
      // @ts-expect-error - intentionally passing an invalid type for runtime testing
      await writeService.write('user_1', { summary: 'invalid', event_type: 'magic_spell' });

      expect(mockEventRepo.add).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'observation' }),
        mockDb,
      );
    });
  });

  describe('Job Orchestration (Librarian & Heal)', () => {
    it('does NOT trigger the Librarian if the event count is below threshold', async () => {
      mockEventRepo.count.mockResolvedValue(15);
      mockMetadataRepo.getCheckpoint.mockResolvedValue({ memory: 0 }); // Delta = 15 (< 20)

      await writeService.write('user_1', { summary: 'test', event_type: 'observation' });

      expect(mockMaintenanceService.doRunLibrarian).not.toHaveBeenCalled();
      expect(mockJobManager.acquireLock).not.toHaveBeenCalled();
    });

    it('triggers the Librarian and updates checkpoint when threshold is met', async () => {
      mockEventRepo.count.mockResolvedValue(25);
      mockMetadataRepo.getCheckpoint.mockResolvedValue({ memory: 5 }); // Delta = 20 (>= 20)

      await writeService.write('user_1', { summary: 'test', event_type: 'observation' });

      // Ensure checkpoint was immediately bumped in the transaction to prevent duplicate runs
      expect(mockMetadataRepo.updateCheckpoint).toHaveBeenCalledWith('user_1', { memory: 25 }, mockDb);

      // Ensure job locks and execution occurred
      expect(mockJobManager.acquireLock).toHaveBeenCalledWith('librarian', 'user_1');
      expect(mockMaintenanceService.doRunLibrarian).toHaveBeenCalledWith('user_1');
    });

    it('triggers Auto-Heal if the Librarian runs and the heal threshold is met', async () => {
      mockEventRepo.count.mockResolvedValue(120);

      // First getCheckpoint (for librarian check): delta = 120 - 90 = 30 (>= 20 threshold)
      mockMetadataRepo.getCheckpoint.mockResolvedValueOnce({ memory: 90, heal: 0 });

      // Second getCheckpoint (read inside runLibrarianThenMaybeHeal): delta = 120 - 0 = 120 (>= 100 threshold)
      mockMetadataRepo.getCheckpoint.mockResolvedValueOnce({ memory: 120, heal: 0 });

      await writeService.write('user_1', { summary: 'test', event_type: 'observation' });

      // Drain microtasks from runLibrarianThenMaybeHeal; nextTick can run before those in Node.
      await new Promise<void>((r) => setImmediate(r));

      expect(mockMaintenanceService.doRunLibrarian).toHaveBeenCalled();
      expect(mockJobManager.tryAcquireAutoHealLock).toHaveBeenCalledWith('user_1');
      expect(mockMaintenanceService.doRunHeal).toHaveBeenCalledWith('user_1');
      expect(mockMetadataRepo.updateCheckpoint).toHaveBeenCalledWith('user_1', { heal: 120 }, mockDb);
    });
  });

  describe('Race Conditions & Error Handling', () => {
    it('rolls back the memory checkpoint if another thread acquires the lock first', async () => {
      mockEventRepo.count.mockResolvedValue(25);
      mockMetadataRepo.getCheckpoint.mockResolvedValue({ memory: 0 });

      // Simulate: isBlocked returned false, but by the time we call acquireLock, it's locked
      mockJobManager.acquireLock.mockImplementation(() => {
        throw new WikiBusyError('librarian', 'user_1');
      });

      await writeService.write('user_1', { summary: 'test', event_type: 'observation' });

      // Expect the catch block to roll the checkpoint back to what it was (0)
      expect(mockMetadataRepo.updateCheckpoint).toHaveBeenCalledWith('user_1', { memory: 0 }, mockDb);

      expect(mockMaintenanceService.doRunLibrarian).not.toHaveBeenCalled();
    });
  });

  describe('Input Validation', () => {
    it('clips an oversized summary to 4000 chars', async () => {
      await writeService.write('user_1', { summary: 'x'.repeat(10_000), event_type: 'observation' });

      const stored = mockEventRepo.add.mock.calls[0][0];
      expect(stored.summary.length).toBe(4000);
    });

    it('throws if summary is not a string', async () => {
      await expect(
        // @ts-expect-error - intentionally testing runtime guard against non-string input
        writeService.write('user_1', { summary: 123, event_type: 'observation' }),
      ).rejects.toThrow(/Invalid event\.summary/);
    });

    it('throws if event is null or not an object', async () => {
      await expect(
        // @ts-expect-error - intentionally testing runtime guard against null input
        writeService.write('user_1', null),
      ).rejects.toThrow(/Invalid event/);
    });

    it('throws for an entityId containing a null byte', async () => {
      await expect(
        writeService.write('bad\0id', { summary: 'ok', event_type: 'observation' }),
      ).rejects.toThrow(/Invalid entityId/);
    });

    it('throws for an empty entityId', async () => {
      await expect(
        writeService.write('', { summary: 'ok', event_type: 'observation' }),
      ).rejects.toThrow(/Invalid entityId/);
    });

    it('drops related_entry_id when it does not reference an existing fact for the entity', async () => {
      mockEntryRepo.findByIds.mockResolvedValue([]);

      await writeService.write('user_1', {
        summary: 'ok',
        event_type: 'observation',
        related_entry_id: 'nonexistent_fact',
      });

      expect(mockEntryRepo.findByIds).toHaveBeenCalledWith(['nonexistent_fact'], ['user_1']);
      const stored = mockEventRepo.add.mock.calls[0][0];
      expect(stored.related_entry_id).toBeNull();
    });

    it('keeps related_entry_id when it references an existing fact for the entity', async () => {
      mockEntryRepo.findByIds.mockResolvedValue([{ id: 'fact_1' }]);

      await writeService.write('user_1', {
        summary: 'ok',
        event_type: 'observation',
        related_entry_id: 'fact_1',
      });

      const stored = mockEventRepo.add.mock.calls[0][0];
      expect(stored.related_entry_id).toBe('fact_1');
    });

    it('drops related_entry_id when it is not a string', async () => {
      await writeService.write('user_1', {
        summary: 'ok',
        event_type: 'observation',
        // @ts-expect-error - intentionally testing runtime guard against non-string input
        related_entry_id: 123,
      });

      expect(mockEntryRepo.findByIds).not.toHaveBeenCalled();
      const stored = mockEventRepo.add.mock.calls[0][0];
      expect(stored.related_entry_id).toBeNull();
    });

    it('drops related_entry_id when it contains a null byte or exceeds 200 chars', async () => {
      await writeService.write('user_1', {
        summary: 'ok',
        event_type: 'observation',
        related_entry_id: 'bad\0id',
      });
      expect(mockEntryRepo.findByIds).not.toHaveBeenCalled();
      expect(mockEventRepo.add.mock.calls[0][0].related_entry_id).toBeNull();

      mockEventRepo.add.mockClear();

      await writeService.write('user_1', {
        summary: 'ok',
        event_type: 'observation',
        related_entry_id: 'x'.repeat(201),
      });
      expect(mockEntryRepo.findByIds).not.toHaveBeenCalled();
      expect(mockEventRepo.add.mock.calls[0][0].related_entry_id).toBeNull();
    });
  });
});
