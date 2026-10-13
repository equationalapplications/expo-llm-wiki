// packages/core/__tests__/createIndexStrategy.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { openSqlJsDatabase } from './helpers/sqlJsAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { createIndexStrategy, probeFts5 } from '../src/services/search/createIndexStrategy';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { MiniSearchIndexStrategy } from '../src/services/search/MiniSearchIndexStrategy';
import { UnavailableIndexStrategy } from '../src/services/search/UnavailableIndexStrategy';
import { FTS5_STATE_KEY } from '../src/services/search/fts5Sql';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const FRESH = { entriesExisted: false };
async function fresh(db: SQLiteAdapter) { await setupDatabase(db, P); return new MetadataRepository(db, P); }
const objects = (db: SQLiteAdapter) => db.getAllAsync<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE name LIKE '${P}fts%' OR name LIKE '${P}entries_fts%' ORDER BY name`);

describe('probeFts5', () => {
  it('is true on better-sqlite3, false on sql.js 1.14.2, and leaves no probe table', async () => {
    const b = openTestDatabase();
    expect(await probeFts5(b, P)).toBe(true);
    expect(await b.getAllAsync(`SELECT name FROM sqlite_temp_master WHERE name LIKE '%probe%'`)).toEqual([]);
    expect(await probeFts5(await openSqlJsDatabase(), P)).toBe(false);
  });

  it('is false when json1 is missing', async () => {
    const b = openTestDatabase();
    const orig = b.getFirstAsync.bind(b);
    vi.spyOn(b, 'getFirstAsync').mockImplementation(async (sql: string, p?: unknown[]) => {
      if (sql.includes('json_valid')) throw new Error('no such function: json_valid');
      return orig(sql, p);
    });
    expect(await probeFts5(b, P)).toBe(false);
  });
});

describe('createIndexStrategy', () => {
  it('auto picks FTS5 on better-sqlite3 and marks live', async () => {
    const db = openTestDatabase(); const meta = await fresh(db);
    expect(await createIndexStrategy(db, P, meta, 'auto', FRESH)).toBeInstanceOf(Fts5IndexStrategy);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('live');
  });

  it('auto falls back to MiniSearch on sql.js, creating nothing', async () => {
    const db = await openSqlJsDatabase(); const meta = await fresh(db);
    expect(await createIndexStrategy(db, P, meta, 'auto')).toBeInstanceOf(MiniSearchIndexStrategy);
    expect(await objects(db)).toEqual([]);
  });

  it("'fts5' throws when unavailable", async () => {
    const db = await openSqlJsDatabase(); const meta = await fresh(db);
    await expect(createIndexStrategy(db, P, meta, 'fts5')).rejects.toThrow(/indexStrategy 'fts5'/);
  });

  it("'auto' init failure x2 -> UnavailableIndexStrategy, never detaches; 'fts5' re-throws raw", async () => {
    const db = openTestDatabase(); const meta = await fresh(db);
    await createIndexStrategy(db, P, meta, 'fts5', FRESH); // live, ledger present
    const spy = vi.spyOn(Fts5IndexStrategy.prototype, 'init').mockRejectedValue(new Error('rebuild tx lock'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await createIndexStrategy(db, P, meta, 'auto');
    expect(s).toBeInstanceOf(UnavailableIndexStrategy);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('live');
    expect((await objects(db)).map((r) => r.name)).toEqual(expect.arrayContaining([`${P}fts_map`, `${P}fts_pending`]));
    await expect(s.search('x', { entityIds: ['e'], limit: 5 })).rejects.toMatchObject({ name: 'WikiSearchUnavailableError', cause: expect.objectContaining({ message: 'rebuild tx lock' }) });
    await expect(createIndexStrategy(db, P, meta, 'fts5')).rejects.toThrow(/rebuild tx lock/);
    spy.mockRestore(); warn.mockRestore();
  });

  it("'auto' init fails once then succeeds -> real strategy", async () => {
    const db = openTestDatabase(); const meta = await fresh(db);
    const real = Fts5IndexStrategy.prototype.init;
    const spy = vi.spyOn(Fts5IndexStrategy.prototype, 'init')
      .mockRejectedValueOnce(new Error('busy'))
      .mockImplementation(function (this: Fts5IndexStrategy, o?: { entriesExisted?: boolean }) { return real.call(this, o); });
    expect(await createIndexStrategy(db, P, meta, 'auto', FRESH)).toBeInstanceOf(Fts5IndexStrategy);
    spy.mockRestore();
  });

  it("probe error other than module-absent (SQLITE_IOERR) never detaches (7(e) probe leg)", async () => {
    const db = openTestDatabase(); const meta = await fresh(db);
    await createIndexStrategy(db, P, meta, 'fts5', FRESH);
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, p?: unknown[]) => {
      if (sql.includes('json_valid')) throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      return orig(sql, p as never);
    }) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createIndexStrategy(db, P, meta, 'auto')).toBeInstanceOf(UnavailableIndexStrategy);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('live');
    warn.mockRestore();
  });

  it("pinned 'minisearch' detaches a live database", async () => {
    const db = openTestDatabase(); const meta = await fresh(db);
    await createIndexStrategy(db, P, meta, 'fts5', FRESH);
    expect(await createIndexStrategy(db, P, meta, 'minisearch')).toBeInstanceOf(MiniSearchIndexStrategy);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('detached');
    expect(await objects(db)).toEqual([]); // triggers, ledger, map and entries_fts all gone on better-sqlite3
  });

  it('a live database opened on sql.js detaches; triggers and ledger are gone, writes still work', async () => {
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(':memory:');
    const b: SQLiteAdapter = {
      async execAsync(s) { raw.exec(s); },
      async runAsync(s, a = []) { const i = raw.prepare(s).run(...(a as any[])); return { changes: i.changes, lastInsertRowId: Number(i.lastInsertRowid) }; },
      async getAllAsync(s, a = []) { return raw.prepare(s).all(...(a as any[])) as any; },
      async getFirstAsync(s, a = []) { return (raw.prepare(s).get(...(a as any[])) ?? null) as any; },
      async withTransactionAsync(fn) { raw.exec('BEGIN'); try { const r = await fn(b); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
      async closeAsync() { raw.close(); },
    };
    const bm = await fresh(b);
    await createIndexStrategy(b, P, bm, 'fts5', FRESH);
    const s = await openSqlJsDatabase(raw.serialize());
    const sm = new MetadataRepository(s, P);
    expect(await createIndexStrategy(s, P, sm, 'auto')).toBeInstanceOf(MiniSearchIndexStrategy);
    expect(await sm.getMeta(FTS5_STATE_KEY)).toBe('detached');
    // entries_fts stays (no fts5 module to drop it); shadow tables stay with it.
    const left = (await objects(s)).map((r) => r.name);
    expect(left).not.toContain(`${P}fts_pending`);
    expect(left).not.toContain(`${P}fts_map`);
    await s.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES ('a','e','t','b',1,1)`);
    await s.execAsync('VACUUM'); // verified 2026-10-06: works with a module-less fts5 table present
  });
});
