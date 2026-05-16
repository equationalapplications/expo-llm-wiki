import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingService } from '../../src/services/EmbeddingService';
import { HOOK_TIMEOUT_MARKER } from '../../src/types';
import type { WikiOptions } from '../../src/types';

describe('EmbeddingService', () => {
  let mockDb: unknown;
  let mockOptions: WikiOptions;
  let mockEntryRepo: any;
  let mockMetadataRepo: any;
  let embeddingService: EmbeddingService;

  beforeEach(() => {
    mockDb = {}; // Pass-through for tx queries

    mockOptions = {
      llmProvider: {
        generateText: vi.fn().mockResolvedValue('{}'),
        embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
      },
      vectorRanker: {
        onEmbeddingPersisted: vi.fn().mockResolvedValue(undefined),
      },
      deletionHookTimeoutMs: 100, // Short timeout for testing race conditions
    };

    mockEntryRepo = {
      updateEmbeddingBlob: vi.fn().mockResolvedValue(undefined),
      countStaleEmbeddings: vi.fn().mockResolvedValue(0),
    };

    mockMetadataRepo = {
      getMeta: vi.fn().mockResolvedValue(null),
      setMeta: vi.fn().mockResolvedValue(undefined),
      clearDimensionMismatch: vi.fn().mockResolvedValue(undefined),
    };

    embeddingService = new EmbeddingService(mockDb as any, mockOptions, mockEntryRepo, mockMetadataRepo);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('embedFact (Vector Validation)', () => {
    it('successfully embeds and persists a valid float vector', async () => {
      const fact = { id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] };
      const result = await embeddingService.embedFact(fact);

      expect(result).toBe(true);
      expect(mockOptions.llmProvider.embed).toHaveBeenCalledWith('T B');
      expect(mockEntryRepo.updateEmbeddingBlob).toHaveBeenCalledWith('f1', expect.any(Uint8Array));
      // Ensure external sync hook fired
      expect(mockOptions.vectorRanker!.onEmbeddingPersisted).toHaveBeenCalled();
    });

    it('rejects and returns false if the vector contains NaN', async () => {
      mockOptions.llmProvider.embed!.mockResolvedValue([0.1, NaN, 0.5]);
      const fact = { id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] };

      const result = await embeddingService.embedFact(fact);

      expect(result).toBe(false);
      expect(mockEntryRepo.updateEmbeddingBlob).not.toHaveBeenCalled();
    });

    it('rejects and returns false if the vector contains Infinity', async () => {
      mockOptions.llmProvider.embed!.mockResolvedValue([0.1, Infinity, 0.5]);
      const fact = { id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] };

      const result = await embeddingService.embedFact(fact);

      expect(result).toBe(false);
      expect(mockEntryRepo.updateEmbeddingBlob).not.toHaveBeenCalled();
    });

    it('rejects and returns false if the vector is empty', async () => {
      mockOptions.llmProvider.embed!.mockResolvedValue([]);
      const result = await embeddingService.embedFact({ id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] });
      expect(result).toBe(false);
    });
  });

  describe('Dimension Tracking', () => {
    it('sets dimension mismatch if the embedded dimension differs from the canonical DB dimension', async () => {
      mockMetadataRepo.getMeta.mockImplementation(async (key: string) =>
        key === 'embedding_dimension' ? '1024' : null,
      );
      // mockOptions embed returns 1536 by default

      await embeddingService.embedFact({ id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] });

      expect(mockMetadataRepo.setMeta).toHaveBeenCalledWith(
        'embedding_dimension_mismatch',
        '1536',
        mockDb,
      );
    });

    it('clears dimension mismatch during reconciliation if no stale embeddings remain', async () => {
      mockMetadataRepo.getMeta.mockResolvedValue('1536'); // Current mismatch value
      mockEntryRepo.countStaleEmbeddings.mockResolvedValue(0);

      await embeddingService.reconcileEmbeddingDimension();

      // Promotes mismatch to canonical
      expect(mockMetadataRepo.setMeta).toHaveBeenCalledWith('embedding_dimension', '1536', mockDb);
      expect(mockMetadataRepo.clearDimensionMismatch).toHaveBeenCalledWith(mockDb);
    });

    it('does NOT clear dimension mismatch if stale embeddings still exist', async () => {
      mockMetadataRepo.getMeta.mockResolvedValue('1536');
      mockEntryRepo.countStaleEmbeddings.mockResolvedValue(5);

      await embeddingService.reconcileEmbeddingDimension();

      expect(mockMetadataRepo.clearDimensionMismatch).not.toHaveBeenCalled();
    });
  });

  describe('Hook Resilience (notifyEmbeddingPersistedOrThrow)', () => {
    it(
      'throws a timeout error if the hook takes too long',
      async () => {
        mockOptions.vectorRanker!.onEmbeddingPersisted!.mockImplementation(
          () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
        );

        let caught: unknown;
        try {
          await embeddingService.notifyEmbeddingPersistedOrThrow(
            'e1',
            'f1',
            new Float32Array([0.1]),
          );
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toMatch(/timed out/);
        expect((caught as any)[HOOK_TIMEOUT_MARKER]).toBe(true);
      },
      2000,
    );

    it('captures synchronous hook throws without leaving an unhandled timeout promise', async () => {
      mockOptions.vectorRanker!.onEmbeddingPersisted!.mockImplementation(() => {
        throw new Error('sync hook failure');
      });

      await expect(
        embeddingService.notifyEmbeddingPersistedOrThrow('e1', 'f1', new Float32Array([0.1]))
      ).rejects.toThrow('sync hook failure');
    });

    it('bypasses the hook if forceDeleteIgnoreRankerHook is true', async () => {
      mockOptions.forceDeleteIgnoreRankerHook = true;

      await embeddingService.notifyEmbeddingPersistedOrThrow('e1', 'f1', null);

      expect(mockOptions.vectorRanker!.onEmbeddingPersisted).not.toHaveBeenCalled();
    });
  });
});
