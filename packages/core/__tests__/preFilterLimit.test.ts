import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

// Embed: words that match query get vec [1,0,0]; others get [0,0,1]
function makeKeywordEmbed(keyword: string) {
  return async (text: string): Promise<number[]> =>
    text.includes(keyword) ? [1, 0, 0] : [0, 0, 1];
}

function makeWiki(embedFn?: (text: string) => Promise<number[]>, preFilterLimit?: number) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    config: preFilterLimit !== undefined ? { preFilterLimit } : {},
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

describe('preFilterLimit', () => {
  it('facts with keyword overlap returned; semantically-similar-only facts excluded when pre-filter active', async () => {
    const { wiki, db } = makeWiki(makeKeywordEmbed('apple'), 3);
    await wiki.setup();

    // 'apple' matches query keyword → cosine-scored
    await insertFactBlob(db, 'f-apple', 'user-1', 'apple fruit tasty', [1, 0, 0]);
    // 'banana' has no keyword match → excluded from candidates
    await insertFactBlob(db, 'f-banana', 'user-1', 'banana yellow', [0, 0, 1]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    // Rebuild MiniSearch index so directly-inserted facts are searchable
    await wiki.setup();

    const result = await wiki.read('user-1', 'apple');
    const ids = result.facts.map(f => f.id);
    expect(ids).toContain('f-apple');
    expect(ids).not.toContain('f-banana');
  });

  it('preFilterLimit: 5 with 100 facts: at most 5 rows fetched from DB for cosine scoring', async () => {
    const { wiki, db } = makeWiki(makeKeywordEmbed('target'), 5);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    // Insert 100 facts; 10 contain the keyword
    for (let i = 0; i < 90; i++) {
      await insertFactBlob(db, `f-noise-${i}`, 'user-1', `noise fact ${i}`, [0, 0, 1]);
    }
    for (let i = 0; i < 10; i++) {
      await insertFactBlob(db, `f-target-${i}`, 'user-1', `target keyword fact ${i}`, [1, 0, 0]);
    }
    // Rebuild MiniSearch so all inserted facts are indexed
    await wiki.setup();

    // We verify correct behavior — at most preFilterLimit=5 facts returned
    const result = await wiki.read('user-1', 'target');
    expect(result.facts.length).toBeLessThanOrEqual(5);
    // All returned facts should be target facts (keyword match)
    for (const fact of result.facts) {
      expect(fact.id).toMatch(/f-target/);
    }
  });

  it('pre-filter returning 0 candidates → empty facts, no access tracking update', async () => {
    const { wiki, db } = makeWiki(makeKeywordEmbed('apple'), 3);
    await wiki.setup();

    await insertFactBlob(db, 'f-car', 'user-1', 'car vehicle', [0, 1, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await wiki.setup(); // rebuild MiniSearch

    const result = await wiki.read('user-1', 'apple'); // 'apple' won't match 'car vehicle' in MiniSearch
    expect(result.facts).toHaveLength(0);

    const row = await db.getFirstAsync<{ access_count: number }>(
      `SELECT access_count FROM llm_wiki_entries WHERE id = 'f-car'`
    );
    expect(row?.access_count).toBe(0); // no access tracking
  });

  it('preFilterLimit < maxResults: fewer than maxResults facts returned — by design, no error', async () => {
    const { wiki, db } = makeWiki(makeKeywordEmbed('apple'), 2);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    for (let i = 0; i < 5; i++) {
      await insertFactBlob(db, `f-apple-${i}`, 'user-1', `apple fact ${i}`, [1, 0, 0]);
    }
    await wiki.setup(); // rebuild MiniSearch

    const result = await wiki.read('user-1', 'apple', { maxResults: 10 });
    // preFilterLimit=2 caps at 2 even though maxResults=10
    expect(result.facts.length).toBeLessThanOrEqual(2);
  });

  it('per-call ReadOptions.preFilterLimit overrides WikiConfig.preFilterLimit', async () => {
    const { wiki, db } = makeWiki(makeKeywordEmbed('apple'), 1); // config = 1
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    for (let i = 0; i < 5; i++) {
      await insertFactBlob(db, `f-apple-${i}`, 'user-1', `apple fact ${i}`, [1, 0, 0], 1000 + i);
    }
    await wiki.setup(); // rebuild MiniSearch

    // Per-call override to 3
    const result = await wiki.read('user-1', 'apple', { preFilterLimit: 3 });
    expect(result.facts.length).toBeLessThanOrEqual(3);
    expect(result.facts.length).toBeGreaterThan(1); // more than config=1 would allow
  });

  it('per-call ReadOptions.preFilterLimit: null disables config-level preFilterLimit (full scan)', async () => {
    const { wiki, db } = makeWiki(makeKeywordEmbed('apple'), 1); // config = 1
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    for (let i = 0; i < 5; i++) {
      await insertFactBlob(db, `f-apple-${i}`, 'user-1', `apple fact ${i}`, [1, 0, 0], 1000 + i);
    }
    await wiki.setup(); // rebuild MiniSearch

    // null disables pre-filter → full scan → up to maxResults (default 10)
    const result = await wiki.read('user-1', 'apple', { preFilterLimit: null });
    expect(result.facts.length).toBeGreaterThanOrEqual(5);
  });

  it('per-call ReadOptions.preFilterLimit: undefined falls back to WikiConfig default', async () => {
    const { wiki, db } = makeWiki(makeKeywordEmbed('apple'), 2); // config = 2
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    for (let i = 0; i < 5; i++) {
      await insertFactBlob(db, `f-apple-${i}`, 'user-1', `apple fact ${i}`, [1, 0, 0], 1000 + i);
    }
    await wiki.setup(); // rebuild MiniSearch

    const result = await wiki.read('user-1', 'apple', { preFilterLimit: undefined });
    expect(result.facts.length).toBeLessThanOrEqual(2); // config=2 applies
  });
});
