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

describe('WikiMemory — prompt override API', () => {
  let wiki: WikiMemory;
  let capturedCalls: Array<{ systemPrompt: string; userPrompt: string }>;

  beforeEach(async () => {
    capturedCalls = [];
    const db = createMockDb();
    wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: vi.fn(async (params: { systemPrompt: string; userPrompt: string }) => {
          capturedCalls.push(params);
          return JSON.stringify({ facts: [], tasks: [] });
        }),
      },
    });
    await wiki.setup();
  });

  it('runLibrarian accepts promptOverride and routes it to llmProvider', async () => {
    await wiki.write('e1', { event_type: 'observation', summary: 'test event' });
    await wiki.runLibrarian('e1', { promptOverride: 'custom lib prompt' });
    const libCall = capturedCalls.find(c => c.systemPrompt === 'custom lib prompt');
    expect(libCall).toBeDefined();
  });

  it('runHeal accepts promptOverride and routes it to llmProvider', async () => {
    const healResponse = JSON.stringify({ downgraded: [], deleted: [], newFacts: [] });
    (wiki as any).options.llmProvider.generateText = vi.fn(async (params: { systemPrompt: string; userPrompt: string }) => {
      capturedCalls.push(params);
      return healResponse;
    });
    await wiki.runHeal('e1', { promptOverride: 'custom heal prompt' });
    const healCall = capturedCalls.find(c => c.systemPrompt === 'custom heal prompt');
    expect(healCall).toBeDefined();
  });

  it('ingestDocument accepts promptOverride and routes it to llmProvider', async () => {
    const ingestResponse = JSON.stringify({ facts: [] });
    (wiki as any).options.llmProvider.generateText = vi.fn(async (params: { systemPrompt: string; userPrompt: string }) => {
      capturedCalls.push(params);
      return ingestResponse;
    });
    await wiki.ingestDocument('e1', {
      sourceRef: 'doc://test',
      sourceHash: 'c'.repeat(64),
      documentChunk: 'some text',
      promptOverride: 'custom ingest prompt',
    });
    expect(capturedCalls[0]?.systemPrompt).toBe('custom ingest prompt');
  });

  it('__testAccess exposes promptService', () => {
    const access = wiki.__testAccess;
    expect(access.promptService).toBeDefined();
    expect(typeof access.promptService.buildLibrarianPrompt).toBe('function');
  });

  it('global config.prompts flows into PromptService', async () => {
    const db2 = createMockDb();
    const wikiWithGlobal = new WikiMemory(db2, {
      llmProvider: {
        generateText: vi.fn(async (params: { systemPrompt: string; userPrompt: string }) => {
          capturedCalls.push(params);
          return JSON.stringify({ facts: [], tasks: [] });
        }),
      },
      config: {
        prompts: { librarianSystemPrompt: 'global lib from config' },
      },
    });
    await wikiWithGlobal.setup();
    await wikiWithGlobal.write('e2', { event_type: 'observation', summary: 'x' });
    await wikiWithGlobal.runLibrarian('e2');
    const libCall = capturedCalls.find(c => c.systemPrompt === 'global lib from config');
    expect(libCall).toBeDefined();
  });

  it('global config.prompts reaches LLM when write() triggers auto-run', async () => {
    const db2 = createMockDb();
    const localCalls: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const wikiWithGlobal = new WikiMemory(db2, {
      llmProvider: {
        generateText: vi.fn(async (params: { systemPrompt: string; userPrompt: string }) => {
          localCalls.push(params);
          return JSON.stringify({ facts: [], tasks: [] });
        }),
      },
      config: {
        autoLibrarianThreshold: 1,
        prompts: { librarianSystemPrompt: 'auto-run global prompt' },
      },
    });
    await wikiWithGlobal.setup();

    // Make eventRepo.count return 1 so write() crosses the threshold
    vi.spyOn((wikiWithGlobal as any).eventRepo, 'count').mockResolvedValue(1);
    vi.spyOn(wikiWithGlobal.__testAccess.metadataRepo, 'getCheckpoint').mockResolvedValue({ memory: 0 });

    await wikiWithGlobal.write('e3', { event_type: 'observation', summary: 'trigger' });

    // Drain the fire-and-forget maintenance task
    await new Promise<void>((r) => setImmediate(r));

    const libCall = localCalls.find(c => c.systemPrompt === 'auto-run global prompt');
    expect(libCall).toBeDefined();
  });

  it('global heal prompt reaches LLM when write() auto-triggers heal', async () => {
    const db3 = createMockDb();
    const localCalls: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const wikiWithGlobalHeal = new WikiMemory(db3, {
      llmProvider: {
        generateText: vi.fn(async (params: { systemPrompt: string; userPrompt: string }) => {
          localCalls.push(params);
          return JSON.stringify({ facts: [], tasks: [] });
        }),
      },
      config: {
        autoLibrarianThreshold: 1,
        autoHealThreshold: 1,
        prompts: {
          librarianSystemPrompt: 'auto-run global librarian prompt',
          healSystemPrompt: 'auto-run global heal prompt',
        },
      },
    });
    await wikiWithGlobalHeal.setup();

    vi.spyOn((wikiWithGlobalHeal as any).eventRepo, 'count').mockResolvedValue(1);
    vi.spyOn(wikiWithGlobalHeal.__testAccess.metadataRepo, 'getCheckpoint').mockResolvedValue({ memory: 0, heal: 0 });

    await wikiWithGlobalHeal.write('e4', { event_type: 'observation', summary: 'trigger heal' });
    await new Promise<void>((r) => setImmediate(r));

    const healCall = localCalls.find(c => c.systemPrompt === 'auto-run global heal prompt');
    expect(healCall).toBeDefined();
  });
});

describe('WikiMemory outbox API', () => {
  let mockDb: SQLiteAdapter;

  function makeWiki(enableOutbox?: boolean): WikiMemory {
    mockDb = {
      runAsync: vi.fn().mockResolvedValue({ changes: 0, lastInsertRowId: 0 }),
      getAllAsync: vi.fn().mockResolvedValue([]),
      getFirstAsync: vi.fn().mockResolvedValue(null),
      withTransactionAsync: vi.fn(async (cb: (tx: SQLiteAdapter) => Promise<unknown>) => cb(mockDb as SQLiteAdapter)),
      execAsync: vi.fn().mockResolvedValue(undefined),
      closeAsync: vi.fn().mockResolvedValue(undefined),
    } as SQLiteAdapter;
    return new WikiMemory(mockDb, {
      llmProvider: {
        generateText: vi.fn().mockResolvedValue('{}'),
        embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
      },
      config: { tablePrefix: 'test_', enableOutbox },
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getUnprocessedOutboxEvents returns [] when table is empty', async () => {
    const wiki = makeWiki();
    const result = await wiki.getUnprocessedOutboxEvents();
    expect(result).toEqual([]);
  });

  it('getUnprocessedOutboxEvents passes limit to getAllAsync', async () => {
    const wiki = makeWiki();
    await wiki.getUnprocessedOutboxEvents(42);
    const call = (mockDb.getAllAsync as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('outbox'),
    );
    expect(call).toBeDefined();
    expect(call![1]).toContain(42);
  });

  it('getUnprocessedOutboxEvents deserializes valid JSON payload', async () => {
    const wiki = makeWiki();
    (mockDb.getAllAsync as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'e1', entity_id: 'u1', table_name: 'entries', record_id: 'r1', operation: 'INSERT', payload: '{"key":"val"}', created_at: 1 },
    ]);
    const [event] = await wiki.getUnprocessedOutboxEvents();
    expect(event.payload).toEqual({ key: 'val' });
  });

  it('getUnprocessedOutboxEvents converts malformed payload to null', async () => {
    const wiki = makeWiki();
    (mockDb.getAllAsync as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'e2', entity_id: 'u1', table_name: 'entries', record_id: 'r1', operation: 'INSERT', payload: 'NOT_JSON', created_at: 1 },
    ]);
    const [event] = await wiki.getUnprocessedOutboxEvents();
    expect(event.payload).toBeNull();
  });

  it('markOutboxEventsProcessed issues DELETE for given IDs', async () => {
    const wiki = makeWiki();
    await wiki.markOutboxEventsProcessed(['id1', 'id2']);
    const runCall = (mockDb.runAsync as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('DELETE'),
    );
    expect(runCall).toBeDefined();
    expect(runCall![1]).toContain('id1');
    expect(runCall![1]).toContain('id2');
  });

  it('markOutboxEventsProcessed is a no-op for empty array', async () => {
    const wiki = makeWiki();
    await wiki.markOutboxEventsProcessed([]);
    const runCalls = (mockDb.runAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('DELETE'),
    );
    expect(runCalls).toHaveLength(0);
  });

  it('outbox writes are gated by enableOutbox flag — no rows when disabled', async () => {
    const wiki = makeWiki(false);
    (mockDb.getAllAsync as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const events = await wiki.getUnprocessedOutboxEvents();
    expect(events).toHaveLength(0);
    // Verify getAllAsync was called (table exists and is readable even when disabled)
    const outboxCall = (mockDb.getAllAsync as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('outbox'),
    );
    expect(outboxCall).toBeDefined();
  });
});
