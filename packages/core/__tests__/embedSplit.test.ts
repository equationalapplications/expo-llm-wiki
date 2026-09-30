import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

describe('EmbeddingService compute/store split', () => {
  it('storeFactVector persists without calling embed()', async () => {
    const embed = vi.fn(async () => [1, 0, 0]);
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}', embed } });
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('f1','u','t','b',1,1)`);
    const svc = wiki.__testAccess.embeddingService as any;
    const computed = await svc.embedTextForFact({ id: 'f1', entity_id: 'u', title: 't', body: 'b', tags: [] });
    expect(computed.ok).toBe(true);
    expect(embed).toHaveBeenCalledTimes(1);
    const stored = await svc.storeFactVector({ id: 'f1', entity_id: 'u' }, computed.vector);
    expect(stored).toEqual({ ok: true, dimension: 3 });
    expect(embed).toHaveBeenCalledTimes(1);
    const row = await db.getFirstAsync<any>(`SELECT embedding_blob FROM llm_wiki_entries WHERE id='f1'`);
    expect(row.embedding_blob.byteLength).toBe(12);
  });
});
