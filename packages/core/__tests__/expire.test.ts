// packages/core/__tests__/expire.test.ts
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

describe('expire()', () => {
  it('WikiSupersedeError carries the verb in its message (default unchanged)', () => {
    expect(new WikiSupersedeError('invalid_interval').message).toBe('supersede() rejected: invalid_interval');
    expect(new WikiSupersedeError('already_expired', 'expire()').message).toBe('expire() rejected: already_expired');
  });

  it('archives with valid_to only and honors asOf reads', async () => {
    await insert('f1'); // created_at 100
    await wiki.expire('e1', 'f1', { at: 5_000 });
    expect(await temporal('f1')).toEqual({ valid_from: null, valid_to: 5_000, superseded_by: null, superseded_at: null });
    const row = await db.getFirstAsync<any>(`SELECT deleted_at, body FROM llm_wiki_entries WHERE id = 'f1'`);
    expect(row.deleted_at).toBeNull();
    expect(row.body).toBe('body');
    expect((await wiki.read('e1', 'title f1', { asOf: 4_999 })).facts.map((f) => f.id)).toContain('f1');
    expect((await wiki.read('e1', 'title f1', { asOf: 5_000 })).facts.map((f) => f.id)).not.toContain('f1');
    expect((await wiki.read('e1', 'title f1')).facts.map((f) => f.id)).not.toContain('f1');
  });

  it('defaults at to now', async () => {
    await insert('f1');
    const before = Date.now();
    await wiki.expire('e1', 'f1');
    expect((await temporal('f1')).valid_to).toBeGreaterThanOrEqual(before);
  });

  it('honors an explicit past at (retro-active archive)', async () => {
    await insert('f1');
    await wiki.expire('e1', 'f1', { at: 500 });
    expect((await temporal('f1')).valid_to).toBe(500);
  });

  it('does not create a supersession link (history stays single-member)', async () => {
    await insert('f1');
    await wiki.expire('e1', 'f1', { at: 5_000 });
    expect((await wiki.history('e1', 'f1')).map((f) => f.id)).toEqual(['f1']);
  });

  it('history() still traverses through an expired member (AC6)', async () => {
    await insert('v1');
    const { newId: v2 } = await wiki.supersede('e1', 'v1', { title: 'v2', body: 'b' }, { validFrom: 200 });
    await wiki.expire('e1', v2, { at: 300 });
    expect((await wiki.history('e1', 'v1')).map((f) => f.id)).toEqual(['v1', v2]);
  });
});
