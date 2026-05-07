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
      // Only fact-a should be returned
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].id).toBe('fact-a');
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

      await wikiNewModel.read('user-1', 'test');

      // Ranker should NOT be called due to dimension mismatch
      expect(rankBySimilarity).not.toHaveBeenCalled();
      // Should fall back to keyword search and invoke onRetrievalFallback
      expect(onRetrievalFallback).toHaveBeenCalled();
    });
  });
});
