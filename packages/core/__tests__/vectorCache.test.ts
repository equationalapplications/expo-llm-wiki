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

describe('vector cache — invalidation', () => {
  it('read() with preFilterLimit does not populate cache; subsequent full-scan read still parses from DB', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    await wiki.setup(); // rebuild MiniSearch

    // Pre-filter read — should NOT populate cache
    parseSpy.mockClear();
    await wiki.read('user-1', 'query', { preFilterLimit: 5 });

    // Full-scan read should still parse from DB (cache not populated)
    parseSpy.mockClear();
    await wiki.read('user-1', 'query'); // full scan
    const fullScanParseCount = parseSpy.mock.calls.length;
    expect(fullScanParseCount).toBeGreaterThan(0); // must parse on full scan regardless

    parseSpy.mockRestore();
  });

  it('forget() invalidates entity cache; next read() re-parses from DB', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await insertFactWithBlob(db, 'f2', 'user-1', [0, 1, 0]); // second fact remains after forget(f1)
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query'); // populate cache (f1 + f2)
    await wiki.forget('user-1', { entryId: 'f1' }); // soft-deletes f1, clears cache for user-1

    parseSpy.mockClear();
    await wiki.read('user-1', 'query'); // f2 still exists; cache was cleared → must re-parse
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0); // cache was invalidated
    parseSpy.mockRestore();
  });

  it('runLibrarian() invalidates entity cache', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query'); // populate cache
    await wiki.runLibrarian('user-1'); // should invalidate cache

    parseSpy.mockClear();
    await wiki.read('user-1', 'query'); // must re-parse
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    parseSpy.mockRestore();
  });

  it('runHeal() invalidates entity cache', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query'); // populate cache
    await wiki.runHeal('user-1');

    parseSpy.mockClear();
    await wiki.read('user-1', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    parseSpy.mockRestore();
  });

  it('ingestDocument() invalidates entity cache', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const hash = 'a'.repeat(64);
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query'); // populate cache
    await wiki.ingestDocument('user-1', { sourceRef: 'doc1', sourceHash: hash, documentChunk: 'short doc' });

    parseSpy.mockClear();
    await wiki.read('user-1', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    parseSpy.mockRestore();
  });

  it('runPrune() invalidates entity cache', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query'); // populate cache
    await wiki.runPrune('user-1');

    parseSpy.mockClear();
    await wiki.read('user-1', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    parseSpy.mockRestore();
  });

  it('runReembed() per-entity invalidates entity cache', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query'); // populate cache
    await wiki.runReembed('user-1');

    parseSpy.mockClear();
    await wiki.read('user-1', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    parseSpy.mockRestore();
  });

  it('global runReembed() clears entire cache', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await insertFactWithBlob(db, 'f2', 'user-2', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query');
    await wiki.read('user-2', 'query');
    await wiki.runReembed(); // global — clears all

    parseSpy.mockClear();
    await wiki.read('user-1', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    parseSpy.mockRestore();
  });
});

describe('vector cache — boundary limits', () => {
  it('evicts the oldest entity when the 101st entity is cached', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    // Use embed = undefined so read() falls back to MiniSearch and skips cosine scoring.
    // We just need entity reads to populate the cache; we don't need real embed vectors here.
    // Instead, insert blobs and provide an embed fn so full-scan cosine path is taken.
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();

    // Insert one fact for each of 101 entities and set dimension
    for (let i = 0; i < 101; i++) {
      await insertFactWithBlob(db, `f-e${i}`, `entity-${i}`, [1, 0, 0]);
    }
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    // Read all 101 entities to fill the cache; the 101st should evict entity-0
    for (let i = 0; i < 101; i++) {
      parseSpy.mockClear();
      await wiki.read(`entity-${i}`, 'query');
    }

    // Now read entity-0 again — it should have been evicted, so parseEmbedding must be called
    parseSpy.mockClear();
    await wiki.read('entity-0', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0); // evicted — re-parsed from DB

    // entity-100 was the most recently inserted and should still be cached
    parseSpy.mockClear();
    await wiki.read('entity-100', 'query');
    expect(parseSpy.mock.calls.length).toBe(0); // still in cache

    parseSpy.mockRestore();
  });

  it('skips cache population for entities with more than MAX_VECTOR_CACHE_FACTS_PER_ENTITY facts', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();

    // Insert 1001 facts for a single entity (exceeds the 1000-fact per-entity cap)
    for (let i = 0; i < 1001; i++) {
      await insertFactWithBlob(db, `f-large-${i}`, 'large-entity', [1, 0, 0]);
    }
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('large-entity', 'query'); // first full-scan read

    // Second read: because > 1000 facts skip cache population, parseEmbedding
    // must be called again on the second full-scan read
    parseSpy.mockClear();
    await wiki.read('large-entity', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0); // not cached — re-parses

    parseSpy.mockRestore();
  });
});
