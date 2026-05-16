import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import type { MemoryBundle, MemoryDump, SQLiteAdapter, WikiOptions } from '../src/types';

function createMockDb(): SQLiteAdapter {
  const mockDb = {
    runAsync: vi.fn().mockResolvedValue({ changes: 0, lastInsertRowId: 0 }),
    getAllAsync: vi.fn().mockResolvedValue([]),
    getFirstAsync: vi.fn().mockResolvedValue(null),
    withTransactionAsync: vi.fn(async (cb: (tx: SQLiteAdapter) => Promise<unknown>) => cb(mockDb as SQLiteAdapter)),
    execAsync: vi.fn().mockResolvedValue(undefined),
    closeAsync: vi.fn().mockResolvedValue(undefined),
  };
  return mockDb as SQLiteAdapter;
}

describe('WikiMemory (Facade Layer)', () => {
  let mockDb: SQLiteAdapter;
  let mockOptions: WikiOptions;
  let wiki: WikiMemory;

  beforeEach(() => {
    mockDb = createMockDb();
    mockOptions = {
      llmProvider: {
        generateText: vi.fn().mockResolvedValue('{}'),
        embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
      },
      config: { tablePrefix: 'test_' },
    };
    wiki = new WikiMemory(mockDb, mockOptions);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Service Delegation', () => {
    it('delegates read() to RetrievalService', async () => {
      const mockBundle: MemoryBundle = { facts: [], tasks: [], events: [] };
      const readSpy = vi
        .spyOn(wiki.__testAccess.retrievalService, 'read')
        .mockResolvedValue(mockBundle);

      const result = await wiki.read('user_123', 'test query', { maxResults: 5 });

      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(readSpy).toHaveBeenCalledWith('user_123', 'test query', { maxResults: 5 });
      expect(result).toBe(mockBundle);
    });

    it('delegates write() to WriteService', async () => {
      const writeSpy = vi.spyOn(wiki.__testAccess.writeService, 'write').mockResolvedValue(undefined);

      const mockEvent = { event_type: 'observation' as const, summary: 'test' };

      await wiki.write('user_123', mockEvent);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith('user_123', mockEvent);
    });

    it('delegates importDump() to ImportExportService', async () => {
      const importSpy = vi
        .spyOn(wiki.__testAccess.importExportService, 'importDump')
        .mockResolvedValue(undefined);

      const mockDump: MemoryDump = { generatedAt: Date.now(), entities: {} };

      await wiki.importDump(mockDump, { merge: true });

      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(importSpy).toHaveBeenCalledWith(mockDump, { merge: true });
    });

    it('delegates runPrune() to MaintenanceService', async () => {
      const pruneSpy = vi
        .spyOn(wiki.__testAccess.maintenanceService, 'runPrune')
        .mockResolvedValue({ entries: 1, tasks: 0, events: 5 });

      const result = await wiki.runPrune('user_123', { vacuum: true });

      expect(pruneSpy).toHaveBeenCalledTimes(1);
      expect(pruneSpy).toHaveBeenCalledWith('user_123', { vacuum: true });
      expect(result).toEqual({ entries: 1, tasks: 0, events: 5 });
    });
  });

  describe('Setup and Migrations', () => {
    it('detects fresh install and sets initial schema version without running upgrade migrations', async () => {
      const tableExistsSpy = vi.spyOn(wiki.__testAccess.metadataRepo, 'tableExists').mockResolvedValue(false);
      const setMetaSpy = vi.spyOn(wiki.__testAccess.metadataRepo, 'setMeta').mockResolvedValue(undefined);

      await wiki.setup();

      expect(tableExistsSpy).toHaveBeenCalledWith('test_entries');
      expect(setMetaSpy).toHaveBeenCalledWith(
        'schema_version',
        String(CURRENT_SCHEMA_VERSION),
        mockDb,
      );
    });

    it('throws an error if legacy source types are detected on an existing database', async () => {
      vi.spyOn(wiki.__testAccess.metadataRepo, 'tableExists').mockResolvedValue(true);
      vi.spyOn(wiki.__testAccess.metadataRepo, 'getMeta').mockImplementation(async (key: string) =>
        key === 'schema_version' ? String(CURRENT_SCHEMA_VERSION) : null,
      );
      vi.spyOn(wiki.__testAccess.entryRepo, 'hasLegacySourceTypes').mockResolvedValue(true);
      vi.spyOn(wiki.__testAccess.entryRepo, 'countLegacySourceTypes').mockResolvedValue(42);

      await expect(wiki.setup()).rejects.toThrowError(/Database contains 42 entries with legacy source_type values/);
    });
  });
});
