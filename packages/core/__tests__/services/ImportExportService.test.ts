import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImportExportService } from '../../src/services/ImportExportService';
import type { MemoryDump, WikiFact } from '../../src/types';

describe('ImportExportService', () => {
  let mockDb: any;
  let mockEntryRepo: any;
  let mockTaskRepo: any;
  let mockEventRepo: any;
  let mockEdgeRepo: any;
  let mockMetadataRepo: any;
  let mockSearchService: any;
  let mockJobManager: any;
  let mockEmbeddingService: any;

  let importExportService: ImportExportService;

  beforeEach(() => {
    mockDb = {
      withTransactionAsync: vi.fn(async (cb) => await cb(mockDb)),
    };

    mockEntryRepo = {
      findAllByEntityId: vi.fn().mockResolvedValue([]),
      findAllByEntityIdWithBlobs: vi.fn().mockResolvedValue([]),
      findIdsBySource: vi.fn().mockResolvedValue([]),
      bulkSoftDeleteByEntityId: vi.fn().mockResolvedValue(undefined),
      findExistingMetadataByIds: vi.fn().mockResolvedValue([]),
      upsertForImport: vi.fn().mockResolvedValue(undefined),
      hasLegacySourceTypes: vi.fn().mockResolvedValue(false),
      countLegacySourceTypes: vi.fn().mockResolvedValue(0),
    };

    mockTaskRepo = {
      findAllByEntityId: vi.fn().mockResolvedValue([]),
      bulkSoftDeleteByEntityId: vi.fn().mockResolvedValue(undefined),
      findExistingMetadataByIds: vi.fn().mockResolvedValue([]),
      upsertForImport: vi.fn().mockResolvedValue(undefined),
    };

    mockEventRepo = {
      getByEntityId: vi.fn().mockResolvedValue([]),
      addIgnoreDuplicate: vi.fn().mockResolvedValue(undefined),
    };

    mockEdgeRepo = {
      getByEntityId: vi.fn().mockResolvedValue([]),
      addIgnoreDuplicate: vi.fn().mockResolvedValue(undefined),
      bulkDeleteByEntityId: vi.fn().mockResolvedValue(undefined),
    };

    mockMetadataRepo = {
      getDistinctEntityIds: vi.fn().mockResolvedValue(['user_1', 'user_2']),
      deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
      getMeta: vi.fn().mockResolvedValue(null),
      setMeta: vi.fn().mockResolvedValue(undefined),
      deleteMeta: vi.fn().mockResolvedValue(undefined),
    };

    mockSearchService = {
      sync: vi.fn().mockResolvedValue(undefined),
      evictCache: vi.fn(),
    };

    mockJobManager = {
      acquireImportLocks: vi.fn(),
      releaseImportLocks: vi.fn(),
    };

    mockEmbeddingService = {
      embedFact: vi.fn().mockResolvedValue(true),
      notifyEmbeddingPersisted: vi.fn().mockResolvedValue(undefined),
      storeEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
      reconcileEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
    };

    importExportService = new ImportExportService(
      mockDb,
      mockEntryRepo,
      mockTaskRepo,
      mockEventRepo,
      mockEdgeRepo,
      mockMetadataRepo,
      mockSearchService,
      mockJobManager,
      mockEmbeddingService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Exporting', () => {
    it('exports dumps with safe blob copies when requested', async () => {
      const mockBlob = new Uint8Array([0, 0, 128, 63]);
      mockEntryRepo.findAllByEntityIdWithBlobs.mockResolvedValue([
        { id: 'fact_1', entity_id: 'user_1', embedding_blob: mockBlob },
      ]);

      const dump = await importExportService.exportDump(['user_1']);

      expect(dump.entities['user_1']).toBeDefined();
      const exportedFact = dump.entities['user_1'].facts[0];

      expect(exportedFact.embedding_blob).toBeInstanceOf(Uint8Array);
      expect(exportedFact.embedding_blob).toEqual(mockBlob);
      expect(exportedFact.embedding_blob).not.toBe(mockBlob);
    });

    it('fetches all distinct entity IDs if none are provided', async () => {
      await importExportService.exportDump();

      expect(mockMetadataRepo.getDistinctEntityIds).toHaveBeenCalledTimes(1);
      expect(mockEntryRepo.findAllByEntityIdWithBlobs).toHaveBeenCalledWith('user_1');
      expect(mockEntryRepo.findAllByEntityIdWithBlobs).toHaveBeenCalledWith('user_2');
    });
  });

  describe('Importing: Validation and Merging', () => {
    let mockDump: MemoryDump;

    beforeEach(() => {
      mockDump = {
        generatedAt: Date.now(),
        entities: {
          user_1: {
            facts: [
              {
                id: 'fact_1',
                entity_id: 'user_1',
                title: 'Test',
                body: 'Body',
                source_type: 'user_stated',
                updated_at: 100,
              } as WikiFact,
            ],
            tasks: [],
            events: [], edges: [],
          },
        },
      };
    });

    it('rejects dumps with legacy source_types', async () => {
      // @ts-expect-error - Intentionally testing legacy/invalid enum values
      mockDump.entities['user_1'].facts[0].source_type = 'some_invalid_type';

      await expect(importExportService.importDump(mockDump)).rejects.toThrowError(
        /invalid source_type "some_invalid_type"/,
      );
    });

    it('normalizes legacy aliases like "user_document" to "immutable_document"', async () => {
      // @ts-expect-error - Intentionally testing pre-migration alias
      mockDump.entities['user_1'].facts[0].source_type = 'user_document';

      await importExportService.importDump(mockDump);

      expect(mockEntryRepo.upsertForImport).toHaveBeenCalledWith(
        expect.objectContaining({ source_type: 'immutable_document' }),
        mockDb,
      );
    });

    it('wipes existing facts in replace mode (merge: false)', async () => {
      await importExportService.importDump(mockDump, { merge: false });

      expect(mockEntryRepo.bulkSoftDeleteByEntityId).toHaveBeenCalledWith('user_1', mockDb);
      expect(mockEntryRepo.upsertForImport).toHaveBeenCalledTimes(1);
    });

    it('discards incoming facts if the existing DB row has a newer updated_at (LWW Merge)', async () => {
      mockEntryRepo.findExistingMetadataByIds.mockResolvedValue([
        { id: 'fact_1', entity_id: 'user_1', updated_at: 200 },
      ]);

      await importExportService.importDump(mockDump, { merge: true });

      expect(mockEntryRepo.bulkSoftDeleteByEntityId).not.toHaveBeenCalled();
      expect(mockEntryRepo.upsertForImport).not.toHaveBeenCalled();
      expect(mockEmbeddingService.embedFact).not.toHaveBeenCalled();
    });

    it('skips facts if a cross-entity collision is detected', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockEntryRepo.findExistingMetadataByIds.mockResolvedValue([
        { id: 'fact_1', entity_id: 'user_2', updated_at: 50 },
      ]);

      await importExportService.importDump(mockDump, { merge: true });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'already belongs to entity "user_2"; skipping for entity "user_1"',
        ),
      );
      expect(mockEntryRepo.upsertForImport).not.toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('applies LWW consistently for duplicate task ids in the same bundle (merge)', async () => {
      mockDump.entities['user_1'].facts = [];
      mockDump.entities['user_1'].tasks = [
        {
          id: 'task_1',
          entity_id: 'user_1',
          description: 'Newer',
          status: 'pending',
          priority: 1,
          created_at: 1,
          updated_at: 200,
          resolved_at: null,
          deleted_at: null,
        },
        {
          id: 'task_1',
          entity_id: 'user_1',
          description: 'Older duplicate in bundle',
          status: 'done',
          priority: 2,
          created_at: 2,
          updated_at: 100,
          resolved_at: null,
          deleted_at: null,
        },
      ];

      await importExportService.importDump(mockDump, { merge: true });

      expect(mockTaskRepo.upsertForImport).toHaveBeenCalledTimes(1);
      expect(mockTaskRepo.upsertForImport).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Newer', updated_at: 200 }),
        mockDb,
        200,
      );
    });

    it('escapes control characters in cross-entity collision warnings', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockDump.entities['user_1'].facts[0].entity_id = 'user_1\nINJECTED';
      mockEntryRepo.findExistingMetadataByIds.mockResolvedValue([
        { id: 'fact_1', entity_id: 'user_2\nINJECTED LOG LINE', updated_at: 50 },
      ]);

      await importExportService.importDump(mockDump, { merge: true });

      const message = consoleWarnSpy.mock.calls[0][0] as string;
      expect(message).not.toContain('\nINJECTED');
      expect(message).toContain('\\nINJECTED');

      consoleWarnSpy.mockRestore();
    });

    it('clips oversized title/body on import, and embeds the clipped text', async () => {
      mockDump.entities['user_1'].facts[0].title = 'T'.repeat(600);
      mockDump.entities['user_1'].facts[0].body = 'B'.repeat(9000);

      await importExportService.importDump(mockDump);

      const upserted = mockEntryRepo.upsertForImport.mock.calls[0][0];
      expect(upserted.title.length).toBe(500);
      expect(upserted.body.length).toBe(8000);

      expect(mockEmbeddingService.embedFact).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'T'.repeat(500),
          body: 'B'.repeat(8000),
        }),
      );
    });
  });

  describe('Importing: Blobs and Vectors', () => {
    it('preserves valid blobs and suppresses external embed calls', async () => {
      const rawBlob = new Uint8Array([0, 0, 128, 63, 0, 0, 0, 0]);

      const dumpWithBlob: MemoryDump = {
        generatedAt: Date.now(),
        entities: {
          user_1: {
            facts: [
              {
                id: 'fact_blob',
                entity_id: 'user_1',
                title: 'Has Blob',
                body: 'Text',
                source_type: 'user_stated',
                updated_at: 100,
                embedding_blob: rawBlob,
              } as unknown as WikiFact,
            ],
            tasks: [],
            events: [], edges: [],
          },
        },
      };

      await importExportService.importDump(dumpWithBlob);

      expect(mockEntryRepo.upsertForImport).toHaveBeenCalledTimes(1);
      const upserted = mockEntryRepo.upsertForImport.mock.calls[0][0];
      expect(upserted.embedding_blob).toBeInstanceOf(Uint8Array);
      expect([...upserted.embedding_blob]).toEqual([...rawBlob]);

      expect(mockEmbeddingService.embedFact).not.toHaveBeenCalled();

      expect(mockEmbeddingService.notifyEmbeddingPersisted).toHaveBeenCalledWith(
        'user_1',
        'fact_blob',
        expect.any(Float32Array),
      );

      expect(mockEmbeddingService.storeEmbeddingDimension).toHaveBeenCalledWith(2);
    });

    it('drops oversized embedding_blob data and still imports the fact', async () => {
      // 32KB cap = 8192 floats = 32768 bytes. One byte over the cap.
      const oversizedData = new Array(32769).fill(0);

      const dumpWithOversizedBlob: MemoryDump = {
        generatedAt: Date.now(),
        entities: {
          user_1: {
            facts: [
              {
                id: 'fact_big',
                entity_id: 'user_1',
                title: 'Big Blob',
                body: 'Text',
                source_type: 'user_stated',
                updated_at: 100,
                embedding_blob: { type: 'Buffer', data: oversizedData },
              } as unknown as WikiFact,
            ],
            tasks: [],
            events: [], edges: [],
          },
        },
      };

      await importExportService.importDump(dumpWithOversizedBlob);

      expect(mockEntryRepo.upsertForImport).toHaveBeenCalledTimes(1);
      const upserted = mockEntryRepo.upsertForImport.mock.calls[0][0];
      // Oversized blob is dropped, not stored.
      expect(upserted.embedding_blob).toBeUndefined();
      // Fact still imports and falls through to re-embed (no preserved blob).
      expect(mockEmbeddingService.embedFact).toHaveBeenCalled();
    });
  });

  describe('Importing: Edges', () => {
    it('fetches edges via getFullBundle', async () => {
      mockEdgeRepo.getByEntityId.mockResolvedValue([
        { id: 'edge_1', entity_id: 'user_1', source_id: 'fact_1', target_id: 'fact_2', edge_type: 'mentions', created_at: 100 },
      ]);

      const bundle = await importExportService.getFullBundle('user_1');

      expect(mockEdgeRepo.getByEntityId).toHaveBeenCalledWith('user_1');
      expect(bundle.edges).toHaveLength(1);
      expect(bundle.edges[0].edge_type).toBe('mentions');
    });

    it('wipes existing edges in replace mode (merge: false)', async () => {
      const dump = {
        generatedAt: Date.now(),
        entities: { user_1: { facts: [], tasks: [], events: [], edges: [] } },
      };

      await importExportService.importDump(dump, { merge: false });

      expect(mockEdgeRepo.bulkDeleteByEntityId).toHaveBeenCalledWith('user_1', mockDb);
    });

    it('does not wipe edges in merge mode (merge: true)', async () => {
      const dump = {
        generatedAt: Date.now(),
        entities: { user_1: { facts: [], tasks: [], events: [], edges: [] } },
      };

      await importExportService.importDump(dump, { merge: true });

      expect(mockEdgeRepo.bulkDeleteByEntityId).not.toHaveBeenCalled();
    });

    it('inserts each edge via addIgnoreDuplicate', async () => {
      const dump = {
        generatedAt: Date.now(),
        entities: {
          user_1: {
            facts: [],
            tasks: [],
            events: [],
            edges: [
              { id: 'edge_1', entity_id: 'spoofed_entity', source_id: 'a', target_id: 'b', edge_type: 'mentions', created_at: 100 },
              { id: 'edge_2', entity_id: 'user_1', source_id: 'b', target_id: 'c', edge_type: 'reports_to', created_at: 200 },
            ],
          },
        },
      };

      await importExportService.importDump(dump, { merge: true });

      expect(mockEdgeRepo.addIgnoreDuplicate).toHaveBeenCalledTimes(2);
      expect(mockEdgeRepo.addIgnoreDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'edge_1', edge_type: 'mentions', entity_id: 'user_1' }),
        mockDb,
      );
    });
  });
});
