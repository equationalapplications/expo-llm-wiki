import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

function makeWiki(embedFn?: (text: string) => Promise<number[]>) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    config: { maxResults: 5 },
    llmProvider: { generateText: async () => '{}', embed: embedFn },
  };
  return { wiki: new WikiMemory(db, options), db };
}

async function insertFactWithBlob(db: ReturnType<typeof openTestDatabase>, id: string, entityId: string, updatedAt = 1000) {
  const blob = new Uint8Array(new Float32Array([Math.random(), Math.random(), Math.random()]).buffer);
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, `title-${id}`, `body-${id}`, '[]', 'certain', 'user_stated', updatedAt, updatedAt, blob]
  );
}

describe('ReadOptions per-call overrides', () => {
  it('per-call maxResults overrides WikiConfig.maxResults', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    // Insert 4 facts
    for (let i = 0; i < 4; i++) {
      await insertFactWithBlob(db, `f${i}`, 'user-1', 1000 + i);
    }

    const result = await wiki.read('user-1', 'query', { maxResults: 2 });
    expect(result.facts).toHaveLength(2);
  });

  it('per-call maxResults: 0 returns empty facts array', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1');
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    const result = await wiki.read('user-1', 'query', { maxResults: 0 });
    expect(result.facts).toHaveLength(0);
  });

  it('omitting ReadOptions falls back to WikiConfig defaults', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    for (let i = 0; i < 7; i++) {
      await insertFactWithBlob(db, `f${i}`, 'user-1', 1000 + i);
    }

    const result = await wiki.read('user-1', 'query');
    expect(result.facts).toHaveLength(5); // WikiConfig.maxResults = 5
  });

  it('ReadOptions: {} (empty object) falls back to WikiConfig defaults', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    for (let i = 0; i < 7; i++) {
      await insertFactWithBlob(db, `f${i}`, 'user-1', 1000 + i);
    }

    const result = await wiki.read('user-1', 'query', {});
    expect(result.facts).toHaveLength(5);
  });

  it('all three options overridden simultaneously', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    for (let i = 0; i < 10; i++) {
      await insertFactWithBlob(db, `f${i}`, 'user-1', 1000 + i);
    }

    // maxResults: 3, hybridWeight: 1.0 (pure semantic), preFilterLimit: null (disable)
    const result = await wiki.read('user-1', 'query', { maxResults: 3, hybridWeight: 1.0, preFilterLimit: null });
    expect(result.facts).toHaveLength(3);
  });
});
