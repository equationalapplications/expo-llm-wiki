import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions, MemoryDump, VectorRanker, VectorRankerSemanticResult, VectorRankerRankArgs } from '../src/types';

function makeDump(facts: Array<{ id: string; title: string; body: string }>): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      'user-1': {
        facts: facts.map((f, i) => ({
          id: f.id,
          entity_id: 'user-1',
          title: f.title,
          body: f.body,
          tags: [],
          confidence: 'certain' as const,
          source_type: 'user_stated' as const,
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: (i + 1) * 1000,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        })),
        tasks: [],
        events: [],
      },
    },
  };
}

// Deterministic embed: maps keyword in text to a unit vector in 3D space.
function keywordEmbed(text: string): number[] {
  if (text.includes('apple')) return [1, 0, 0];
  if (text.includes('car')) return [0, 1, 0];
  return [0, 0, 1];
}

describe('VectorRanker integration', () => {
  describe('Default behavior without ranker', () => {
    it('should use JS cosine similarity when vectorRanker is not provided', async () => {
      const db = openTestDatabase();
      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
      ]));

      const result = await wiki.read('user-1', 'apple');
      expect(result.facts[0].id).toBe('fact-a');
    });
  });

  describe('Injection and ranking', () => {
    it('should use vectorRanker when present and respect its scores', async () => {
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async (args: VectorRankerRankArgs) => {
          // Return fixed scores: fact-b scores higher than fact-a
          const results: VectorRankerSemanticResult[] = [
            { id: 'fact-b', semanticScore: 0.9 },
            { id: 'fact-a', semanticScore: 0.3 },
          ];
          return results;
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
      ]));

      const result = await wiki.read('user-1', 'apple');
      // fact-b should rank first due to higher ranker score
      expect(result.facts[0].id).toBe('fact-b');
    });

    it('should apply tie-break sorting after ranker scores', async () => {
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          // Both facts get same score
          return [
            { id: 'fact-a', semanticScore: 0.5 },
            { id: 'fact-b', semanticScore: 0.5 },
          ];
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
      ]));

      // Update fact-b to have higher access_count for tie-breaking
      await db.runAsync(
        `UPDATE llm_wiki_entries SET access_count = 10 WHERE id = 'fact-b'`
      );

      const result = await wiki.read('user-1', 'test');
      // With equal scores, fact-b should rank first due to higher access_count
      expect(result.facts[0].id).toBe('fact-b');
    });

    it('should blend ranker scores with keyword scores when hybridWeight is set', async () => {
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          return [
            { id: 'fact-a', semanticScore: 1.0 },
            { id: 'fact-b', semanticScore: 0.0 },
          ];
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'body' },
        { id: 'fact-b', title: 'car vehicle fast', body: 'body' },
      ]));

      // With hybridWeight=0.5, keyword and semantic scores are equally weighted
      // fact-b has strong keyword match for 'car', fact-a has strong semantic
      const result = await wiki.read('user-1', 'car', { hybridWeight: 0.5 });

      // fact-b should win due to keyword match compensating for low semantic score
      expect(result.facts[0].id).toBe('fact-b');
    });

    it('should handle partial ranker results (omitted ids)', async () => {
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          // Only return fact-a, omit fact-b
          return [{ id: 'fact-a', semanticScore: 0.8 }];
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast' },
      ]));

      const result = await wiki.read('user-1', 'test');
      // fact-a ranked first (ranker score 0.8), fact-b gets fallback score -2 (no embedding)
      expect(result.facts.length).toBeGreaterThanOrEqual(2);
      expect(result.facts[0].id).toBe('fact-a');
      const factBIdx = result.facts.findIndex(f => f.id === 'fact-b');
      expect(factBIdx).toBeGreaterThan(0);
    });

    it('should allow unembedded fact to win via keyword score in hybrid mode even when ranker returns maxResults', async () => {
      // Regression test: when ranker returns >= maxResults results, backfill logic
      // must still admit unembedded rows in hybrid mode so they can compete via keyword weight.
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async ({ limit }) => {
          // Return exactly maxResults (10) semantic results, omitting the unembedded fact.
          // All have low semantic scores so keyword weight dominates in hybrid blend.
          const results: VectorRankerSemanticResult[] = [];
          for (let i = 0; i < limit; i++) {
            results.push({ id: `filler-${i}`, semanticScore: 0.1 });
          }
          return results;
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        config: { maxResults: 10 },
      });
      await wiki.setup();

      // Import 10 filler facts (embeddings exist, ranker will return them) + 1 unembedded fact
      const facts = [];
      for (let i = 0; i < 10; i++) {
        facts.push({ id: `filler-${i}`, title: `noise ${i}`, body: 'irrelevant' });
      }
      facts.push({ id: 'keyword-winner', title: 'perfect exact match keyword winner', body: 'body' });
      await wiki.importDump(makeDump(facts));

      // Delete the embedding for 'keyword-winner' to simulate unembedded fact
      await db.runAsync(
        "UPDATE llm_wiki_entries SET embedding_blob = NULL, embedding = NULL WHERE id = 'keyword-winner'"
      );

      // Query with strong keyword match + hybrid mode (70% keyword, 30% semantic)
      const result = await wiki.read('user-1', 'perfect exact match keyword winner', {
        hybridWeight: 0.3,
        maxResults: 10,
      });

      // The unembedded 'keyword-winner' fact should rank first via (1-0.3)*kwScore,
      // beating the 10 filler facts with semanticScore=0.1 each.
      expect(result.facts[0].id).toBe('keyword-winner');
    });
  });

  describe('Pre-filter integration', () => {
    it('should pass candidateIds to ranker when preFilterLimit is set', async () => {
      const db = openTestDatabase();
      const rankBySimilarity = vi.fn(async (args: VectorRankerRankArgs) => {
        return args.candidateIds
          ? args.candidateIds.map(id => ({ id, semanticScore: 0.5 }))
          : [];
      });

      const mockRanker: VectorRanker = { rankBySimilarity };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast' },
        { id: 'fact-c', title: 'banana fruit', body: 'yellow' },
      ]));

      await wiki.read('user-1', 'fruit', { preFilterLimit: 2 });

      expect(rankBySimilarity).toHaveBeenCalled();
      const args = rankBySimilarity.mock.calls[0][0];
      expect(args.candidateIds).toBeDefined();
      expect(args.candidateIds?.length).toBeLessThanOrEqual(2);
    });

    it('should omit candidateIds when preFilterLimit is not set (full scan)', async () => {
      const db = openTestDatabase();
      const rankBySimilarity = vi.fn(async (args: VectorRankerRankArgs) => {
        return [{ id: 'fact-a', semanticScore: 0.5 }];
      });

      const mockRanker: VectorRanker = { rankBySimilarity };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'body' },
      ]));

      await wiki.read('user-1', 'test');

      expect(rankBySimilarity).toHaveBeenCalled();
      const args = rankBySimilarity.mock.calls[0][0];
      expect(args.candidateIds).toBeUndefined();
    });
  });

  describe('Dimension mismatch', () => {
    it('should not invoke ranker when dimension mismatch detected', async () => {
      const db = openTestDatabase();
      const rankBySimilarity = vi.fn();
      const onRetrievalFallback = vi.fn();
      const mockRanker: VectorRanker = { rankBySimilarity };

      // Set up with 3D embeddings
      const wikiInitial = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
      });
      await wikiInitial.setup();
      await wikiInitial.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'body' },
      ]));
      await wikiInitial.runReembed('user-1');

      // Create new instance with different dimension + ranker
      const wikiNewModel = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async () => [0.1, 0.2, 0.3, 0.4], // 4D instead of 3D
        },
        vectorRanker: mockRanker,
        onRetrievalFallback,
      });
      await wikiNewModel.setup();

      await wikiNewModel.read('user-1', 'test');

      // Ranker should NOT be called due to dimension mismatch
      expect(rankBySimilarity).not.toHaveBeenCalled();
      // Should fall back to keyword search and invoke onRetrievalFallback
      expect(onRetrievalFallback).toHaveBeenCalled();
    });
  });

  describe('VectorRanker failure policies', () => {
    it('should fall back to js-cosine when vectorRanker throws (default policy)', async () => {
      const db = openTestDatabase();
      const onVectorRankerFallback = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          throw new Error('Ranker service unavailable');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        onVectorRankerFallback,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
      ]));

      const result = await wiki.read('user-1', 'apple');

      // Should fall back to JS cosine and return correct results
      expect(result.facts[0].id).toBe('fact-a');
      expect(onVectorRankerFallback).toHaveBeenCalledWith({
        error: expect.any(Error),
        policy: 'js-cosine',
      });
    });

    it('should correctly re-fetch embeddings for js-cosine fallback in pure-semantic mode', async () => {
      // Pure-semantic (hybridWeight: 1) means keyword scores are irrelevant.
      // If embedding re-fetch is broken, both facts score -2 and alphabetical id
      // tie-break returns 'fact-a-car' first. If re-fetch works, cosine similarity
      // returns 'fact-z-apple' first for query "apple".
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          throw new Error('Ranker service unavailable');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        config: { hybridWeight: 1 },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-z-apple', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-a-car', title: 'car vehicle', body: 'fast engine' },
      ]));

      const result = await wiki.read('user-1', 'apple');

      // Semantic match: 'fact-z-apple' must rank above 'fact-a-car' even though
      // alphabetical id tie-break would flip the order if embeddings were missing.
      expect(result.facts[0].id).toBe('fact-z-apple');
    });

    it('should fall back to keyword-only when policy is "keyword"', async () => {
      const db = openTestDatabase();
      const onVectorRankerFallback = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          throw new Error('Ranker service unavailable');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        vectorRankerFallback: 'keyword',
        onVectorRankerFallback,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
      ]));

      const result = await wiki.read('user-1', 'apple');

      // Should fall back to keyword search
      expect(result.facts.length).toBeGreaterThan(0);
      expect(onVectorRankerFallback).toHaveBeenCalledWith({
        error: expect.any(Error),
        policy: 'keyword',
      });
    });

    it('should return empty results when policy is "empty"', async () => {
      const db = openTestDatabase();
      const onVectorRankerFallback = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          throw new Error('Ranker service unavailable');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        vectorRankerFallback: 'empty',
        onVectorRankerFallback,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
      ]));

      const result = await wiki.read('user-1', 'apple');

      // Should return empty results
      expect(result.facts).toHaveLength(0);
      expect(onVectorRankerFallback).toHaveBeenCalledWith({
        error: expect.any(Error),
        policy: 'empty',
      });
    });

    it('should throw when policy is "throw"', async () => {
      const db = openTestDatabase();
      const onVectorRankerFallback = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          throw new Error('Ranker service unavailable');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        vectorRankerFallback: 'throw',
        onVectorRankerFallback,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      // Should throw the ranker error
      await expect(wiki.read('user-1', 'apple')).rejects.toThrow('Ranker service unavailable');
      expect(onVectorRankerFallback).toHaveBeenCalledWith({
        error: expect.any(Error),
        policy: 'throw',
      });
    });

    it('should invoke onRetrievalFallback when propagateRankerFailureToRetrievalFallback is true', async () => {
      const db = openTestDatabase();
      const onVectorRankerFallback = vi.fn();
      const onRetrievalFallback = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          throw new Error('Ranker service unavailable');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        vectorRankerFallback: 'keyword',
        propagateRankerFailureToRetrievalFallback: true,
        onVectorRankerFallback,
        onRetrievalFallback,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.read('user-1', 'apple');

      // Both callbacks should be invoked
      expect(onVectorRankerFallback).toHaveBeenCalled();
      expect(onRetrievalFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Vector ranker failed, falling back',
          cause: expect.any(Error),
        })
      );
    });

    it('should not invoke onRetrievalFallback when propagateRankerFailureToRetrievalFallback is false', async () => {
      const db = openTestDatabase();
      const onVectorRankerFallback = vi.fn();
      const onRetrievalFallback = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          throw new Error('Ranker service unavailable');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        vectorRankerFallback: 'js-cosine',
        propagateRankerFailureToRetrievalFallback: false,
        onVectorRankerFallback,
        onRetrievalFallback,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.read('user-1', 'apple');

      // Only onVectorRankerFallback should be called
      expect(onVectorRankerFallback).toHaveBeenCalled();
      expect(onRetrievalFallback).not.toHaveBeenCalled();
    });
  });

  describe('onEmbeddingPersisted hook', () => {
    it('should call onEmbeddingPersisted when embedding is stored during importDump', async () => {
      const db = openTestDatabase();
      const onEmbeddingPersisted = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted,
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
      ]));

      expect(onEmbeddingPersisted).toHaveBeenCalledWith({
        entityId: 'user-1',
        factId: 'fact-a',
        vector: expect.any(Float32Array),
      });
    });

    it('should call onEmbeddingPersisted when embedding is updated during runReembed', async () => {
      const db = openTestDatabase();
      const onEmbeddingPersisted = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted,
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
      ]));

      onEmbeddingPersisted.mockClear();
      await wiki.runReembed('user-1');

      expect(onEmbeddingPersisted).toHaveBeenCalledWith({
        entityId: 'user-1',
        factId: 'fact-a',
        vector: expect.any(Float32Array),
      });
    });

    it('should call onEmbeddingPersisted with null when entry is forgotten', async () => {
      const db = openTestDatabase();
      const onEmbeddingPersisted = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted,
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
      ]));

      onEmbeddingPersisted.mockClear();
      await wiki.forget('user-1', { entryId: 'fact-a' });

      expect(onEmbeddingPersisted).toHaveBeenCalledWith({
        entityId: 'user-1',
        factId: 'fact-a',
        vector: null,
      });
    });

    it('should call onEmbeddingPersisted with null when entry is pruned', async () => {
      const db = openTestDatabase();
      const onEmbeddingPersisted = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted,
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
      ]));

      // First forget the entry to soft-delete it, with a past timestamp
      await wiki.forget('user-1', { entryId: 'fact-a' });

      // Manually update the deleted_at to be in the past so prune will delete it
      const pastTimestamp = Date.now() - 100000; // 100 seconds ago
      await db.runAsync(
        `UPDATE llm_wiki_entries SET deleted_at = ? WHERE id = ?`,
        [pastTimestamp, 'fact-a']
      );

      onEmbeddingPersisted.mockClear();
      // Then prune it (hard delete) - retainSoftDeletedFor: 0 means prune anything older than now
      await wiki.runPrune('user-1', { retainSoftDeletedFor: 0 });

      expect(onEmbeddingPersisted).toHaveBeenCalledWith({
        entityId: 'user-1',
        factId: 'fact-a',
        vector: null,
      });
    });

    it('should not call onEmbeddingPersisted when hook is not provided', async () => {
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => [],
        // onEmbeddingPersisted not provided
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();

      // Should not throw when hook is not provided
      await expect(wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
      ]))).resolves.not.toThrow();
    });

    it('should not call onEmbeddingPersisted when vectorRanker is not provided', async () => {
      const db = openTestDatabase();

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        // vectorRanker not provided
      });
      await wiki.setup();

      // Should not throw when vectorRanker is not provided
      await expect(wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
      ]))).resolves.not.toThrow();
    });
  });
});
