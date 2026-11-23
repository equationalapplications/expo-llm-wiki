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
    await wiki.supersede('e1', 'a', 'b', { validFrom: 200 });
    expect((await temporal('b')).valid_from).toBe(42);
    expect((await temporal('a')).valid_to).toBe(200);
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

  it('rejects a replacement that is itself superseded', async () => {
    await insert('a');
    await insert('b');
    await insert('c');
    await wiki.supersede('e1', 'b', 'c');
    await expect(wiki.supersede('e1', 'a', 'b')).rejects.toMatchObject({ reason: 'already_superseded' });
    expect((await temporal('a')).superseded_by).toBeNull();
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

  it('rejects an empty interval with invalid_interval (t == start)', async () => {
    await insert('seattle'); // created_at defaults to 100
    await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 100 }))
      .rejects.toMatchObject({ reason: 'invalid_interval' });
    const t = await temporal('seattle');
    expect(t.valid_to).toBeNull();
    expect(t.superseded_by).toBeNull();
  });

  it('rejects an inverted interval with invalid_interval (t < start)', async () => {
    await insert('seattle');
    await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 99 }))
      .rejects.toMatchObject({ reason: 'invalid_interval' });
  });

  it('uses valid_from over created_at as the start', async () => {
    await insert('seattle'); // created_at 100
    await db.runAsync(`UPDATE llm_wiki_entries SET valid_from = 500 WHERE id = 'seattle'`);
    await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 400 }))
      .rejects.toMatchObject({ reason: 'invalid_interval' });
    const { newId } = await wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 600 });
    const t = await temporal('seattle');
    expect(t.valid_to).toBe(600);
    expect(t.superseded_by).toBe(newId);
  });

  it('uses created_at only when valid_from is absent (?? not Math.max)', async () => {
    await insert('seattle'); // created_at 100
    await db.runAsync(`UPDATE llm_wiki_entries SET valid_from = 50 WHERE id = 'seattle'`);
    const { newId } = await wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 75 });
    const t = await temporal('seattle');
    expect(t.valid_to).toBe(75);
    expect(t.superseded_by).toBe(newId);
  });

  it('reports already_expired before invalid_interval (guard order, spec D2)', async () => {
    await insert('seattle'); // created_at 100
    await db.runAsync(`UPDATE llm_wiki_entries SET valid_to = 50 WHERE id = 'seattle'`);
    await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 40 }))
      .rejects.toMatchObject({ reason: 'already_expired' });
  });

  it('rejects a default validFrom on a future-dated fact until its start', async () => {
    await insert('seattle'); // created_at 100
    await db.runAsync(`UPDATE llm_wiki_entries SET valid_from = 9999999999999 WHERE id = 'seattle'`);
    await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }))
      .rejects.toMatchObject({ reason: 'invalid_interval' });
  });

  it('leaves no partial writes when the interval rejects', async () => {
    await insert('seattle');
    await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 50 }))
      .rejects.toMatchObject({ reason: 'invalid_interval' });
    const rows = await db.getAllAsync<any>(`SELECT id FROM llm_wiki_entries`);
    expect(rows.map((r) => r.id)).toEqual(['seattle']);
    const t = await temporal('seattle');
    expect(t.superseded_by).toBeNull();
  });

  it('still allows an explicit early valid_from on the replacement (scope boundary, spec D3.3)', async () => {
    await insert('seattle'); // created_at 100
    const { newId } = await wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b', valid_from: 50 }, { validFrom: 200 });
    const fresh = await temporal(newId);
    expect(fresh.valid_from).toBe(50);
    const t = await temporal('seattle');
    expect(t.valid_to).toBe(200);
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
describe('supersede() records a replaced scheduled end (specs/supersede-future-valid-to D2/D3)', () => {
  const FUTURE = Date.now() + 7 * 86_400_000;
  const prior = (id: string) =>
    db.getFirstAsync<any>(`SELECT prior_valid_to FROM llm_wiki_entries WHERE id = ?`, [id]).then((r) => r.prior_valid_to);

  async function withDiag() {
    const diagnostics: any[] = [];
    const d = openTestDatabase();
    const w = new WikiMemory(d, { llmProvider: { generateText: async () => '{}' }, onDiagnostic: (x: any) => diagnostics.push(x) } as never);
    await w.setup();
    return { d, w, diagnostics };
  }

  it('stores prior_valid_to and reports once for a future valid_to', async () => {
    const { d, w, diagnostics } = await withDiag();
    await d.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('old','e1','t','b',100,100)`);
    await w.expire('e1', 'old', { at: FUTURE });
    await w.supersede('e1', 'old', { title: 'SF', body: 'b' }, { validFrom: 5_000 });
    const row = await d.getFirstAsync<any>(`SELECT valid_to, prior_valid_to FROM llm_wiki_entries WHERE id='old'`);
    expect(row).toEqual({ valid_to: 5_000, prior_valid_to: FUTURE });
    const rep = diagnostics.filter((x) => x.code === 'supersede_scheduled_end_replaced');
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ severity: 'info', operation: 'supersede', trigger: 'call', entityId: 'e1', detail: { factId: 'old', priorValidTo: FUTURE } });
  });

  it('open-ended supersede leaves prior_valid_to null and emits nothing', async () => {
    const { d, w, diagnostics } = await withDiag();
    await d.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('old','e1','t','b',100,100)`);
    await w.supersede('e1', 'old', { title: 'SF', body: 'b' }, { validFrom: 5_000 });
    expect((await d.getFirstAsync<any>(`SELECT prior_valid_to FROM llm_wiki_entries WHERE id='old'`)).prior_valid_to).toBeNull();
    expect(diagnostics.filter((x) => x.code === 'supersede_scheduled_end_replaced')).toHaveLength(0);
  });

  it('a rejected supersede (already_expired) records nothing and emits nothing', async () => {
    await insert('old');
    await db.runAsync(`UPDATE llm_wiki_entries SET valid_to = 200 WHERE id = 'old'`);
    await expect(wiki.supersede('e1', 'old', { title: 'x', body: 'y' })).rejects.toMatchObject({ reason: 'already_expired' });
    expect(await prior('old')).toBeNull();
  });

  it('outbox UPDATE payload for supersede carries prior_valid_to', async () => {
    const d = openTestDatabase();
    const w = new WikiMemory(d, { llmProvider: { generateText: async () => '{}' }, config: { enableOutbox: true } });
    await w.setup();
    await d.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('old','e1','t','b',100,100)`);
    await w.expire('e1', 'old', { at: FUTURE });
    await d.runAsync(`DELETE FROM llm_wiki_outbox`);
    await w.supersede('e1', 'old', { title: 'SF', body: 'b' }, { validFrom: 5_000 });
    const rows = await d.getAllAsync<any>(`SELECT payload FROM llm_wiki_outbox WHERE record_id = 'old' AND operation = 'UPDATE'`);
    expect(rows.map((r) => JSON.parse(r.payload)).some((p) => p.prior_valid_to === FUTURE && p.valid_to === 5_000)).toBe(true);
  });
});
