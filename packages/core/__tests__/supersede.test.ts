// packages/core/__tests__/supersede.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiSupersedeError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

let db: SQLiteAdapter;
let wiki: WikiMemory;

async function insert(id: string, entity = 'e1', source_type = 'user_stated', created_at = 100) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
     VALUES (?, ?, ?, 'body', ?, 'certain', ?, ?)`,
    [id, entity, `title ${id}`, source_type, created_at, created_at],
  );
}
const temporal = (id: string) =>
  db.getFirstAsync<any>(`SELECT valid_from, valid_to, superseded_by, superseded_at FROM llm_wiki_entries WHERE id = ?`, [id]);

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
});

describe('supersede()', () => {
  it('creates the replacement and links both rows with no gap', async () => {
    await insert('seattle');
    const { newId } = await wiki.supersede('e1', 'seattle', { title: 'Lives in SF', body: 'Moved to SF' }, { validFrom: 5_000 });
    expect(await temporal('seattle')).toMatchObject({ valid_to: 5_000, superseded_by: newId });
    expect((await temporal('seattle')).superseded_at).toBeGreaterThan(0);
    expect(await temporal(newId)).toMatchObject({ valid_from: 5_000, valid_to: null });
  });

  it('defaults validFrom to now and accepts an existing fact id', async () => {
    await insert('a');
    await insert('b');
    const before = Date.now();
    await wiki.supersede('e1', 'a', 'b');
    const a = await temporal('a');
    expect(a.valid_to).toBeGreaterThanOrEqual(before);
    expect(await temporal('b')).toMatchObject({ valid_from: a.valid_to });
  });

  it('keeps an existing replacement valid_from', async () => {
    await insert('a');
    await insert('b');
    await db.runAsync(`UPDATE llm_wiki_entries SET valid_from = 42 WHERE id = 'b'`);
    await wiki.supersede('e1', 'a', 'b', { validFrom: 99 });
    expect((await temporal('b')).valid_from).toBe(42);
    expect((await temporal('a')).valid_to).toBe(99);
  });

  it.each([
    ['not_found', async () => wiki.supersede('e1', 'missing', { title: 't', body: 'b' })],
    ['cross_entity', async () => { await insert('x', 'e2'); return wiki.supersede('e1', 'x', { title: 't', body: 'b' }); }],
    ['immutable_target', async () => { await insert('doc', 'e1', 'immutable_document'); return wiki.supersede('e1', 'doc', { title: 't', body: 'b' }); }],
    ['cycle', async () => { await insert('a'); return wiki.supersede('e1', 'a', 'a'); }],
  ])('rejects %s', async (reason, run) => {
    await expect(run()).rejects.toMatchObject({ name: 'WikiSupersedeError', reason });
  });

  it('rejects already_superseded and a replacement that is an ancestor (cycle)', async () => {
    await insert('v1');
    await insert('v2');
    await wiki.supersede('e1', 'v1', 'v2');
    await expect(wiki.supersede('e1', 'v1', { title: 't', body: 'b' })).rejects.toMatchObject({ reason: 'already_superseded' });
    await expect(wiki.supersede('e1', 'v2', 'v1')).rejects.toBeInstanceOf(WikiSupersedeError);
  });

  it('leaves no partial writes on rejection', async () => {
    await insert('doc', 'e1', 'immutable_document');
    const before = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_wiki_entries`);
    await expect(wiki.supersede('e1', 'doc', { title: 't', body: 'b' })).rejects.toThrow();
    expect(await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_wiki_entries`)).toEqual(before);
  });

  it('does not append to the events table (events are librarian input)', async () => {
    await insert('a');
    await wiki.supersede('e1', 'a', { title: 't', body: 'b' });
    expect((await db.getAllAsync(`SELECT 1 FROM llm_wiki_events`)).length).toBe(0);
  });
});

describe('history()', () => {
  it('returns the chain oldest → newest from any member', async () => {
    await insert('v1');
    const { newId: v2 } = await wiki.supersede('e1', 'v1', { title: 'v2', body: 'b' }, { validFrom: 200 });
    const { newId: v3 } = await wiki.supersede('e1', v2, { title: 'v3', body: 'b' }, { validFrom: 300 });
    for (const start of ['v1', v2, v3]) {
      expect((await wiki.history('e1', start)).map((f) => f.id)).toEqual(['v1', v2, v3]);
    }
  });
  it('returns [] for an unknown id and [fact] for an unlinked fact', async () => {
    await insert('solo');
    expect(await wiki.history('e1', 'nope')).toEqual([]);
    expect((await wiki.history('e1', 'solo')).map((f) => f.id)).toEqual(['solo']);
  });
});