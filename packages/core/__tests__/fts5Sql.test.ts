import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { tagsExpr, fts5TablesDdl, fts5TriggersDdl, fts5TriggerNames, drainChunkSql, rebuildSql } from '../src/services/search/fts5Sql';
import { toIndexDoc } from '../src/utils/indexDoc';

const tokens = (s: string | null) => (s ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

describe('tagsExpr', () => {
  // Object elements are deliberately absent: no writer produces them, and
  // JS stringifies them as "[object Object]" (spec §PR-2 revision, Drain).
  const cases = [
    '[]', '["alpha"]', '["a b","c"]', '[1, 2.5]', '[true, false]', '[null, "x"]',
    '[["x","y"],"z"]', '["caf\\u00e9"]', '["quote\\"d"]', 'not json', '"just a string"', '{"a":1}', '',
  ];
  it.each(cases)('matches toIndexDoc token stream for %s', (raw) => {
    const db = new Database(':memory:');
    const { v } = db.prepare(`SELECT ${tagsExpr('t')} AS v FROM (SELECT ? AS t)`).get(raw) as { v: string | null };
    const js = toIndexDoc({ id: 'i', entity_id: 'e', title: '', body: '', tags: raw }).tags;
    expect(tokens(v)).toEqual(tokens(js));
  });
});

describe('DDL', () => {
  it('is idempotent and creates the three triggers', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE p_entries (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0)`);
    for (let i = 0; i < 2; i++) { db.exec(fts5TablesDdl('p_')); db.exec(fts5TriggersDdl('p_')); }
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all().map((r: any) => r.name);
    expect(names).toEqual([...fts5TriggerNames('p_')].sort());
  });

  it('triggers ignore non-indexed column updates', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE p_entries (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0)`);
    db.exec(fts5TablesDdl('p_')); db.exec(fts5TriggersDdl('p_'));
    db.exec(`INSERT INTO p_entries (id, entity_id, title, body) VALUES ('a','e','t','b')`);
    db.exec(`UPDATE p_entries SET access_count = access_count + 1 WHERE id = 'a'`);
    expect((db.prepare(`SELECT count(*) AS n FROM p_fts_pending`).get() as any).n).toBe(1);
    db.exec(`UPDATE p_entries SET body = 'b2' WHERE id = 'a'`);
    expect((db.prepare(`SELECT count(*) AS n FROM p_fts_pending`).get() as any).n).toBe(2);
  });

  it('drain chunk and rebuild SQL prepare against the schema', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE p_entries (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER)`);
    db.exec(fts5TablesDdl('p_'));
    for (const s of drainChunkSql('p_')) expect(() => db.prepare(s)).not.toThrow();
    for (const s of rebuildSql('p_')) expect(() => db.prepare(s)).not.toThrow();
  });
});
