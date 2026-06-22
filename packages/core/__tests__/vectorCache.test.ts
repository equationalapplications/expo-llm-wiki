import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions, MemoryDump } from '../src/types';
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
  it('evicts the oldest entity when the 17th entity is cached (cap = 16)', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    // Insert blobs and provide an embed fn so full-scan cosine path is taken.
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();

    // Insert one fact for each of 17 entities and set dimension.
    // MAX_VECTOR_CACHE_ENTITIES = 16, so the 17th read evicts entity-0.
    for (let i = 0; i < 17; i++) {
      await insertFactWithBlob(db, `f-e${i}`, `entity-${i}`, [1, 0, 0]);
    }
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    // Read all 17 entities to fill and then overflow the cache.
    for (let i = 0; i < 17; i++) {
      parseSpy.mockClear();
      await wiki.read(`entity-${i}`, 'query');
    }

    // Now read entity-0 again — it should have been evicted, so parseEmbedding must be called
    parseSpy.mockClear();
    await wiki.read('entity-0', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0); // evicted — re-parsed from DB

    // entity-16 was the most recently read and should still be cached
    parseSpy.mockClear();
    await wiki.read('entity-16', 'query');
    expect(parseSpy.mock.calls.length).toBe(0); // still in cache

    parseSpy.mockRestore();
  });

  it('skips cache population for entities with more than 500 facts (cap = 500)', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();

    // Insert 501 facts for a single entity (exceeds the 500-fact per-entity cap)
    for (let i = 0; i < 501; i++) {
      await insertFactWithBlob(db, `f-large-${i}`, 'large-entity', [1, 0, 0]);
    }
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('large-entity', 'query'); // first full-scan read

    // Second read: because > 500 facts skip cache population, parseEmbedding
    // must be called again on the second full-scan read
    parseSpy.mockClear();
    await wiki.read('large-entity', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0); // not cached — re-parses

    parseSpy.mockRestore();
  });
});

describe('vector cache — importDump() invalidation', () => {
  it('importDump() invalidates entity cache; subsequent read() re-parses from DB', async () => {
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1', [1, 0, 0]);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query'); // populate cache

    const dump: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f-imported',
              entity_id: 'user-1',
              title: 'imported fact',
              body: 'new body',
              tags: [],
              confidence: 'certain',
              source_type: 'user_stated',
              source_hash: null,
              source_ref: null,
              created_at: 2000,
              updated_at: 2000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [], edges: [],
        },
      },
    };

    await wiki.importDump(dump);

    // importDump should have invalidated the cache (double-flush); re-parses from DB
    parseSpy.mockClear();
    await wiki.read('user-1', 'query');
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
    parseSpy.mockRestore();
  });

  it('importDump() clears stale embedding when embedFact() fails for an updated fact', async () => {
    // Use a wiki where embed always throws so embedFact() returns false.
    const failingEmbed = async (_text: string): Promise<number[]> => {
      throw new Error('embed unavailable');
    };
    const { wiki, db } = makeWiki(failingEmbed);
    await wiki.setup();

    // Pre-insert a fact with a stale embedding vector.
    await insertFactWithBlob(db, 'f-existing', 'user-1', [1, 0, 0], 1000);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    // Import a dump that updates the same fact with new title/body (newer updated_at).
    const dump: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f-existing',
              entity_id: 'user-1',
              title: 'updated title',
              body: 'updated body',
              tags: [],
              confidence: 'certain',
              source_type: 'user_stated',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 2000, // newer — LWW winner
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [], edges: [],
        },
      },
    };

    await wiki.importDump(dump);

    // The fact row should have NULL embedding_blob and NULL embedding because
    // embedFact() failed and the stale vector was explicitly cleared.
    const row = await db.getFirstAsync<{ embedding_blob: Uint8Array | null; embedding: string | null }>(
      `SELECT embedding_blob, embedding FROM llm_wiki_entries WHERE id = ?`,
      ['f-existing']
    );
    expect(row).not.toBeNull();
    expect(row!.embedding_blob).toBeNull();
    expect(row!.embedding).toBeNull();
  });

  it('importDump() does not re-embed a merge LWW loser — existing embedding is preserved', async () => {
    // Use a wiki with a real embed function to detect unexpected embedFact() calls.
    const embedCalls: string[] = [];
    const embed = async (text: string): Promise<number[]> => {
      embedCalls.push(text);
      return [1, 0, 0];
    };
    const { wiki, db } = makeWiki(embed);
    await wiki.setup();

    // Pre-insert a fact with a valid embedding (updated_at = 2000).
    await insertFactWithBlob(db, 'f-local', 'user-1', [0, 1, 0], 2000);
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    // Import an older version of the same fact (updated_at = 1000 — LWW loser).
    const dump: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f-local',
              entity_id: 'user-1',
              title: 'old title from dump',
              body: 'old body from dump',
              tags: [],
              confidence: 'certain',
              source_type: 'user_stated',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000, // older — LWW loser, should be skipped
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [], edges: [],
        },
      },
    };

    embedCalls.length = 0; // reset after setup
    await wiki.importDump(dump, { merge: true });

    // embedFact() must NOT have been called for the skipped fact.
    expect(embedCalls).toHaveLength(0);

    // The existing embedding (from the pre-insert) must still be intact.
    const row = await db.getFirstAsync<{ embedding_blob: Uint8Array | null; title: string }>(
      `SELECT embedding_blob, title FROM llm_wiki_entries WHERE id = ?`,
      ['f-local']
    );
    expect(row).not.toBeNull();
    expect(row!.embedding_blob).not.toBeNull(); // original embedding preserved
    expect(row!.title).toBe('title-f-local'); // original title preserved (LWW loser skipped)
  });
});
