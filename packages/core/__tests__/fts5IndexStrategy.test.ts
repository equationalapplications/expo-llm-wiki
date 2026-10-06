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
