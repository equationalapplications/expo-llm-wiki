import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiInvalidReadOptions } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';

let wiki: WikiMemory;
let db: any;

async function fact(id: string, title: string, created_at: number) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at)
     VALUES (?, 'u', ?, ?, 'certain', 'user_stated', ?, ?)`,
    [id, title, `${title} body`, created_at, created_at],
  );
}

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } }); // no embed ⇒ keyword path
  await wiki.setup();
  await fact('seattle', 'User lives in Seattle city', 1_000);
  await fact('job', 'User works as engineer', 1_000);
  // Learned late: at T=10_000 we learn the move happened at 5_000.
  await wiki.supersede('u', 'seattle', { title: 'User lives in San Francisco city', body: 'moved' }, { validFrom: 5_000 });
});

const ids = (b: { facts: { id: string }[] }) => b.facts.map((f) => f.id).sort();

describe('read() temporal semantics', () => {
  it('default read returns current facts only (keyword query path)', async () => {
    const b = await wiki.read('u', 'lives city');
    expect(b.facts.some((f) => f.id === 'seattle')).toBe(false);
    expect(b.facts.some((f) => f.title.includes('San Francisco'))).toBe(true);
  });

  it('asOf before the move returns Seattle, not SF', async () => {
    const b = await wiki.read('u', 'lives city', { asOf: 3_000 });
    expect(b.facts.map((f) => f.id)).toContain('seattle');
    expect(b.facts.some((f) => f.title.includes('San Francisco'))).toBe(false);
  });

  it('asOf between move and learning returns SF (valid-time, current knowledge)', async () => {
    const b = await wiki.read('u', 'lives city', { asOf: 6_000 });
    expect(b.facts.some((f) => f.title.includes('San Francisco'))).toBe(true);
    expect(b.facts.some((f) => f.id === 'seattle')).toBe(false);
  });

  it('asOf at the switch instant returns only the new fact (half-open)', async () => {
    const b = await wiki.read('u', 'lives city', { asOf: 5_000 });
    expect(b.facts.some((f) => f.id === 'seattle')).toBe(false);
    expect(b.facts.some((f) => f.title.includes('San Francisco'))).toBe(true);
  });

  it('empty-query recency path honours asOf and the current default', async () => {
    expect(ids(await wiki.read('u', ''))).not.toContain('seattle');
    expect(ids(await wiki.read('u', '', { asOf: 3_000 }))).toEqual(['job', 'seattle']);
  });

  it('rejects an invalid asOf', async () => {
    await expect(wiki.read('u', 'x', { asOf: -1 })).rejects.toBeInstanceOf(WikiInvalidReadOptions);
  });

  it('with embeddings: vector path also excludes superseded facts', async () => {
    const db2 = openTestDatabase();
    const embed = async (t: string) => [t.includes('Seattle') ? 1 : 0, t.includes('San Francisco') ? 1 : 0, 1];
    const w2 = new WikiMemory(db2, { llmProvider: { generateText: async () => '{}', embed } });
    await w2.setup();
    await w2.importDump({ generatedAt: 0, entities: { u: { facts: [
      { id: 'seattle', entity_id: 'u', title: 'User lives in Seattle', body: 'b', tags: [], confidence: 'certain', source_type: 'user_stated', source_hash: null, source_ref: null, created_at: 1, updated_at: 1, last_accessed_at: null, access_count: 0, deleted_at: null },
    ], tasks: [], events: [] } } });
    await w2.runReembed();
    await w2.supersede('u', 'seattle', { title: 'User lives in San Francisco', body: 'b' }, { validFrom: 5 });
    const cur = await w2.read('u', 'where does the user live');
    expect(cur.facts.map((f) => f.id)).not.toContain('seattle');
    const past = await w2.read('u', 'where does the user live', { asOf: 3 });
    expect(past.facts.map((f) => f.id)).toContain('seattle');
  });
});