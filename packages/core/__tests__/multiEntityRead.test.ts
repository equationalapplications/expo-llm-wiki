import { describe, expect, it, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

function makeWiki(embedFn?: (text: string) => Promise<number[]>) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    config: { maxResults: 10 },
    llmProvider: { generateText: async () => '{}', embed: embedFn },
  };
  return { wiki: new WikiMemory(db, options), db };
}

async function insertFact(
  db: ReturnType<typeof openTestDatabase>,
  id: string,
  entityId: string,
  title: string,
  body: string,
  vec: number[] | null,
  updatedAt: number,
) {
  const blob = vec ? new Uint8Array(new Float32Array(vec).buffer) : null;
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, title, body, '[]', 'certain', 'user_stated', updatedAt, updatedAt, blob],
  );
}

describe('read() multi-entity retrieval', () => {
  it('keeps plain single-string reads minimal', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'wisdom-1', 'tier_wisdom', 'apple wisdom', 'apple guidance', [1, 0, 0], 1000);

    const result = await wiki.read('tier_wisdom', 'apple');

    expect(result.facts.map(f => f.id)).toEqual(['wisdom-1']);
    expect(result.factScores).toBeUndefined();
    expect(result.metadata).toBeUndefined();
  });

  it('merges multi-entity scored reads and preserves each fact entity_id', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'wisdom-1', 'tier_wisdom', 'apple wisdom', 'apple', [1, 0, 0], 1000);
    await insertFact(db, 'fact-1', 'tier_fact', 'apple fact', 'apple', [0.5, 0.5, 0.5], 2000);

    const result = await wiki.read(['tier_wisdom', 'tier_fact'], 'apple', { maxResults: 2 });

    expect(result.facts.map(f => [f.id, f.entity_id])).toEqual([
      ['wisdom-1', 'tier_wisdom'],
      ['fact-1', 'tier_fact'],
    ]);
    expect(result.metadata).toEqual({ query: 'apple', entityIds: ['tier_wisdom', 'tier_fact'] });
    expect(result.factScores?.['wisdom-1']).toBeGreaterThan(result.factScores?.['fact-1'] ?? 0);
  });

  it('applies tier weights before global maxResults slicing', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'working-strong', 'tier_working', 'apple working', 'apple', [0.9, 0, 0], 3000);
    await insertFact(db, 'wisdom-weak', 'tier_wisdom', 'apple wisdom', 'apple', [0.1, 0.1, 0.1], 1000);

    const result = await wiki.read(['tier_working', 'tier_wisdom'], 'apple', {
      maxResults: 1,
      tierWeights: { tier_wisdom: 10, tier_working: 1 },
    });

    expect(result.facts.map(f => f.id)).toEqual(['wisdom-weak']);
    expect(result.metadata?.tierWeights).toEqual({ tier_working: 1, tier_wisdom: 10 });
    expect(result.factScores).toEqual({ 'wisdom-weak': expect.any(Number) });
  });

  it('deduplicates entity ids and exposes metadata for single-element arrays', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'wisdom-1', 'tier_wisdom', 'apple wisdom', 'apple', [1, 0, 0], 1000);

    const result = await wiki.read(['tier_wisdom', 'tier_wisdom'], 'apple');

    expect(result.facts.map(f => f.id)).toEqual(['wisdom-1']);
    expect(result.metadata?.entityIds).toEqual(['tier_wisdom']);
  });

  it('returns an empty bundle with metadata for an empty entity id array', async () => {
    const { wiki } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();

    const result = await wiki.read([], 'apple');

    expect(result).toEqual({
      facts: [],
      tasks: [],
      events: [],
      metadata: { query: 'apple', entityIds: [] },
    });
  });

  it('skips zero-weight entities by default for scored reads', async () => {
    const embedFn = vi.fn(async () => [1, 0, 0]);
    const { wiki, db } = makeWiki(embedFn);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'zero-1', 'tier_zero', 'apple zero', 'apple', [1, 0, 0], 1000);
    await insertFact(db, 'fact-1', 'tier_fact', 'apple fact', 'apple', [0.8, 0, 0], 2000);

    const result = await wiki.read(['tier_zero', 'tier_fact'], 'apple', {
      tierWeights: { tier_zero: 0, tier_fact: 1 },
    });

    expect(result.facts.map(f => f.id)).toEqual(['fact-1']);
    expect(result.factScores).toEqual({ 'fact-1': expect.any(Number) });
  });

  it('includes zero-weight entities as bottom filler when requested', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'zero-1', 'tier_zero', 'apple zero', 'apple', [0.5, 0, 0], 1000);
    await insertFact(db, 'fact-1', 'tier_fact', 'apple fact', 'apple', [1, 0, 0], 2000);

    const result = await wiki.read(['tier_zero', 'tier_fact'], 'apple', {
      maxResults: 2,
      tierWeights: { tier_zero: 0, tier_fact: 1 },
      includeZeroWeightEntities: true,
    });

    expect(result.facts.map(f => f.id)).toEqual(['fact-1', 'zero-1']);
    expect(result.factScores).toEqual({ 'fact-1': expect.any(Number), 'zero-1': 0 });
  });

  it('zero-weight entities sort below negative-scored non-zero-weight entities', async () => {
    // Bug: score * 0 = 0 can rank higher than a negative cosine score.
    // query=[1,0,0], tier_neg=[-1,0,0] → cosine=-1 (weight=1 → score=-1)
    // tier_zero=[1,0,0] → cosine=1 (weight=0 → score should be -Infinity, not 0)
    const embedFn = vi.fn(async () => [1, 0, 0]);
    const { wiki, db } = makeWiki(embedFn);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFact(db, 'neg-1', 'tier_neg', 'apple neg', 'apple', [-1, 0, 0], 1000);
    await insertFact(db, 'zero-2', 'tier_zero', 'apple zero2', 'apple', [1, 0, 0], 2000);

    const result = await wiki.read(['tier_neg', 'tier_zero'], 'apple', {
      maxResults: 2,
      tierWeights: { tier_neg: 1, tier_zero: 0 },
      includeZeroWeightEntities: true,
    });

    // neg-1 has cosine=-1 (bad match but non-zero weight); zero-2 has cosine=1 but weight=0
    // zero-weight must always be bottom filler regardless of raw cosine
    expect(result.facts.map(f => f.id)).toEqual(['neg-1', 'zero-2']);
    expect(result.factScores!['neg-1']).toBeLessThan(0);
    expect(result.factScores!['zero-2']).toBe(0);
  });

  it('empty-query multi-entity reads use global recency and omit factScores', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFact(db, 'old', 'tier_wisdom', 'old', 'body', null, 1000);
    await insertFact(db, 'new', 'tier_fact', 'new', 'body', null, 3000);

    const result = await wiki.read(['tier_wisdom', 'tier_fact'], '', {
      maxResults: 2,
      tierWeights: { tier_wisdom: 10, tier_fact: 0.1 },
    });

    expect(result.facts.map(f => f.id)).toEqual(['new', 'old']);
    expect(result.factScores).toBeUndefined();
    expect(result.metadata).toEqual({
      query: '',
      entityIds: ['tier_wisdom', 'tier_fact'],
      tierWeights: { tier_wisdom: 10, tier_fact: 0.1 },
    });
  });

  it('applies tier weights in embed-absent keyword fallback and populates factScores', async () => {
    // No embed function — forces MiniSearch-only path
    const { wiki } = makeWiki();
    await wiki.setup();
    // Use importDump so facts are indexed in MiniSearch
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: {
        tier_boosted: {
          facts: [{ id: 'boosted-weak', entity_id: 'tier_boosted', title: 'apple boosted', body: 'apple', tags: [], confidence: 'certain', source_type: 'user_stated', source_hash: null, source_ref: null, created_at: 1000, updated_at: 1000, last_accessed_at: null, access_count: 0, deleted_at: null }],
          tasks: [], events: [],
        },
        tier_normal: {
          facts: [{ id: 'normal-strong', entity_id: 'tier_normal', title: 'apple normal', body: 'apple', tags: [], confidence: 'certain', source_type: 'user_stated', source_hash: null, source_ref: null, created_at: 2000, updated_at: 2000, last_accessed_at: null, access_count: 0, deleted_at: null }],
          tasks: [], events: [],
        },
      },
    });

    const result = await wiki.read(['tier_boosted', 'tier_normal'], 'apple', {
      maxResults: 1,
      tierWeights: { tier_boosted: 10, tier_normal: 1 },
    });

    expect(result.facts.map(f => f.id)).toEqual(['boosted-weak']);
    expect(result.factScores?.['boosted-weak']).toBeGreaterThan(0);
  });

  it('applies tier weights in vectorRankerFallback=keyword path and populates factScores', async () => {
    const db = openTestDatabase();
    const options: WikiOptions = {
      config: { maxResults: 10 },
      llmProvider: { generateText: async () => '{}', embed: async () => [1, 0, 0] },
      vectorRanker: { rankBySimilarity: async () => { throw new Error('ranker unavailable'); } },
      vectorRankerFallback: 'keyword',
    };
    const wiki = new WikiMemory(db, options);
    await wiki.setup();
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: {
        tier_boosted: {
          facts: [{ id: 'boosted-weak', entity_id: 'tier_boosted', title: 'apple boosted', body: 'apple', tags: [], confidence: 'certain', source_type: 'user_stated', source_hash: null, source_ref: null, created_at: 1000, updated_at: 1000, last_accessed_at: null, access_count: 0, deleted_at: null }],
          tasks: [], events: [],
        },
        tier_normal: {
          facts: [{ id: 'normal-strong', entity_id: 'tier_normal', title: 'apple normal', body: 'apple', tags: [], confidence: 'certain', source_type: 'user_stated', source_hash: null, source_ref: null, created_at: 2000, updated_at: 2000, last_accessed_at: null, access_count: 0, deleted_at: null }],
          tasks: [], events: [],
        },
      },
    });
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    const result = await wiki.read(['tier_boosted', 'tier_normal'], 'apple', {
      maxResults: 1,
      tierWeights: { tier_boosted: 10, tier_normal: 1 },
    });

    expect(result.facts.map(f => f.id)).toEqual(['boosted-weak']);
    expect(result.factScores?.['boosted-weak']).toBeGreaterThan(0);
  });

  it('returns tasks and events for all requested entities in global order', async () => {
    const { wiki, db } = makeWiki();
    await wiki.setup();
    await db.runAsync(
      `INSERT INTO llm_wiki_tasks (id, entity_id, description, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['task-low', 'tier_fact', 'low', 'pending', 1, 1000, 1000],
    );
    await db.runAsync(
      `INSERT INTO llm_wiki_tasks (id, entity_id, description, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['task-high', 'tier_wisdom', 'high', 'in_progress', 5, 2000, 2000],
    );
    await db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['event-old', 'tier_fact', 'observation', 'old', 1000],
    );
    await db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['event-new', 'tier_wisdom', 'observation', 'new', 3000],
    );

    const result = await wiki.read(['tier_fact', 'tier_wisdom'], '');

    expect(result.tasks.map(t => t.id)).toEqual(['task-high', 'task-low']);
    expect(result.events.map(e => e.id)).toEqual(['event-old', 'event-new']);
  });
});
