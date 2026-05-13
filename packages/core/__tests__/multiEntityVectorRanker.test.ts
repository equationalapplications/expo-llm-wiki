import { describe, expect, it, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { VectorRanker, WikiOptions } from '../src/types';

function keywordEmbed(text: string): number[] {
  if (text.includes('apple')) return [1, 0, 0];
  return [0, 1, 0];
}

async function insertFact(
  db: ReturnType<typeof openTestDatabase>,
  id: string,
  entityId: string,
  title: string,
  vec: number[] | null,
) {
  const blob = vec ? new Uint8Array(new Float32Array(vec).buffer) : null;
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, title, 'body', '[]', 'certain', 'user_stated', 1000, 1000, blob],
  );
}

function makeWiki(options: Partial<WikiOptions>) {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed: async text => keywordEmbed(text) },
    ...options,
  });
  return { wiki, db };
}

describe('multi-entity vector ranker retrieval', () => {
  it('calls vectorRanker once per requested entity and merges weighted scores globally', async () => {
    const calls: Array<{ entityId: string; candidateIds?: readonly string[] }> = [];
    const ranker: VectorRanker = {
      rankBySimilarity: async (args) => {
        calls.push({ entityId: args.entityId, candidateIds: args.candidateIds });
        if (args.entityId === 'tier_wisdom') return [{ id: 'wisdom-1', semanticScore: 0.6 }];
        if (args.entityId === 'tier_fact') return [{ id: 'fact-1', semanticScore: 0.9 }];
        return [];
      },
    };
    const { wiki, db } = makeWiki({ vectorRanker: ranker });
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'wisdom-1', 'tier_wisdom', 'apple wisdom', [1, 0, 0]);
    await insertFact(db, 'fact-1', 'tier_fact', 'apple fact', [1, 0, 0]);

    const result = await wiki.read(['tier_wisdom', 'tier_fact'], 'apple', {
      maxResults: 1,
      tierWeights: { tier_wisdom: 2, tier_fact: 1 },
    });

    expect(calls.map(call => call.entityId)).toEqual(['tier_wisdom', 'tier_fact']);
    expect(result.facts.map(f => f.id)).toEqual(['wisdom-1']);
    expect(result.factScores).toEqual({ 'wisdom-1': 1.2 });
  });

  it('passes per-entity prefilter ids to vectorRanker', async () => {
    const ranker = {
      rankBySimilarity: vi.fn(async (args) => args.candidateIds?.map(id => ({ id, semanticScore: 0.5 })) ?? []),
    } satisfies VectorRanker;
    const { wiki, db } = makeWiki({ vectorRanker: ranker });
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'wisdom-apple', 'tier_wisdom', 'apple wisdom', [1, 0, 0]);
    await insertFact(db, 'fact-apple', 'tier_fact', 'apple fact', [1, 0, 0]);
    await insertFact(db, 'fact-car', 'tier_fact', 'car fact', [0, 1, 0]);
    await wiki.setup(); // rebuild MiniSearch after direct DB inserts

    await wiki.read(['tier_wisdom', 'tier_fact'], 'apple', { preFilterLimit: 10 });

    expect(ranker.rankBySimilarity.mock.calls).toHaveLength(2);
    expect(ranker.rankBySimilarity.mock.calls[0][0].candidateIds).toEqual(['wisdom-apple']);
    expect(ranker.rankBySimilarity.mock.calls[1][0].candidateIds).toEqual(['fact-apple']);
  });

  it('ranker js-cosine fallback hydrates embeddings by selected ids without an entity_id guard', async () => {
    const ranker: VectorRanker = {
      rankBySimilarity: async () => { throw new Error('ranker unavailable'); },
    };
    const { wiki, db } = makeWiki({ vectorRanker: ranker, vectorRankerFallback: 'js-cosine' });
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'wisdom-1', 'tier_wisdom', 'apple wisdom', [1, 0, 0]);
    await insertFact(db, 'fact-1', 'tier_fact', 'apple fact', [0.8, 0, 0]);

    const result = await wiki.read(['tier_wisdom', 'tier_fact'], 'apple', { maxResults: 2 });

    expect(result.facts.map(f => f.id)).toContain('wisdom-1');
    expect(result.facts.map(f => f.id)).toContain('fact-1');
    expect(result.facts).toHaveLength(2);
  });

  it('dimension mismatch in any requested entity causes one keyword fallback for the whole read', async () => {
    const fallbackErrors: Error[] = [];
    const { wiki, db } = makeWiki({ onRetrievalFallback: error => fallbackErrors.push(error) });
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'wisdom-1', 'tier_wisdom', 'apple wisdom', [1, 0, 0]);
    await insertFact(db, 'fact-mismatch', 'tier_fact', 'apple fact', [1, 0]);
    await wiki.setup(); // rebuild MiniSearch after direct DB inserts

    const result = await wiki.read(['tier_wisdom', 'tier_fact'], 'apple');

    expect(fallbackErrors).toHaveLength(1);
    expect(fallbackErrors[0].message).toMatch(/do not match the current model dimension/i);
    expect(result.facts.map(f => f.id)).toContain('wisdom-1');
    expect(result.facts.map(f => f.id)).toContain('fact-mismatch');
  });
});
