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
        events: [], edges: [],
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

    it('uses tie-break fields when selecting hybrid omitted top-K rows', async () => {
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        // Omit all IDs so hybrid backfill selection determines the winner.
        rankBySimilarity: async () => [],
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
        { id: 'fact-a', title: 'car', body: 'same keywords' },
        { id: 'fact-b', title: 'car', body: 'same keywords' },
      ]));

      // Make fact-b win tie-break when keyword score is equal.
      await db.runAsync(
        `UPDATE llm_wiki_entries SET access_count = ?, updated_at = ? WHERE id = ?`,
        [10, 9999, 'fact-b']
      );

      const result = await wiki.read('user-1', 'car', {
        hybridWeight: 0.5,
        maxResults: 1,
      });

      expect(result.facts[0].id).toBe('fact-b');
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

    it('should omit candidateIds for single-entity full-scan', async () => {
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
      // Single-entity full-scan should omit candidateIds so rankers can scope by entityId.
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

    it('keyword fallback respects preFilterLimit when ranker fails', async () => {
      // Regression: when preFilterLimit is set, candidateRows is narrowed to
      // the pre-filtered IDs. The keyword-rank fallback must restrict its
      // MiniSearch call to that same set, so a tierFloor cannot resurrect a
      // fact that preFilterLimit excluded (§3.5).
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          throw new Error('Ranker service unavailable');
        },
      };

      const wiki = new WikiMemory(db, {
        config: { preFilterLimit: 1 },
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        vectorRankerFallback: 'keyword',
      });
      await wiki.setup();
      // Three apple facts: MiniSearch ranks them so fact-a wins the top-1.
      // Without the fix the fallback would search all three and return >1.
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'apple orchard', body: 'trees and bees' },
        { id: 'fact-c', title: 'apple juice', body: 'fresh pressed' },
      ]));

      const result = await wiki.read('user-1', 'apple', { maxResults: 5 });
      expect(result.facts.map(f => f.id)).toEqual(['fact-a']);
    });

    it('keyword fallback honors a tier floor beyond the oversampling window when ranker fails', async () => {
      // Regression: when the external ranker fails and `vectorRankerFallback`
      // is `'keyword'`, the fallback's MiniSearch call used a fixed
      // oversampling limit (max(maxResults*2, maxResults+50)). A floored
      // entity whose matches sit past that window used to be silently
      // starved. The fix widens the limit to the full candidate set when any
      // positive floor is active, mirroring the JS-cosine path's widening
      // and the ordinary keyword fallback's `hasActiveFloors` widening.
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
        vectorRankerFallback: 'keyword',
      });
      await wiki.setup();
      await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
      const insertFact = async (id: string, entityId: string, updatedAt: number, vector: number[]) => {
        const blob = new Uint8Array(new Float32Array(vector).buffer);
        await db.runAsync(
          `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, entityId, `title-${id}`, 'apple', '[]', 'certain', 'user_stated', updatedAt, updatedAt, blob],
        );
      };
      // 60 big facts (higher keyword rank, fill the oversampled window of 55),
      // then 2 small facts past the cutoff.
      for (let i = 0; i < 60; i++) await insertFact(`big-${i}`, 'big', 2000 + i, [1, 0, 0]);
      await insertFact('small-0', 'small', 1000, [0.2, 0.9, 0]);
      await insertFact('small-1', 'small', 1001, [0.2, 0.9, 0]);
      await wiki.__testAccess.searchService.sync();

      const result = await wiki.read(['big', 'small'], 'apple', {
        maxResults: 5,
        tierFloors: { small: 2 },
      });
      expect(result.facts.filter(f => f.entity_id === 'small')).toHaveLength(2);
    });

    it('ranker backfill reservation honors a floor when the ranker omits an entire entity', async () => {
      // Regression: with an external vectorRanker, pure-semantic mode computed
      // maxBackfill = max(0, maxResults - scored.length) which became 0 the
      // moment another entity filled maxResults via ranker output. The fix
      // reserves each floored entity's shortfall from the omitted pool before
      // the global budget is spent, so a floor is honored even when the
      // ranker returns no scores for the floored entity.
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async ({ entityId }) => {
          if (entityId === 'big') {
            return [
              { id: 'big-0', semanticScore: 0.95 },
              { id: 'big-1', semanticScore: 0.90 },
              { id: 'big-2', semanticScore: 0.85 },
              { id: 'big-3', semanticScore: 0.80 },
              { id: 'big-4', semanticScore: 0.75 },
            ];
          }
          // Omit the small entity entirely (ranker has no scores for it).
          return [];
        },
      };

      const wiki = new WikiMemory(db, {
        config: { hybridWeight: 1 }, // pure semantic — no keyword blending
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      const insertFact = async (id: string, entityId: string, title: string, body: string, vector: number[] | null) => {
        const ts = 2000 + Math.floor(Math.random() * 1000);
        const blob = vector ? new Uint8Array(new Float32Array(vector).buffer) : null;
        await db.runAsync(
          `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, entityId, title, body, '[]', 'certain', 'user_stated', ts, ts, blob],
        );
      };
      await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
      // 5 big facts (ranker returns all), 2 small facts (ranker returns nothing).
      for (let i = 0; i < 5; i++) await insertFact(`big-${i}`, 'big', `apple fruit ${i}`, 'red', [1, 0, 0]);
      await insertFact('small-0', 'small', 'apple small 0', 'tiny red', [0.2, 0.9, 0]);
      await insertFact('small-1', 'small', 'apple small 1', 'tiny green', [0.2, 0.9, 0]);
      await wiki.__testAccess.searchService.sync();

      const result = await wiki.read(['big', 'small'], 'apple', {
        maxResults: 5,
        tierFloors: { small: 2 },
      });
      expect(result.facts).toHaveLength(5);
      expect(result.facts.filter(f => f.entity_id === 'small')).toHaveLength(2);
    });

    it('ranker backfill reservation honors a floor in hybrid mode too', async () => {
      // Hybrid-mode companion to the pure-semantic test above. In hybrid mode
      // the backfill budget is a global top-K of `maxResults` selected by
      // keyword score, so a floored entity whose omitted rows score *worse*
      // on keywords than the dominant entity's omitted rows is pushed out of
      // that top-K entirely — a different starvation mechanism than the
      // pure-semantic `maxResults - scored.length` budget going to zero.
      //
      // Setup that isolates it: 20 `big` facts all matching the query, of
      // which the ranker scores only 5. That leaves 15 omitted `big` rows
      // with kwScore > 0 competing for a backfill budget of 5, against 2
      // `small` rows that do not match the query at all (kwScore 0). Without
      // reservation the top-K is 5 `big` rows and no `small` row ever reaches
      // selectWithFloors.
      const db = openTestDatabase();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async ({ entityId }) => {
          if (entityId === 'big') {
            return [
              { id: 'big-0', semanticScore: 0.95 },
              { id: 'big-1', semanticScore: 0.90 },
              { id: 'big-2', semanticScore: 0.85 },
              { id: 'big-3', semanticScore: 0.80 },
              { id: 'big-4', semanticScore: 0.75 },
            ];
          }
          // Omit the small entity entirely (ranker has no scores for it).
          return [];
        },
      };

      const wiki = new WikiMemory(db, {
        config: { hybridWeight: 0.5 },
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();
      const insertFact = async (id: string, entityId: string, title: string, body: string, vector: number[]) => {
        const ts = 2000 + Number(id.split('-')[1]);
        const blob = new Uint8Array(new Float32Array(vector).buffer);
        await db.runAsync(
          `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, entityId, title, body, '[]', 'certain', 'user_stated', ts, ts, blob],
        );
      };
      await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
      // 20 big facts match 'apple'; only big-0..big-4 are returned by the ranker,
      // so 15 keyword-matching big rows remain in the omitted pool.
      for (let i = 0; i < 20; i++) await insertFact(`big-${i}`, 'big', `apple fruit ${i}`, 'red apple', [1, 0, 0]);
      // The small facts do not contain 'apple', so their kwScore is 0 and they
      // lose the global backfill top-K to every omitted big row.
      await insertFact('small-0', 'small', 'kiwi orchard', 'rare', [0.2, 0.9, 0]);
      await insertFact('small-1', 'small', 'kiwi grove', 'rare', [0.2, 0.9, 0]);
      await wiki.__testAccess.searchService.sync();

      const result = await wiki.read(['big', 'small'], 'apple', {
        maxResults: 5,
        tierFloors: { small: 2 },
      });
      expect(result.facts).toHaveLength(5);
      expect(result.facts.filter(f => f.entity_id === 'small')).toHaveLength(2);
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

    it('should call onEmbeddingPersisted with null for re-upserted facts that remain soft-deleted in replace mode', async () => {
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

      const deletedDump = makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
      ]);
      deletedDump.entities['user-1'].facts[0].deleted_at = Date.now();
      deletedDump.entities['user-1'].facts[0].updated_at = Date.now();

      await wiki.importDump(deletedDump);

      expect(onEmbeddingPersisted).toHaveBeenCalledWith({
        entityId: 'user-1',
        factId: 'fact-a',
        vector: null,
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

    it('should call onEmbeddingPersisted with null when ingestDocument replaces existing source_ref facts', async () => {
      const db = openTestDatabase();
      const onEmbeddingPersisted = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted,
      };

      let ingestCall = 0;
      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => {
            ingestCall += 1;
            return JSON.stringify({
              facts: [{
                title: `Doc Fact ${ingestCall}`,
                body: `Body ${ingestCall}`,
                tags: [],
                confidence: 'certain',
              }],
            });
          },
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
      });
      await wiki.setup();

      await wiki.ingestDocument('user-1', {
        sourceRef: 'doc://same',
        sourceHash: 'a'.repeat(64),
        documentChunk: 'first version',
        maxChunkLength: 1000,
        chunkOverlap: 0,
      });
      const firstBundle = await wiki.getMemoryBundle('user-1');
      const firstFactId = firstBundle.facts[0]?.id;
      expect(firstFactId).toBeDefined();

      onEmbeddingPersisted.mockClear();
      await wiki.ingestDocument('user-1', {
        sourceRef: 'doc://same',
        sourceHash: 'b'.repeat(64),
        documentChunk: 'second version',
        maxChunkLength: 1000,
        chunkOverlap: 0,
      });

      expect(onEmbeddingPersisted).toHaveBeenCalledWith({
        entityId: 'user-1',
        factId: firstFactId,
        vector: null,
      });
    });

    it('should call onEmbeddingPersisted with null when heal soft-deletes facts', async () => {
      const db = openTestDatabase();
      const onEmbeddingPersisted = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted,
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => JSON.stringify({
            downgraded: [],
            deleted: ['fact-a'],
            newFacts: [],
          }),
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        config: {
          orphanAfterDays: null,
          staleInferredAfterDays: null,
        },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
      ]));

      onEmbeddingPersisted.mockClear();
      await wiki.runHeal('user-1');

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

  describe('Regression: PR #16 review issues', () => {
    it('should filter out ranker results outside the candidate set before hydration', async () => {
      // Filtering is done via the allowedIds derived from candidateRows in
      // _rankWithVectorRanker, which catches cross-entity or nonexistent IDs
      // regardless of whether candidateIds was passed to the ranker. The
      // misbehaving ranker returning such IDs should not trigger the hydration
      // mismatch warning nor cause result count to drop silently.
      const db = openTestDatabase();
      const onRetrievalFallback = vi.fn();
      const mockRanker: VectorRanker = {
        rankBySimilarity: async () => {
          // Return mix of valid and invalid IDs
          return [
            { id: 'fact-a', semanticScore: 0.9 },         // valid (in candidateIds)
            { id: 'wrong-entity-1', semanticScore: 0.8 },  // filtered by allowedIds
            { id: 'fact-b', semanticScore: 0.7 },          // valid (in candidateIds)
            { id: 'nonexistent', semanticScore: 0.6 },     // filtered by allowedIds
          ];
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: {
          generateText: async () => '{}',
          embed: async (t) => keywordEmbed(t),
        },
        vectorRanker: mockRanker,
        onRetrievalFallback,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple', body: 'red' },
        { id: 'fact-b', title: 'car', body: 'fast' },
      ]));

      const result = await wiki.read('user-1', 'test');

      // Should return only the 2 valid facts
      expect(result.facts).toHaveLength(2);
      expect(result.facts[0].id).toBe('fact-a');
      expect(result.facts[1].id).toBe('fact-b');

      // Invalid IDs are filtered by allowedIds in _rankWithVectorRanker — hydration sees
      // exactly 2 topIds and returns 2 rows, so the mismatch warning is NOT triggered.
      expect(onRetrievalFallback).not.toHaveBeenCalled();
    });
  });

  describe('Error sanitization', () => {
    it('sanitizes ranker errors by default (sanitizeRankerErrors=true)', async () => {
      const db = openTestDatabase();
      let capturedError: Error | undefined;

      const leakyRanker: VectorRanker = {
        async rankBySimilarity() {
          throw new Error('Connection failed: https://api.example.com?key=sk_live_secret123');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: leakyRanker,
        vectorRankerFallback: 'js-cosine',
        propagateRankerFailureToRetrievalFallback: true,
        onRetrievalFallback: (error) => { capturedError = error; },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.read('user-1', 'apple');

      expect(capturedError).toBeDefined();
      const cause = (capturedError as Error & { cause?: Error }).cause;
      expect(cause).toBeDefined();
      expect(cause!.message).not.toContain('sk_live_secret123');
      expect(cause!.message).toContain('VectorRanker');
      expect(cause!.message).toContain('scrubbed');
      expect(cause!.name).toBe('Error');
    });

    it('sanitizes non-Error throws without crashing (sanitizer robustness)', async () => {
      const db = openTestDatabase();
      let capturedError: Error | undefined;

      const stringThrowingRanker: VectorRanker = {
        async rankBySimilarity() {
          // eslint-disable-next-line no-throw-literal
          throw 'bare string with secret api_key=abc';
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: stringThrowingRanker,
        vectorRankerFallback: 'js-cosine',
        propagateRankerFailureToRetrievalFallback: true,
        onRetrievalFallback: (error) => { capturedError = error; },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.read('user-1', 'apple');

      expect(capturedError).toBeDefined();
      const cause = (capturedError as Error & { cause?: Error }).cause!;
      expect(cause.message).not.toContain('api_key=abc');
      expect(cause.message).toContain('VectorRanker string');
    });

    it('preserves original error when sanitizeRankerErrors=false', async () => {
      const db = openTestDatabase();
      let capturedError: Error | undefined;

      const leakyRanker: VectorRanker = {
        async rankBySimilarity() {
          throw new Error('Detailed error with api_key=secret123');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: leakyRanker,
        vectorRankerFallback: 'js-cosine',
        sanitizeRankerErrors: false,
        propagateRankerFailureToRetrievalFallback: true,
        onRetrievalFallback: (error) => { capturedError = error; },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.read('user-1', 'apple');

      expect(capturedError).toBeDefined();
      const cause = (capturedError as Error & { cause?: Error }).cause!;
      expect(cause.message).toContain('api_key=secret123');
    });
  });

  // Regression: issue #96, site 7. The inline
  // `rankerErr instanceof Error` check at RetrievalService.ts:350 invokes
  // the getPrototypeOf trap on rankerErr. A hostile VectorRanker plugin
  // whose trap rejects would throw out of the catch and tear down the
  // retrieval operation. On a hostile trap, the value is treated as
  // non-Error and wrapped in a synthetic Error by sanitizeRankerError,
  // which then passes through to the `onVectorRankerFallback` callback.
  // (Site 8 is covered by the companion test below.) This test mirrors the
  // existing "sanitizes non-Error throws without crashing" test (which
  // throws a string) but exercises the Proxy/getPrototypeOf class.
  it('sanitizes a hostile Proxy thrown by the ranker without crashing (sanitizer robustness)', async () => {
    const db = openTestDatabase();
    let capturedError: Error | undefined;

    const hostileProxy = new Proxy({}, {
      getPrototypeOf() { throw new Error('proxy rejects prototype access'); },
    });

    const proxyThrowingRanker: VectorRanker = {
      async rankBySimilarity() {
        // eslint-disable-next-line no-throw-literal
        throw hostileProxy;
      },
    };

    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
      vectorRanker: proxyThrowingRanker,
      vectorRankerFallback: 'js-cosine',
      propagateRankerFailureToRetrievalFallback: true,
      onRetrievalFallback: (error) => { capturedError = error; },
    });
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
    ]));

    // Should not throw out of retrieval — the hostile Proxy is treated as
    // a non-Error throw, wrapped in a synthetic Error by sanitizeRankerError,
    // and passed to the retrieval fallback callback.
    await expect(wiki.read('user-1', 'apple')).resolves.toBeDefined();

    expect(capturedError).toBeDefined();
    const cause = (capturedError as Error & { cause?: Error }).cause!;
    expect(cause.message).toContain('VectorRanker');
    expect(cause.message).toContain('scrubbed');
  });

  // Regression: issue #96, site 8. The phase-2 catch block
  // (`RetrievalService.read`, the outer try around the ranker/hydrate path)
  // invokes the getPrototypeOf trap on err. A hostile Proxy thrown from the
  // embed function — or any other operation in the outer try that escapes
  // the inner rankerErr catch — would otherwise throw out of this catch
  // and tear down the entire retrieval operation. The companion test above
  // exercises the rankerErr catch (site 7); this test specifically exercises
  // the outer catch (site 8) by making embed throw hostileProxy, so a
  // regression of the site-8 patch would surface here without overlapping
  // the site-7 path.
  it('does not throw on a hostile Proxy thrown from the embed function (sanitizer robustness for site 8)', async () => {
    const db = openTestDatabase();
    let capturedError: Error | undefined;

    const hostileProxy = new Proxy({}, {
      getPrototypeOf() { throw new Error('proxy rejects prototype access'); },
    });

    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => { throw hostileProxy; },
      },
      // No vectorRanker configured — forces the read path through the
      // outer try's embed branch, which throws hostileProxy directly into
      // site 8's catch.
      onRetrievalFallback: (error) => { capturedError = error; },
    });
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
    ]));

    await expect(wiki.read('user-1', 'apple')).resolves.toBeDefined();

    // Lock the observable contract: site 8's catch must wrap a hostile
    // Proxy as `new Error(safeErrorToString(err))` (the hardened helper
    // returns '[object Object]' for the getPrototypeOf-only fixture, since
    // String() walks valueOf/toString which don't invoke getPrototypeOf).
    // Asserting the exact message catches a regression where site 8 falls
    // back to `new Error(String(err))` and the toString trap ever changes.
    expect(capturedError).toBeDefined();
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError!.message).toBe('[object Object]');
  });

  describe('Buffer mutation protection', () => {
    it('protects vector from mutation by onEmbeddingPersisted hook', async () => {
      const db = openTestDatabase();
      let capturedVector: Float32Array | null = null;

      const maliciousRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector) {
            capturedVector = event.vector;
            event.vector[0] = -999; // Attempt corruption
          }
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: maliciousRanker,
        vectorRankerFallback: 'js-cosine',
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      // Read once to trigger embedding persistence + hook.
      await wiki.read('user-1', 'apple');

      // 1. Hook saw a Float32Array and mutated it locally.
      expect(capturedVector).not.toBeNull();
      expect(capturedVector![0]).toBe(-999);

      // 2. Persisted blob in SQLite is NOT corrupted.
      const row = await db.getFirstAsync<{ embedding_blob: Uint8Array | null }>(
        `SELECT embedding_blob FROM llm_wiki_entries WHERE id = ?`,
        ['fact-a'],
      );
      expect(row?.embedding_blob).toBeTruthy();
      const persisted = new Float32Array(
        row!.embedding_blob!.buffer,
        row!.embedding_blob!.byteOffset,
        row!.embedding_blob!.byteLength / 4,
      );
      expect(persisted[0]).not.toBe(-999);
      expect(persisted[0]).toBe(1); // keywordEmbed('apple fruit') = [1,0,0]
    });

    it('protects queryVec from mutation by ranker (subsequent reads still work)', async () => {
      const db = openTestDatabase();
      let mutationAttempted = false;

      const maliciousRanker: VectorRanker = {
        async rankBySimilarity(args) {
          mutationAttempted = true;
          // Attempt to corrupt queryVec
          if (args.queryVec instanceof Float32Array) {
            args.queryVec[0] = 999;
          } else {
            (args.queryVec as number[])[0] = 999;
          }
          throw new Error('Ranker failed after mutation');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: maliciousRanker,
        vectorRankerFallback: 'js-cosine',
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
      ]));

      const r1 = await wiki.read('user-1', 'apple');
      expect(mutationAttempted).toBe(true);
      expect(r1.facts[0].id).toBe('fact-a');

      // Second read uses a fresh embedding; if the FIRST queryVec leaked into a
      // shared cache, subsequent ranking would be corrupt.
      const r2 = await wiki.read('user-1', 'apple');
      expect(r2.facts[0].id).toBe('fact-a');
    });
  });

  describe('Deletion hook ordering', () => {
    it('aborts deletion when hook exceeds deletionHookTimeoutMs', async () => {
      const db = openTestDatabase();
      const slowRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector === null) {
            await new Promise((r) => setTimeout(r, 5000));
          }
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: slowRanker,
        deletionHookTimeoutMs: 100,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await expect(wiki.forget('user-1', { entryId: 'fact-a' })).rejects.toThrow(/timed out/);
    });

    it('throws on invalid deletionHookTimeoutMs values', async () => {
      const db = openTestDatabase();
      const ranker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted() {},
      };

      // NaN
      const wikiNaN = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: ranker,
        deletionHookTimeoutMs: NaN,
      });
      await wikiNaN.setup();
      await wikiNaN.importDump(makeDump([{ id: 'fact-a', title: 'test', body: 'test' }]));
      await expect(wikiNaN.forget('user-1', { entryId: 'fact-a' })).rejects.toThrow(/Invalid deletionHookTimeoutMs/);

      // Zero
      const wikiZero = new WikiMemory(openTestDatabase(), {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: ranker,
        deletionHookTimeoutMs: 0,
      });
      await wikiZero.setup();
      await wikiZero.importDump(makeDump([{ id: 'fact-b', title: 'test', body: 'test' }]));
      await expect(wikiZero.forget('user-1', { entryId: 'fact-b' })).rejects.toThrow(/Invalid deletionHookTimeoutMs/);

      // Negative
      const wikiNeg = new WikiMemory(openTestDatabase(), {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: ranker,
        deletionHookTimeoutMs: -100,
      });
      await wikiNeg.setup();
      await wikiNeg.importDump(makeDump([{ id: 'fact-c', title: 'test', body: 'test' }]));
      await expect(wikiNeg.forget('user-1', { entryId: 'fact-c' })).rejects.toThrow(/Invalid deletionHookTimeoutMs/);
    });

    it('rethrows onEmbeddingPersisted failure on forget()', async () => {
      const db = openTestDatabase();
      const failingRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector === null) throw new Error('ANN cleanup failed');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: failingRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await expect(wiki.forget('user-1', { entryId: 'fact-a' })).rejects.toThrow();
    });

    it('skips hook entirely when forceDeleteIgnoreRankerHook=true', async () => {
      const db = openTestDatabase();
      let hookCalled = false;
      const ranker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted() {
          hookCalled = true;
          throw new Error('would have failed');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: ranker,
        forceDeleteIgnoreRankerHook: true,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      // Reset flag after import (import uses _notifyEmbeddingPersisted which may call hook)
      hookCalled = false;

      await expect(wiki.forget('user-1', { entryId: 'fact-a' })).resolves.toBeDefined();
      expect(hookCalled).toBe(false);
    });

    it('awaits onEmbeddingPersisted before forget() resolves', async () => {
      const db = openTestDatabase();
      let hookCalledAt = 0;
      let hookCompleted = false;

      const delayedRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted() {
          hookCalledAt = Date.now();
          await new Promise((r) => setTimeout(r, 100));
          hookCompleted = true;
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: delayedRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.forget('user-1', { entryId: 'fact-a' });
      const forgetResolvedAt = Date.now();
      expect(hookCompleted).toBe(true);
      expect(forgetResolvedAt - hookCalledAt).toBeGreaterThanOrEqual(95);
    });

    it('awaits onEmbeddingPersisted during prune hard-delete', async () => {
      const db = openTestDatabase();
      let hookCallCount = 0;

      const trackingRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector === null) {
            hookCallCount++;
            await new Promise((r) => setTimeout(r, 20));
          }
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: trackingRanker,
        config: { pruneRetainSoftDeletedFor: 0 },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'apple seed', body: 'small and brown' },
      ]));

      await wiki.forget('user-1', { entryId: 'fact-a' });
      await wiki.forget('user-1', { entryId: 'fact-b' });

      // Small delay to ensure deleted_at timestamps are before prune cutoff
      await new Promise((r) => setTimeout(r, 10));

      const before = hookCallCount;
      await wiki.runPrune('user-1');
      expect(hookCallCount).toBeGreaterThan(before);
    });

    it('commits partial prune progress and reports aggregate failure', async () => {
      const db = openTestDatabase();
      let callIndex = 0;

      const flakyRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector === null) {
            callIndex++;
            if (callIndex === 3) throw new Error('ANN flake on row 3');
          }
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: flakyRanker,
        config: { pruneRetainSoftDeletedFor: 0 },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-0', title: 'apple a', body: 'x' },
        { id: 'fact-1', title: 'apple b', body: 'x' },
        { id: 'fact-2', title: 'apple c', body: 'x' },
        { id: 'fact-3', title: 'apple d', body: 'x' },
        { id: 'fact-4', title: 'apple e', body: 'x' },
      ]));

      // Soft-delete via forget(); the test's flakyRanker only fails when callIndex===3,
      // and forget() is index 1,2 (not 3) so soft-deletes succeed for all 5 rows.
      // Reset callIndex AFTER setup so the prune phase observes index 1..N.
      for (let i = 0; i < 5; i++) {
        await wiki.forget('user-1', { entryId: `fact-${i}` }).catch(() => {});
      }
      callIndex = 0;

      // Small delay to ensure deleted_at timestamps are before prune cutoff
      await new Promise((r) => setTimeout(r, 10));

      await expect(wiki.runPrune('user-1')).rejects.toThrow(/partially failed|partial/i);

      // Some rows remain (the failing one + ones after it).
      const remaining = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM llm_wiki_entries WHERE deleted_at IS NOT NULL`,
      );
      expect(remaining.length).toBeGreaterThan(0);
    });
  });
});
