// packages/core/__tests__/fts5IndexStrategy.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { FTS5_STATE_KEY, fts5TriggerNames } from '../src/services/search/fts5Sql';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;

async function put(id: string, entity: string, title: string, body: string, opts: { tags?: string; deleted?: number | null } = {}) {
  await db.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,1,1,?)
     ON CONFLICT(id) DO UPDATE SET entity_id=excluded.entity_id, title=excluded.title,
       body=excluded.body, tags=excluded.tags, deleted_at=excluded.deleted_at`,
    [id, entity, title, body, opts.tags ?? '[]', opts.deleted ?? null],
  );
}
const ftsRows = () => db.getAllAsync<{ id: string; entity_id: string; title: string }>(
  `SELECT id, entity_id, title FROM ${P}entries_fts ORDER BY id`);
const pending = async () => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_pending`))!.n;

beforeEach(async () => {
  db = openTestDatabase();
  await setupDatabase(db, P);
  meta = new MetadataRepository(db, P);
});

describe('Fts5IndexStrategy.init', () => {
  it('first init rebuilds from live entries, installs triggers, marks live', async () => {
    await put('a', 'e1', 'alpha', 'one');
    await put('b', 'e1', 'beta', 'two', { deleted: 5 });
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    expect((await ftsRows()).map((r) => r.id)).toEqual(['a']);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('live');
    const trig = await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='trigger'`);
    expect(trig.map((t) => t.name)).toEqual(expect.arrayContaining([...fts5TriggerNames(P)]));
    expect(await pending()).toBe(0);
  });

  it('second init on a live database does not rebuild', async () => {
    await put('a', 'e1', 'alpha', 'one');
    await new Fts5IndexStrategy(db, P, meta).init();
    await put('b', 'e1', 'beta', 'two'); // queued by trigger, not drained
    await new Fts5IndexStrategy(db, P, meta).init();
    expect((await ftsRows()).map((r) => r.id)).toEqual(['a']);
    expect(await pending()).toBe(1);
  });

  it('live with a missing trigger rebuilds', async () => {
    await put('a', 'e1', 'alpha', 'one');
    await new Fts5IndexStrategy(db, P, meta).init();
    await db.execAsync(`DROP TRIGGER ${fts5TriggerNames(P)[0]}`);
    await put('b', 'e1', 'beta', 'two'); // no insert trigger, so not queued
    await new Fts5IndexStrategy(db, P, meta).init();
    expect((await ftsRows()).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('detached state rebuilds', async () => {
    await put('a', 'e1', 'alpha', 'one');
    await meta.setMeta(FTS5_STATE_KEY, 'detached', db);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect((await ftsRows()).map((r) => r.id)).toEqual(['a']);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('live');
  });
});

describe('Fts5IndexStrategy.drain', () => {
  it('applies insert, update, soft-delete and hard-delete', async () => {
    await put('a', 'e1', 'alpha', 'one');
    await put('c', 'e1', 'gamma', 'three');
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await put('b', 'e1', 'beta', 'two');
    await put('a', 'e1', 'alpha2', 'one');
    await put('c', 'e1', 'gamma', 'three', { deleted: 9 });
    await s.drain();
    expect(await ftsRows()).toEqual([
      { id: 'a', entity_id: 'e1', title: 'alpha2' },
      { id: 'b', entity_id: 'e1', title: 'beta' },
    ]);
    await db.runAsync(`DELETE FROM ${P}entries WHERE id = 'b'`);
    await s.drain();
    expect((await ftsRows()).map((r) => r.id)).toEqual(['a']);
    expect(await pending()).toBe(0);
  });

  it('drains more than one chunk', async () => {
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    for (let i = 0; i < 1203; i++) await put(`f${i}`, 'e1', `t${i}`, 'b');
    await s.drain();
    expect((await ftsRows()).length).toBe(1203);
    expect(await pending()).toBe(0);
  });

  it('rolled-back writes leave no ledger rows', async () => {
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await expect(db.withTransactionAsync(async (tx) => {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES ('x','e1','t','b',1,1)`);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await pending()).toBe(0);
  });

  it('survives VACUUM: an update after vacuum changes exactly that entry', async () => {
    for (let i = 0; i < 20; i++) await put(`f${i}`, 'e1', `t${i}`, 'b');
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await db.runAsync(`DELETE FROM ${P}entries WHERE id IN ('f3','f7')`);
    await s.drain();
    await meta.vacuum();
    await put('f10', 'e1', 'changed', 'b');
    await s.drain();
    const rows = await ftsRows();
    expect(rows.length).toBe(18);
    expect(rows.filter((r) => r.title === 'changed').map((r) => r.id)).toEqual(['f10']);
    expect(rows.find((r) => r.id === 'f11')!.title).toBe('t11');
  });
});

import type { IndexDocument } from '../src/services/search/IndexStrategy';

const doc = (id: string, entity_id: string, title: string, body = '', tags = ''): IndexDocument =>
  ({ id, entity_id, title, body, tags });

describe('Fts5IndexStrategy.search', () => {
  it('ranks title matches above body matches, filters by entity, scores finite and non-negative', async () => {
    await put('t', 'e1', 'cedar grove', 'nothing');
    await put('b', 'e1', 'nothing', 'cedar grove');
    await put('o', 'e2', 'cedar grove', 'other entity');
    for (let i = 0; i < 20; i++) await put(`n${i}`, 'e1', 'filler', 'unrelated words'); // keep IDF > floor
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    const r = await s.search('cedar', { entityIds: ['e1'], limit: 10 });
    expect(r.map((x) => x.id)).toEqual(['t', 'b']);
    for (const x of r) { expect(Number.isFinite(x.score)).toBe(true); expect(x.score).toBeGreaterThanOrEqual(0); expect(x.entity_id).toBe('e1'); }
    expect(r[0].score).toBeGreaterThan(r[1].score);
  });

  it('honors limit, preFilterLimit and MAX_SAFE_INTEGER', async () => {
    for (let i = 0; i < 30; i++) await put(`f${i}`, 'e1', `cedar ${i}`, 'b');
    for (let i = 0; i < 30; i++) await put(`g${i}`, 'e1', 'filler', 'b');
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    expect((await s.search('cedar', { entityIds: ['e1'], limit: 5 })).length).toBe(5);
    expect((await s.search('cedar', { entityIds: ['e1'], limit: 12, preFilterLimit: 12 })).length).toBe(12);
    expect((await s.search('cedar', { entityIds: ['e1'], limit: Number.MAX_SAFE_INTEGER })).length).toBe(30);
  });

  it('returns [] for empty entityIds or a token-less query, and never throws on hostile input', async () => {
    await put('a', 'e1', 'alpha', 'one');
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    expect(await s.search('alpha', { entityIds: [], limit: 10 })).toEqual([]);
    expect(await s.search('"-:()', { entityIds: ['e1'], limit: 10 })).toEqual([]);
    await expect(s.search('alpha NEAR( "x', { entityIds: ['e1'], limit: 10 })).resolves.toBeDefined();
  });
});

describe('Fts5IndexStrategy writes', () => {
  it('replace removes only ids tracked under the entity, then upserts', async () => {
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await s.replaceAll([doc('a', 'e1', 'alpha'), doc('b', 'e1', 'beta'), doc('x', 'e2', 'xray')]);
    await s.replace('e1', ['a', 'x', 'nope'], [doc('c', 'e1', 'gamma'), doc('b', 'e1', 'beta2')]);
    expect(await ftsRows()).toEqual([
      { id: 'b', entity_id: 'e1', title: 'beta2' },
      { id: 'c', entity_id: 'e1', title: 'gamma' },
      { id: 'x', entity_id: 'e2', title: 'xray' },
    ]);
  });

  it('replace and replaceEntity reject a cross-entity document before any discard', async () => {
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await s.replaceAll([doc('a', 'e1', 'alpha')]);
    await expect(s.replace('e1', ['a'], [doc('z', 'e2', 'zed')])).rejects.toThrow(/entity/);
    await expect(s.replaceEntity('e1', [doc('z', 'e2', 'zed')])).rejects.toThrow(/entity/);
    expect((await ftsRows()).map((r) => r.id)).toEqual(['a']);
  });

  it('replaceEntity drops everything under the entity only', async () => {
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await s.replaceAll([doc('a', 'e1', 'alpha'), doc('b', 'e1', 'beta'), doc('x', 'e2', 'xray')]);
    await s.replaceEntity('e1', [doc('c', 'e1', 'gamma')]);
    expect((await ftsRows()).map((r) => r.id)).toEqual(['c', 'x']);
  });

  it('replaceAll([]) empties index, map and ledger', async () => {
    await put('a', 'e1', 'alpha', 'one');
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await put('b', 'e1', 'beta', 'two');
    await s.replaceAll([]);
    expect(await ftsRows()).toEqual([]);
    expect(await pending()).toBe(0);
    expect((await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_map`))!.n).toBe(0);
  });
});
