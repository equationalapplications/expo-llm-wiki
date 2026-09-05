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
    // withTransactionAsync runs the callback with the adapter itself as the tx
    // handle: these unit tests assert call arguments, not commit semantics, and
    // the real rollback behaviour is covered against a live SQLite adapter in
    // __tests__/embeddingFailureMarkers.test.ts.
    mockDb = {
      withTransactionAsync: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
    };

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
      markEmbeddingFailure: vi.fn().mockResolvedValue(undefined),
      countStaleEmbeddings: vi.fn().mockResolvedValue(0),
      clearEmbeddingFailureMarkers: vi.fn().mockResolvedValue(0),
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

    it('clips the assembled text to 16,000 chars before calling embedFn', async () => {
      const fact = { id: 'f1', entity_id: 'e1', title: 'T'.repeat(20_000), body: '', tags: [] };

      await embeddingService.embedFact(fact);

      const calledWith = (mockOptions.llmProvider.embed as any).mock.calls[0][0] as string;
      expect(calledWith.length).toBeLessThanOrEqual(16_000);
    });
  });

  describe('tryEmbedFact (classified failures)', () => {
    const fact = { id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] };

    it('no_provider: returns kind and persists NO marker', async () => {
      // Service constructed without an embed fn.
      const providerWithoutEmbed = { generateText: vi.fn().mockResolvedValue('{}') };
      const noEmbedOptions: WikiOptions = {
        llmProvider: providerWithoutEmbed,
        vectorRanker: mockOptions.vectorRanker,
      };
      const svc = new EmbeddingService(mockDb as any, noEmbedOptions, mockEntryRepo, mockMetadataRepo);
      const res = await svc.tryEmbedFact(fact);
      expect(res).toEqual({ ok: false, kind: 'no_provider' });
      expect(mockEntryRepo.markEmbeddingFailure).not.toHaveBeenCalled();
      expect(mockEntryRepo.updateEmbeddingBlob).not.toHaveBeenCalled();
    });

    it('invalid_vector: empty array is classified and marked', async () => {
      mockOptions.llmProvider.embed!.mockResolvedValue([]);
      const res = await embeddingService.tryEmbedFact(fact);
      expect(res).toEqual({ ok: false, kind: 'invalid_vector' });
      expect(mockEntryRepo.markEmbeddingFailure).toHaveBeenCalledWith('f1', 'invalid_vector', expect.any(Number));
      expect(mockEntryRepo.updateEmbeddingBlob).not.toHaveBeenCalled();
    });

    it('float32_overflow: values beyond float32 range are classified and marked', async () => {
      // 1e39 is a finite double that overflows float32 — the pre-check
      // (every value is finite) passes, and the Float32Array conversion
      // turns it into +Infinity.
      mockOptions.llmProvider.embed!.mockResolvedValue([0.1, 1e39, 0.5]);
      const res = await embeddingService.tryEmbedFact(fact);
      expect(res).toEqual({ ok: false, kind: 'float32_overflow' });
      expect(mockEntryRepo.markEmbeddingFailure).toHaveBeenCalledWith('f1', 'float32_overflow', expect.any(Number));
      expect(mockEntryRepo.updateEmbeddingBlob).not.toHaveBeenCalled();
    });

    it('provider_error: a throwing embed is classified and marked', async () => {
      mockOptions.llmProvider.embed!.mockImplementation(async () => {
        throw new Error('503');
      });
      const res = await embeddingService.tryEmbedFact(fact);
      expect(res).toEqual({ ok: false, kind: 'provider_error' });
      expect(mockEntryRepo.markEmbeddingFailure).toHaveBeenCalledWith('f1', 'provider_error', expect.any(Number));
      expect(mockEntryRepo.updateEmbeddingBlob).not.toHaveBeenCalled();
    });

    it('storage_error: a failing blob write is classified but NOT marked', async () => {
      // Good vector from the provider, but the persistence layer throws.
      mockOptions.llmProvider.embed!.mockResolvedValue([0.1, 0.2, 0.3]);
      mockEntryRepo.updateEmbeddingBlob.mockRejectedValueOnce(new Error('disk full'));
      const res = await embeddingService.tryEmbedFact(fact);
      expect(res).toEqual({ ok: false, kind: 'storage_error' });
      // Storage errors do not write a marker — see spec D3.
      expect(mockEntryRepo.markEmbeddingFailure).not.toHaveBeenCalled();
    });

    it('storage_error: a failing dimension write is classified but NOT marked', async () => {
      // Good vector from the provider, but storeEmbeddingDimension's metadata
      // write throws. Same failure domain as the blob write (spec §4.3, D3).
      mockOptions.llmProvider.embed!.mockResolvedValue([0.1, 0.2, 0.3]);
      mockMetadataRepo.getMeta.mockResolvedValue(null);
      mockMetadataRepo.setMeta.mockRejectedValueOnce(new Error('meta write failed'));

      const res = await embeddingService.tryEmbedFact({ id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] });

      expect(res).toEqual({ ok: false, kind: 'storage_error' });
      expect(mockEntryRepo.markEmbeddingFailure).not.toHaveBeenCalled();
      expect(mockEntryRepo.updateEmbeddingBlob).not.toHaveBeenCalled();
    });

    it('success returns the dimension', async () => {
      mockOptions.llmProvider.embed!.mockResolvedValue([0.1, 0.2, 0.3]);
      const res = await embeddingService.tryEmbedFact(fact);
      expect(res).toEqual({ ok: true, dimension: 3 });
      expect(mockEntryRepo.markEmbeddingFailure).not.toHaveBeenCalled();
      expect(mockEntryRepo.updateEmbeddingBlob).toHaveBeenCalledWith('f1', expect.any(Uint8Array));
    });

    it('embedFact still returns plain booleans (delegates to tryEmbedFact)', async () => {
      await expect(embeddingService.embedFact(fact)).resolves.toBe(true);

      // Failing provider — embedFact returns false via delegation.
      const failingOptions: WikiOptions = {
        llmProvider: {
          generateText: vi.fn().mockResolvedValue('{}'),
          embed: vi.fn().mockImplementation(async () => {
            throw new Error('503');
          }),
        },
        vectorRanker: mockOptions.vectorRanker,
      };
      const failingSvc = new EmbeddingService(mockDb as any, failingOptions, mockEntryRepo, mockMetadataRepo);
      await expect(failingSvc.embedFact(fact)).resolves.toBe(false);
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

  describe('reconcileEmbeddingDimension marker reset (spec §2.3)', () => {
    it('clears markers when the new dimension is promoted', async () => {
      mockMetadataRepo.getMeta.mockResolvedValue('1536');
      mockEntryRepo.countStaleEmbeddings.mockResolvedValue(0);

      await embeddingService.reconcileEmbeddingDimension();

      expect(mockMetadataRepo.setMeta).toHaveBeenCalledWith('embedding_dimension', '1536', expect.anything());
      expect(mockMetadataRepo.clearDimensionMismatch).toHaveBeenCalled();
      expect(mockEntryRepo.clearEmbeddingFailureMarkers).toHaveBeenCalledTimes(1);
    });

    it('does NOT clear markers when promotion is blocked by residual stale rows', async () => {
      mockMetadataRepo.getMeta.mockResolvedValue('1536');
      mockEntryRepo.countStaleEmbeddings.mockResolvedValue(3);

      await embeddingService.reconcileEmbeddingDimension();

      expect(mockMetadataRepo.setMeta).not.toHaveBeenCalledWith('embedding_dimension', '1536', expect.anything());
      expect(mockEntryRepo.clearEmbeddingFailureMarkers).not.toHaveBeenCalled();
    });

    it('does NOT clear markers when no mismatch key is set', async () => {
      mockMetadataRepo.getMeta.mockResolvedValue(null);

      await embeddingService.reconcileEmbeddingDimension();

      expect(mockEntryRepo.clearEmbeddingFailureMarkers).not.toHaveBeenCalled();
    });
  });

  describe('non-callable embed provider (spec §2.4)', () => {
    it('returns no_provider and writes NO marker when embed is a truthy non-function', async () => {
      (mockOptions.llmProvider as any).embed = { not: 'a function' };
      const fact = { id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] };

      const res = await embeddingService.tryEmbedFact(fact);

      expect(res).toEqual({ ok: false, kind: 'no_provider' });
      expect(mockEntryRepo.markEmbeddingFailure).not.toHaveBeenCalled();
      expect(mockEntryRepo.updateEmbeddingBlob).not.toHaveBeenCalled();
    });

    it('still returns no_provider when embed is undefined', async () => {
      (mockOptions.llmProvider as any).embed = undefined;
      const fact = { id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [] };

      const res = await embeddingService.tryEmbedFact(fact);

      expect(res).toEqual({ ok: false, kind: 'no_provider' });
      expect(mockEntryRepo.markEmbeddingFailure).not.toHaveBeenCalled();
    });
  });
});
