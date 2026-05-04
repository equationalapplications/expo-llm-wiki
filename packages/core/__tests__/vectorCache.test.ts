import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';
import * as embeddingModule from '../src/utils/embedding';

function makeWiki(embedFn?: (text: string) => Promise<number[]>, onFallback?: (e: Error) => void) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: { generateText: async () => '{}', embed: embedFn },
    onRetrievalFallback: onFallback,
  };
  return { wiki: new WikiMemory(db, options), db };
}

async function insertFactWithBlob(db: ReturnType<typeof openTestDatabase>, id: string, entityId: string, vec: number[], updatedAt = 1000) {
  const blob = new Uint8Array(new Float32Array(vec).buffer);
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, `title-${id}`, 'body', '[]', 'certain', 'user_stated', updatedAt, updatedAt, blob]
  );
}

describe('vector cache — population', () => {
  it('first full-scan read() populates cache for the entity', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await insertFactWithBlob(db, 'f2', 'user-1', [0, 1, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    parseSpy.mockClear();
    await wiki.read('user-1', 'query');
    const firstCallCount = parseSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0); // parsed on first call

    parseSpy.mockClear();
    await wiki.read('user-1', 'query');
    expect(parseSpy.mock.calls.length).toBe(0); // cache hit — no parse on second call

    parseSpy.mockRestore();
  });

  it('clearVectorCache() clears entire cache; subsequent read() re-parses from DB', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query'); // populates cache

    wiki.clearVectorCache();

    parseSpy.mockClear();
    await wiki.read('user-1', 'query'); // cache cleared — re-parses
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

    parseSpy.mockRestore();
  });

  it('corrupt/null embeddings are not stored in cache', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    // Insert fact with corrupt BLOB
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f-corrupt', 'user-1', 'corrupt', 'body', '[]', 'certain', 'user_stated', 1000, 1000, new Uint8Array([1, 2, 3])]
    );
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    // First read
    await wiki.read('user-1', 'query');

    // Second read with spy — corrupt entry should still call parseEmbedding (not in cache)
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');
    await wiki.read('user-1', 'query');
    // corrupt fact has no cache entry, so parseEmbedding called for it on second read
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    parseSpy.mockRestore();
  });
});
