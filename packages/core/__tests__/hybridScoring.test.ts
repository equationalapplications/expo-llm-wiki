import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

function makeWiki(embedFn?: (text: string) => Promise<number[]>, config: { hybridWeight?: number; preFilterLimit?: number } = {}) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    config,
    llmProvider: { generateText: async () => '{}', embed: embedFn },
  };
  return { wiki: new WikiMemory(db, options), db };
}

async function insertFactBlob(db: ReturnType<typeof openTestDatabase>, id: string, entityId: string, title: string, vec: number[], updatedAt = 1000) {
  const blob = new Uint8Array(new Float32Array(vec).buffer);
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, title, 'body', '[]', 'certain', 'user_stated', updatedAt, updatedAt, blob]
  );
}

describe('hybridWeight scoring', () => {
  it('hybridWeight: 1.0 → ranking identical to pure semantic', async () => {
    const { wiki, db } = makeWiki(async (t) => t.includes('apple') ? [1, 0, 0] : [0, 0, 1]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFactBlob(db, 'f-apple', 'user-1', 'apple fruit', [1, 0, 0], 2000);
    await insertFactBlob(db, 'f-other', 'user-1', 'car vehicle', [0, 0, 1], 1000);

    const pure = await wiki.read('user-1', 'apple'); // pure semantic (no hybridWeight)
    const hybrid1 = await wiki.read('user-1', 'apple', { hybridWeight: 1.0 });
    expect(hybrid1.facts[0].id).toBe(pure.facts[0].id);
  });

  it('hybridWeight: 0.0 → ranking identical to pure MiniSearch (skips embed())', async () => {
    const embedFn = vi.fn(async (t: string): Promise<number[]> => [1, 0, 0]);
    const { wiki, db } = makeWiki(embedFn);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFactBlob(db, 'f-apple', 'user-1', 'apple fruit', [1, 0, 0]);

    await wiki.read('user-1', 'apple', { hybridWeight: 0.0 });

    // embed() should NOT be called when hybridWeight === 0
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('hybridWeight: 0.5 → fact with balanced keyword + semantic score ranks above pure-semantic fact', async () => {
    // fact-both: matches keyword 'apple' AND has good semantic vector
    // fact-semantic-only: great semantic vector but no keyword match
    const embedFn = async (t: string): Promise<number[]> => {
      if (t.includes('apple')) return [1, 0, 0];
      if (t.includes('semantic')) return [0.99, 0.1, 0]; // very similar to apple query
      return [0, 0, 1];
    };
    const { wiki, db } = makeWiki(embedFn);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFactBlob(db, 'fact-both', 'user-1', 'apple information', [1, 0, 0], 2000);
    await insertFactBlob(db, 'fact-semantic', 'user-1', 'semantic similar concept', [0.99, 0.1, 0], 1000);
    // Rebuild so both facts are in MiniSearch
    await wiki.setup();

    const result = await wiki.read('user-1', 'apple', { hybridWeight: 0.5 });
    // fact-both has keyword match (higher keyword score) — should rank first at weight=0.5
    expect(result.facts[0].id).toBe('fact-both');
  });

  it('hybridWeight: 2.0 clamped to 1.0; hybridWeight: -1.0 clamped to 0.0', async () => {
    const embedFn = vi.fn(async (): Promise<number[]> => [1, 0, 0]);
    const { wiki, db } = makeWiki(embedFn);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFactBlob(db, 'f1', 'user-1', 'test fact', [1, 0, 0]);

    // hybridWeight: 2.0 → clamped to 1.0, embed() is called (weight=1 ≠ 0)
    await wiki.read('user-1', 'test', { hybridWeight: 2.0 });
    expect(embedFn).toHaveBeenCalled();

    embedFn.mockClear();
    // hybridWeight: -1.0 → clamped to 0.0, embed() skipped
    await wiki.read('user-1', 'test', { hybridWeight: -1.0 });
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('hybridWeight: Infinity clamped to 1.0 (embed called); -Infinity clamped to 0.0 (embed skipped)', async () => {
    const embedFn = vi.fn(async (): Promise<number[]> => [1, 0, 0]);
    const { wiki, db } = makeWiki(embedFn);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFactBlob(db, 'f1', 'user-1', 'test fact', [1, 0, 0]);

    // Infinity → clamped to 1.0 → pure semantic, embed() must be called
    await wiki.read('user-1', 'test', { hybridWeight: Infinity });
    expect(embedFn).toHaveBeenCalled();

    embedFn.mockClear();
    // -Infinity → clamped to 0.0 → skip embed, fast-path
    await wiki.read('user-1', 'test', { hybridWeight: -Infinity });
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('hybridWeight set but embed absent → MiniSearch fallback, no error, no onRetrievalFallback', async () => {
    const fallbackErrors: Error[] = [];
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      config: { hybridWeight: 0.5 },
      llmProvider: { generateText: async () => '{}' }, // no embed
      onRetrievalFallback: (e) => fallbackErrors.push(e),
    });
    await wiki.setup();
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'user-1', 'apple', 'body', '[]', 'certain', 'user_stated', 1000, 1000]
    );
    await wiki.setup(); // rebuild MiniSearch

    const result = await wiki.read('user-1', 'apple');
    expect(fallbackErrors).toHaveLength(0); // no fallback called
    expect(result.facts.length).toBeGreaterThan(0); // MiniSearch still works
  });

  it('hybridWeight + preFilterLimit: single MiniSearch call (search called once)', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0], { hybridWeight: 0.5, preFilterLimit: 5 });
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFactBlob(db, 'f-apple', 'user-1', 'apple fruit', [1, 0, 0]);
    await wiki.setup(); // rebuild MiniSearch

    const kwSpy = vi.spyOn((wiki as any).searchService, 'searchKeyword');
    const scoreSpy = vi.spyOn((wiki as any).searchService, 'getMiniSearchScores');
    await wiki.read('user-1', 'apple');

    // One searchKeyword call serves preFilter; scores come from those results (no getMiniSearchScores call)
    expect(kwSpy.mock.calls.length).toBe(1);
    expect(scoreSpy.mock.calls.length).toBe(0);
    kwSpy.mockRestore();
    scoreSpy.mockRestore();
  });

  it('hybridWeight: 0 + preFilterLimit set: preFilterLimit ignored, MiniSearch-only path', async () => {
    const embedFn = vi.fn(async (): Promise<number[]> => [1, 0, 0]);
    const { wiki, db } = makeWiki(embedFn, { hybridWeight: 0, preFilterLimit: 2 });
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    for (let i = 0; i < 5; i++) {
      await insertFactBlob(db, `f${i}`, 'user-1', `apple fact ${i}`, [1, 0, 0]);
    }
    await wiki.setup(); // rebuild MiniSearch

    const result = await wiki.read('user-1', 'apple');
    expect(embedFn).not.toHaveBeenCalled(); // skipEmbed path — no embed call
    expect(result.facts.length).toBeGreaterThan(2); // preFilterLimit NOT applied
  });

  it('per-call ReadOptions.hybridWeight overrides WikiConfig.hybridWeight', async () => {
    const embedFn = vi.fn(async (): Promise<number[]> => [1, 0, 0]);
    const { wiki, db } = makeWiki(embedFn, { hybridWeight: 0 }); // config says skip embed
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await insertFactBlob(db, 'f1', 'user-1', 'apple', [1, 0, 0]);

    // Per-call override to 1.0 → embed() should be called
    await wiki.read('user-1', 'apple', { hybridWeight: 1.0 });
    expect(embedFn).toHaveBeenCalled();
  });

  it('cosineSimilarity accepts both number[] and Float32Array and returns identical scores', async () => {
    const { cosineSimilarity } = await import('../src/utils/cosine');
    const a = [0.6, 0.8, 0.0];
    const b = [1.0, 0.0, 0.0];
    const scoreArr = cosineSimilarity(a, b);
    const scoreF32 = cosineSimilarity(new Float32Array(a), new Float32Array(b));
    expect(scoreF32).toBeCloseTo(scoreArr, 5);
  });
});
