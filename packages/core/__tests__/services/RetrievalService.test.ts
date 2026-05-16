import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetrievalService } from '../../src/services/RetrievalService';
import type { WikiFact, WikiOptions } from '../../src/types';

function minimalFact(overrides: Partial<WikiFact> & Pick<WikiFact, 'id' | 'entity_id'>): WikiFact {
  return {
    title: 't',
    body: 'b',
    tags: [],
    confidence: 'inferred',
    source_type: 'librarian_inferred',
    source_hash: null,
    source_ref: null,
    created_at: 0,
    updated_at: 0,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    ...overrides,
  };
}

describe('RetrievalService', () => {
  let mockOptions: WikiOptions;
  let mockEntryRepo: any;
  let mockTaskRepo: any;
  let mockEventRepo: any;
  let mockMetadataRepo: any;
  let mockSearchService: any;
  let retrievalService: RetrievalService;

  beforeEach(() => {
    mockEntryRepo = {
      findRecentByEntityIds: vi.fn().mockResolvedValue([]),
      countDimensionMismatched: vi.fn().mockResolvedValue(0),
      findWithEmbeddingsByEntityIds: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
      trackAccess: vi.fn().mockResolvedValue(undefined),
    };

    mockTaskRepo = {
      findAllPending: vi.fn().mockResolvedValue([]),
    };

    mockEventRepo = {
      getRecent: vi.fn().mockResolvedValue([]),
      getRecentForEntities: vi.fn().mockResolvedValue([]),
    };

    mockMetadataRepo = {
      getMeta: vi.fn().mockResolvedValue(null),
    };

    mockSearchService = {
      searchKeyword: vi.fn().mockReturnValue([]),
      rankSemantic: vi.fn().mockResolvedValue([]),
      getMiniSearchScores: vi.fn().mockReturnValue(new Map()),
    };

    mockOptions = {
      config: { maxResults: 10 },
      llmProvider: {
        generateText: vi.fn().mockResolvedValue('{}'),
        embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
      },
      onRetrievalFallback: vi.fn(),
    };

    retrievalService = new RetrievalService(
      mockOptions,
      mockEntryRepo,
      mockTaskRepo,
      mockEventRepo,
      mockMetadataRepo,
      mockSearchService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Validation and Fast Paths', () => {
    it('returns an empty bundle when no entity IDs are provided', async () => {
      const result = await retrievalService.read([], 'query');

      expect(result).toEqual({
        facts: [],
        tasks: [],
        events: [],
        metadata: { query: 'query', entityIds: [] },
      });
      expect(mockOptions.llmProvider.embed).not.toHaveBeenCalled();
    });

    it('throws a RangeError if more than 100 entities are requested', async () => {
      const tooManyIds = Array.from({ length: 101 }, (_, i) => `user_${i}`);
      await expect(retrievalService.read(tooManyIds, 'query')).rejects.toThrow(RangeError);
    });

    it('bypasses search and returns recency-based facts for an empty query', async () => {
      const mockRecentFacts = [minimalFact({ id: 'fact_1', entity_id: 'user_1' })];
      mockEntryRepo.findRecentByEntityIds.mockResolvedValue(mockRecentFacts);

      const result = await retrievalService.read('user_1', '   ');

      expect(mockOptions.llmProvider.embed).not.toHaveBeenCalled();
      expect(mockEntryRepo.findRecentByEntityIds).toHaveBeenCalledWith(['user_1'], 10);
      expect(result.facts).toEqual(mockRecentFacts);
    });

    it('skips database retrieval entirely if maxResults is 0', async () => {
      const result = await retrievalService.read('user_1', 'hello', { maxResults: 0 });

      expect(mockOptions.llmProvider.embed).not.toHaveBeenCalled();
      expect(mockSearchService.rankSemantic).not.toHaveBeenCalled();
      expect(mockEntryRepo.findByIds).not.toHaveBeenCalled();
      expect(result.facts).toEqual([]);
    });
  });

  describe('Vector Search and Fallbacks', () => {
    it('falls back to keyword search if embed() throws an error', async () => {
      mockOptions.llmProvider.embed = vi.fn().mockRejectedValue(new Error('API Rate Limit'));

      mockSearchService.searchKeyword.mockReturnValue([
        { id: 'fact_fallback', score: 0.9, entity_id: 'user_1' },
      ]);
      mockEntryRepo.findByIds.mockResolvedValue([
        minimalFact({ id: 'fact_fallback', entity_id: 'user_1', body: 'fallback text' }),
      ]);

      const result = await retrievalService.read('user_1', 'test query');

      expect(mockOptions.onRetrievalFallback).toHaveBeenCalledWith(expect.any(Error));
      expect(mockSearchService.searchKeyword).toHaveBeenCalled();
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].id).toBe('fact_fallback');
    });

    it('forces keyword fallback if stored embeddings have a mismatched dimension', async () => {
      mockMetadataRepo.getMeta.mockImplementation(async (key: string) =>
        key === 'embedding_dimension' ? null : null,
      );
      mockEntryRepo.countDimensionMismatched.mockResolvedValue(5);

      await retrievalService.read('user_1', 'test query');

      expect(mockOptions.llmProvider.embed).toHaveBeenCalled();
      expect(mockSearchService.rankSemantic).not.toHaveBeenCalled();
      expect(mockSearchService.searchKeyword).toHaveBeenCalled();
      expect(mockOptions.onRetrievalFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('rebuild all embeddings consistently'),
        }),
      );
    });
  });

  describe('Tie-Breaking and Sorting', () => {
    it('sorts identically scored results deterministically', () => {
      const items = [
        { id: 'c', score: 0.5, access_count: 5, updated_at: 100 },
        { id: 'b', score: 0.5, access_count: 5, updated_at: 200 },
        { id: 'a', score: 0.5, access_count: 10, updated_at: 100 },
        { id: 'd', score: 0.9, access_count: 0, updated_at: 0 },
      ];

      (retrievalService as any)._tieBreakSort(items);

      expect(items.map(i => i.id)).toEqual(['d', 'a', 'b', 'c']);
    });
  });

  describe('Tier Weights', () => {
    it('applies tier weights to semantic scores to reorder results', async () => {
      const rows = [
        {
          id: 'fact_user1',
          entity_id: 'user_1',
          updated_at: 0,
          access_count: 0,
          embedding_blob: null,
          embedding: null,
        },
        {
          id: 'fact_user2',
          entity_id: 'user_2',
          updated_at: 0,
          access_count: 0,
          embedding_blob: null,
          embedding: null,
        },
      ];
      mockEntryRepo.findWithEmbeddingsByEntityIds.mockResolvedValue(rows);

      mockSearchService.rankSemantic.mockResolvedValue([
        { id: 'fact_user2', entity_id: 'user_2', score: 0.9, updated_at: null, access_count: null },
        { id: 'fact_user1', entity_id: 'user_1', score: 0.6, updated_at: null, access_count: null },
      ]);

      mockEntryRepo.findByIds.mockImplementation(async (ids: string[]) =>
        ids.map(id => {
          const entity_id = id.includes('user_1') ? 'user_1' : 'user_2';
          return minimalFact({ id, entity_id, body: 'text' });
        }),
      );

      const result = await retrievalService.read(['user_1', 'user_2'], 'test', {
        tierWeights: {
          user_1: 2.0,
          user_2: 0.5,
        },
      });

      expect(result.facts[0].id).toBe('fact_user1');
      expect(result.facts[1].id).toBe('fact_user2');
    });
  });
});
