import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

function makeWiki(embedFn?: (text: string) => Promise<number[]>) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: { generateText: async () => '{}', embed: embedFn },
  };
  return { wiki: new WikiMemory(db, options), db };
}

async function insertFact(db: ReturnType<typeof openTestDatabase>, id: string, entityId: string) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, `title-${id}`, 'body', '[]', 'certain', 'user_stated', 1000, 1000]
  );
}

describe('BLOB embedding storage', () => {
  it('embedFact stores Uint8Array in embedding_blob and sets embedding = NULL', async () => {
    const { wiki, db } = makeWiki(async () => [1.0, 0.0, -1.0]);
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');

    // Trigger embedFact via runReembed
    await wiki.runReembed('user-1');

    const row = await db.getFirstAsync<{ embedding: string | null; embedding_blob: Uint8Array | null }>(
      `SELECT embedding, embedding_blob FROM llm_wiki_entries WHERE id = 'f1'`
    );
    expect(row?.embedding).toBeNull();
    expect(row?.embedding_blob).not.toBeNull();
    expect(row?.embedding_blob).toBeInstanceOf(Uint8Array);
    expect(row!.embedding_blob!.byteLength).toBe(12); // 3 × 4 bytes
  });

  it('read() round-trips BLOB vector correctly', async () => {
    const embedVec = [0.5, 0.5, 0.5];
    const { wiki, db } = makeWiki(async () => embedVec);
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');
    await wiki.runReembed('user-1');

    // read() should not crash, should return the fact
    const result = await wiki.read('user-1', 'anything');
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].id).toBe('f1');
    // embedding_blob must not appear on returned facts
    expect((result.facts[0] as any).embedding_blob).toBeUndefined();
    expect((result.facts[0] as any).embedding).toBeUndefined();
  });

  it('read() falls back to JSON TEXT for rows where embedding_blob is null', async () => {
    const { wiki, db } = makeWiki(async (t) => t.includes('apple') ? [1, 0, 0] : [0, 1, 0]);
    await wiki.setup();
    // Insert a fact with old TEXT embedding only
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['fact-text', 'user-1', 'apple fruit', 'tasty', '[]', 'certain', 'user_stated', 1000, 1000,
       JSON.stringify([1, 0, 0])]
    );
    // Also store embedding_dimension so cosine path activates
    await db.runAsync(
      `INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`
    );

    const result = await wiki.read('user-1', 'apple');
    expect(result.facts[0].id).toBe('fact-text');
  });

  it('corrupt BLOB (wrong byte length) scores 0 and does not abort retrieval', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    // Insert a fact with a corrupt BLOB (3 bytes, not divisible by 4)
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['fact-corrupt', 'user-1', 'corrupt fact', 'body', '[]', 'certain', 'user_stated', 500, 500,
       new Uint8Array([1, 2, 3])]
    );
    // Insert a good fact with TEXT embedding
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['fact-good', 'user-1', 'good fact', 'body', '[]', 'certain', 'user_stated', 1000, 1000,
       JSON.stringify([1, 0, 0])]
    );
    await db.runAsync(
      `INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`
    );

    // Should not throw; corrupt fact scores 0, good fact scores 1
    const result = await wiki.read('user-1', 'anything');
    expect(result.facts[0].id).toBe('fact-good');
  });

  it('migration v3: embedding_blob column present; embedding column still present', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();

    const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(llm_wiki_entries)`);
    const names = cols.map(c => c.name);
    expect(names).toContain('embedding');
    expect(names).toContain('embedding_blob');
  });

  it('migration v3 idempotency: running migrations twice does not error', async () => {
    const db = openTestDatabase();
    const wiki1 = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki1.setup(); // first run — adds embedding_blob

    // Second setup on same DB — migration v3's IF NOT EXISTS guard prevents duplicate ADD COLUMN
    const wiki2 = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await expect(wiki2.setup()).resolves.not.toThrow();
  });

  it('runReembed converts TEXT rows to BLOB and nullifies embedding', async () => {
    const { wiki, db } = makeWiki(async () => [0.5, 0.5]);
    await wiki.setup();

    // Insert fact with TEXT embedding (simulates pre-migration row)
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f-text', 'user-1', 'text fact', 'body', '[]', 'certain', 'user_stated', 1000, 1000,
       JSON.stringify([0.5, 0.5])]
    );
    await db.runAsync(
      `INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '2')`
    );

    const result = await wiki.runReembed('user-1');
    expect(result.embedded).toBeGreaterThan(0);

    const row = await db.getFirstAsync<{ embedding: string | null; embedding_blob: Uint8Array | null }>(
      `SELECT embedding, embedding_blob FROM llm_wiki_entries WHERE id = 'f-text'`
    );
    expect(row?.embedding).toBeNull();
    expect(row?.embedding_blob).not.toBeNull();
  });

  it('buffer aliasing: mutating source Buffer does not corrupt cached Float32Array', async () => {
    const { parseEmbedding } = await import('../src/utils/embedding');
    // Simulate a Buffer-backed Uint8Array (as better-sqlite3 returns)
    const original = new Float32Array([1.0, 2.0, 3.0]);
    const buf = Buffer.allocUnsafe(12);
    buf.set(new Uint8Array(original.buffer));
    const result = parseEmbedding(buf, null)!;

    // Mutate the source Buffer
    buf.writeFloatLE(999.0, 0);

    expect(result[0]).toBeCloseTo(1.0); // copy unaffected
  });
});
