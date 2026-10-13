// packages/core/__tests__/fts5RenameRetire.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy, ftsCorruptionClass, isSqliteError } from '../src/services/search/Fts5IndexStrategy';
import { createIndexStrategy } from '../src/services/search/createIndexStrategy';
import { UnavailableIndexStrategy } from '../src/services/search/UnavailableIndexStrategy';
import { FTS5_STATE_KEY, FTS5_RETIRED_TABLES_KEY } from '../src/services/search/fts5Sql';
import { probePendingWork } from '../src/db/sourceRefNormalize';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;
beforeEach(async () => { db = openTestDatabase(); await setupDatabase(db, P); meta = new MetadataRepository(db, P); });
afterEach(() => vi.restoreAllMocks());

async function liveStore(n: number): Promise<Fts5IndexStrategy> {
  const s = new Fts5IndexStrategy(db, P, meta);
  await s.init({ entriesExisted: false });
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
    }
  });
  await s.drain();
  return s;
}
/** FTS5 virtual tables only (shadow tables are ordinary tables). */
const tables = async () => (await db.getAllAsync<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%' AND name LIKE '${P}entries_fts%' ORDER BY name`,
)).map((r) => r.name);
const retired = async () => JSON.parse((await meta.getMeta(FTS5_RETIRED_TABLES_KEY)) ?? '[]') as string[];
const state = () => meta.getMeta(FTS5_STATE_KEY);
async function swapTokenizer(): Promise<void> {
  await db.execAsync(`DROP TABLE ${P}entries_fts; DELETE FROM ${P}fts_map;
    CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tags, tokenize = 'unicode61');
    INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags) SELECT rowid, id, entity_id, title, body, '' FROM ${P}entries;`);
}

describe('rename-retire (#280 B4, 7(u))', () => {
  it('(i) a tokenizer-mismatch store renames, not drops: retired_1 exists, the new table is empty, converges to live', async () => {
    const s = await liveStore(1200);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await tables()).toEqual([`${P}entries_fts`, `${P}entries_fts_retired_1`]);
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`]);
    expect((await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}entries_fts`))!.n).toBe(0);
    expect(await meta.getTableDdl(`${P}entries_fts`)).toMatch(/porter unicode61/);
    for (let i = 0; i < 20 && (await state()) !== 'live'; i++) await s.drain({ mode: 'full', deadline: 0 });
    expect(await state()).toBe('live');
  });

  it('(ii) full quanta reclaim the retired table in bounded ≤500-row steps, then drop it; the list empties', async () => {
    const s = await liveStore(1200);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    const run = vi.spyOn(db, 'runAsync');
    await s.drain(); // generous deadline: converge + reclaim
    const deletes = run.mock.calls.filter((c) => String(c[0]).startsWith(`DELETE FROM ${P}entries_fts_retired_1`));
    expect(deletes.length).toBe(3); // 500 + 500 + 200
    expect(await tables()).toEqual([`${P}entries_fts`]);
    expect(await retired()).toEqual([]);
    expect(await state()).toBe('live');
  });

  it('(iii) a forced RENAME failure falls back to DROP', async () => {
    await liveStore(10);
    await swapTokenizer();
    const orig = db.execAsync.bind(db);
    vi.spyOn(db, 'execAsync').mockImplementation(async (sql: string) => {
      if (/ALTER TABLE .*entries_fts RENAME TO/.test(sql)) throw new Error('rename failed');
      return orig(sql);
    });
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await tables()).toEqual([`${P}entries_fts`]);
    expect(await retired()).toEqual([]);
    expect(await state()).toBe('rebuilding');
  });

  it('marker loss does NOT take the reset path (no retired table)', async () => {
    await liveStore(10);
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await tables()).toEqual([`${P}entries_fts`]);
    expect(await state()).toBe('rebuilding');
  });

  it('retired names increase monotonically across resets', async () => {
    await liveStore(10);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`, `${P}entries_fts_retired_2`]);
  });

  it('until B8 decides hand-off, retired tables are not pending migration work', async () => {
    await liveStore(10);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    await meta.setMeta('schema_version', '15', db);
    await meta.setMeta('source_ref_normalize_stamp', JSON.stringify({ schema_version: 14, normalize_alg: 1 }), db);
    expect(await probePendingWork(db, meta, P)).toBeNull();
  });
});

describe('corruption repair (#280 B4, 7(e) corrupt-FTS leg)', () => {
  const corruptVtab = () => Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT_VTAB' });

  it('ftsCorruptionClass is Proxy-safe and classifies codes', () => {
    expect(ftsCorruptionClass(corruptVtab())).toBe('vtab');
    expect(ftsCorruptionClass(new Error('Error code 267: vtable constructor failed'))).toBe('vtab');
    expect(ftsCorruptionClass(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe('corrupt');
    expect(ftsCorruptionClass(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }))).toBeNull();
    expect(ftsCorruptionClass(new Proxy({}, { get() { throw new Error('trap'); } }))).toBeNull();
    expect(ftsCorruptionClass(null)).toBeNull();
  });

  it('isSqliteError is Proxy-safe and recognises both adapter shapes', () => {
    expect(isSqliteError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED' }))).toBe(true);
    expect(isSqliteError(new Error('Error code 5: database is locked'))).toBe(true);
    expect(isSqliteError(new TypeError('x'))).toBe(false);
    expect(isSqliteError(new Proxy({}, { get() { throw new Error('trap'); } }))).toBe(false);
    expect(isSqliteError(null)).toBe(false);
  });

  it.each(['auto', 'fts5'] as const)("SQLITE_CORRUPT_VTAB from the FTS-only fast-path probe repairs under '%s'", async (pref) => {
    await liveStore(10);
    const orig = db.getFirstAsync.bind(db);
    let thrown = false;
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (!thrown && sql.includes(`FROM ${P}entries_fts ORDER BY rowid DESC`)) { thrown = true; throw corruptVtab(); }
      return orig(sql, args as never);
    }) as never);
    const s = await createIndexStrategy(db, P, meta, pref);
    expect(s).toBeInstanceOf(Fts5IndexStrategy);
    expect(await state()).toBe('rebuilding');
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`]);
    expect(await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = '${P}fts_pending'`)).not.toBeNull(); // never detached
    await (s as Fts5IndexStrategy).drain();
    expect(await state()).toBe('live');
    expect((await s.search('cedar', { entityIds: ['e1'], limit: 50 })).length).toBe(10);
  });

  it("a generic SQLITE_CORRUPT from entries does NOT reset: 'auto' -> UnavailableIndexStrategy, no retired table", async () => {
    await liveStore(10);
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (sql.includes(`coalesce(max(rowid), 0) AS hi FROM ${P}entries`)) throw Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' });
      return orig(sql, args as never);
    }) as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createIndexStrategy(db, P, meta, 'auto')).toBeInstanceOf(UnavailableIndexStrategy);
    expect(await retired()).toEqual([]);
    expect(await state()).toBeNull(); // the re-arm tx rolled back
  });

  it("SQLITE_CORRUPT (generic) from the FTS-only fast-path seek resets", async () => {
    await liveStore(10);
    const orig = db.getFirstAsync.bind(db);
    let thrown = false;
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (!thrown && sql.includes(`FROM ${P}entries_fts ORDER BY rowid DESC`)) { thrown = true; throw Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' }); }
      return orig(sql, args as never);
    }) as never);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`]);
    expect(await state()).toBe('rebuilding');
  });

  it('SQLITE_CORRUPT from the entries_fts_docsize count on the marker-loss path resets', async () => {
    await liveStore(10);
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    const orig = db.getFirstAsync.bind(db);
    let thrown = false;
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (!thrown && sql.includes(`${P}entries_fts_docsize`)) { thrown = true; throw Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' }); }
      return orig(sql, args as never);
    }) as never);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`]);
    expect(await state()).toBe('rebuilding');
  });

  it('a failing reclamation DELETE never fails drain() or the flip; the table stays listed', async () => {
    const s = await liveStore(1200);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    const orig = db.runAsync.bind(db);
    vi.spyOn(db, 'runAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (String(sql).startsWith(`DELETE FROM ${P}entries_fts_retired_1`)) throw Object.assign(new Error('database table is locked'), { code: 'SQLITE_LOCKED' });
      return orig(sql, args as never);
    }) as never);
    await expect(s.drain()).resolves.toBeUndefined();
    expect(await state()).toBe('live');
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`]);
  });

  it('a corrupt retired table is dropped and delisted, not retried forever (final review I2)', async () => {
    const s = await liveStore(1200);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (String(sql).startsWith(`SELECT rowid FROM ${P}entries_fts_retired_1`)) throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT_VTAB' });
      return orig(sql, args as never);
    }) as never);
    await expect(s.drain()).resolves.toBeUndefined();
    expect(await state()).toBe('live');
    expect(await retired()).toEqual([]);
    expect(await tables()).toEqual([`${P}entries_fts`]);
  });

  it('a corrupt retired table whose DROP also fails is still delisted (final review I2)', async () => {
    const s = await liveStore(1200);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    const origGet = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (String(sql).startsWith(`SELECT rowid FROM ${P}entries_fts_retired_1`)) throw Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' });
      return origGet(sql, args as never);
    }) as never);
    const origExec = db.execAsync.bind(db);
    vi.spyOn(db, 'execAsync').mockImplementation((async (sql: string) => {
      if (String(sql).startsWith(`DROP TABLE IF EXISTS ${P}entries_fts_retired_1`)) throw Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' });
      return origExec(sql);
    }) as never);
    await expect(s.drain()).resolves.toBeUndefined();
    expect(await retired()).toEqual([]);
    const reads = vi.mocked(db.getFirstAsync).mock.calls.filter((c) => String(c[0]).includes('entries_fts_retired_1')).length;
    await s.drain();
    expect(vi.mocked(db.getFirstAsync).mock.calls.filter((c) => String(c[0]).includes('entries_fts_retired_1')).length).toBe(reads); // no retry
  });

  it('a non-SQLite error from reclamation propagates instead of being swallowed (final review I2)', async () => {
    const s = await liveStore(1200);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    const orig = db.runAsync.bind(db);
    vi.spyOn(db, 'runAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (String(sql).startsWith(`DELETE FROM ${P}entries_fts_retired_1`)) throw new TypeError('programming error');
      return orig(sql, args as never);
    }) as never);
    await expect(s.drain()).rejects.toThrow(TypeError);
    expect(await state()).toBe('live'); // the flip committed before reclamation
  });

  it('a transient SQLITE_BUSY from an FTS-only statement does NOT reset (F7)', async () => {
    await liveStore(10);
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (sql.includes(`FROM ${P}entries_fts ORDER BY rowid DESC`)) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      return orig(sql, args as never);
    }) as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createIndexStrategy(db, P, meta, 'auto')).toBeInstanceOf(UnavailableIndexStrategy);
    expect(await retired()).toEqual([]);
    expect(await state()).toBe('live');
  });
});
