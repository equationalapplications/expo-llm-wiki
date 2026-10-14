// packages/core/__tests__/fts5StateMachine.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { createIndexStrategy } from '../src/services/search/createIndexStrategy';
import { MiniSearchIndexStrategy } from '../src/services/search/MiniSearchIndexStrategy';
import {
  FTS5_DRAIN_CHUNK, FTS5_STATE_KEY, FTS5_REBUILD_WM_KEY, FTS5_REBUILD_SNAPSHOT_KEY, FTS5_SWEEP_CURSOR_KEY, fts5TriggerNames,
} from '../src/services/search/fts5Sql';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;

beforeEach(async () => {
  db = openTestDatabase();
  await setupDatabase(db, P);
  meta = new MetadataRepository(db, P);
});

async function bulk(n: number, entity = 'e1'): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, 'b', '[]', 1, 1)`,
        [`${entity}_${i}`, entity, `cedar ${i}`]);
    }
  });
}
const count = async (t: string) => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}${t}`))!.n;
const state = () => meta.getMeta(FTS5_STATE_KEY);
const triggers = async () => (await db.getAllAsync<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)).map((r) => r.name);
const ftsDdl = () => meta.getTableDdl(`${P}entries_fts`);

/** A live store with n indexed rows. */
async function liveStore(n: number): Promise<Fts5IndexStrategy> {
  const s = new Fts5IndexStrategy(db, P, meta);
  await s.init({ entriesExisted: false });
  await bulk(n);
  await s.drain();
  expect(await state()).toBe('live');
  return s;
}

describe('live-row probe is bounded on every open (final review M1)', () => {
  it('an all-soft-deleted store with an empty fts_map reads at most FTS5_DRAIN_CHUNK entries rows, and stays live', async () => {
    await liveStore(0);
    await bulk(1200);
    await db.runAsync(`UPDATE ${P}entries SET deleted_at = 1`);
    await new Fts5IndexStrategy(db, P, meta).drain();
    expect(await count('fts_map')).toBe(0);
    const get = vi.spyOn(db, 'getFirstAsync');
    await new Fts5IndexStrategy(db, P, meta).init();
    const probes = get.mock.calls.map((c) => String(c[0])).filter((q) => q.includes(`FROM ${P}entries`) && q.includes('deleted_at IS NULL'));
    expect(probes).toHaveLength(1);
    for (const dir of ['ASC', 'DESC']) {
      expect(probes[0]).toMatch(new RegExp(`\\(SELECT id, deleted_at FROM ${P}entries ORDER BY rowid ${dir} LIMIT ${FTS5_DRAIN_CHUNK}\\)`));
    }
    expect(await state()).toBe('live');
    get.mockRestore();
  });

  it('a lost index with a live row among the newest rows is still detected (rebuild)', async () => {
    await liveStore(0);
    await bulk(1200);
    await db.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id != 'e1_1199'`);
    await new Fts5IndexStrategy(db, P, meta).drain();
    await db.execAsync(`DELETE FROM ${P}fts_map; DELETE FROM ${P}entries_fts; DELETE FROM ${P}fts_pending;`);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
  });

  it('a lost index stays detected after post-loss writes were drained into the map (#284 review)', async () => {
    const s = await liveStore(30);
    await db.execAsync(`DELETE FROM ${P}fts_map; DELETE FROM ${P}entries_fts;`);
    await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES ('late', 'e1', 'cedar late', 'b', '[]', 1, 1)`);
    await s.drain({ mode: 'ledger' }); // the post-loss write repopulates the map: the old probe never fired again
    expect(await count('fts_map')).toBe(1);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
  });

  it('a healthy live store with an undrained ledger stays live', async () => {
    await liveStore(30);
    await bulk(5, 'e2');
    await db.runAsync(`UPDATE ${P}entries SET title = 'moved' WHERE id = 'e1_0'`);
    expect(await count('fts_pending')).toBe(6);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('live');
  });
});

describe('init transitions (#280 B2)', () => {
  it('fresh store (entriesExisted: false) goes straight to live with the pending indexes', async () => {
    await new Fts5IndexStrategy(db, P, meta).init({ entriesExisted: false });
    expect(await state()).toBe('live');
    expect(await triggers()).toEqual([...fts5TriggerNames(P)].sort());
    expect(await meta.getMeta(FTS5_REBUILD_WM_KEY)).toBeNull();
  });

  it('pre-FTS store (entries exist, no state) enters rebuilding via the re-arm', async () => {
    await bulk(10);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!)).toEqual({ rowid: 0, id: null });
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_SNAPSHOT_KEY))!)).toEqual({ entries: 10, map: 0 });
    expect(await meta.getMeta(FTS5_SWEEP_CURSOR_KEY)).toBe('0');
  });

  it('7(g) marker loss on an intact store: keep-map re-arm, no DDL change, index rows kept', async () => {
    await liveStore(50);
    const ddl = await ftsDdl();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
    expect(await ftsDdl()).toBe(ddl);
    expect(await count('entries_fts')).toBe(50);
    expect(await count('fts_map')).toBe(50);
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_SNAPSHOT_KEY))!)).toEqual({ entries: 50, map: 50 });
  });

  it('7(g) trigger loss: triggers re-created, ledger cleared, map kept', async () => {
    await liveStore(20);
    await db.execAsync(`DROP TRIGGER ${fts5TriggerNames(P)[1]}`);
    await db.runAsync(`UPDATE ${P}entries SET title = 'changed' WHERE id = 'e1_3'`); // not ledgered: au is gone
    await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES ('x','e1','t','b','[]',1,1)`);
    expect(await count('fts_pending')).toBe(1);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
    expect(await triggers()).toEqual([...fts5TriggerNames(P)].sort());
    expect(await count('fts_pending')).toBe(0);
    expect(await count('fts_map')).toBe(20);
  });

  it('rebuilding + all triggers present: resume is a no-op', async () => {
    await bulk(5);
    await new Fts5IndexStrategy(db, P, meta).init();
    await meta.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 3, id: 'e1_2' }), db);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!)).toEqual({ rowid: 3, id: 'e1_2' });
  });

  it('rebuilding + a trigger lost mid-rebuild: restart (watermark back to 0), triggers present', async () => {
    await bulk(5);
    await new Fts5IndexStrategy(db, P, meta).init();
    await meta.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 3, id: 'e1_2' }), db);
    await db.execAsync(`DROP TRIGGER ${fts5TriggerNames(P)[0]}`);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!)).toEqual({ rowid: 0, id: null });
    expect(await triggers()).toEqual([...fts5TriggerNames(P)].sort());
  });

  it('live + live row + empty map + empty ledger: reset re-arm', async () => {
    await liveStore(5);
    await db.execAsync(`DELETE FROM ${P}fts_map; DELETE FROM ${P}entries_fts;`);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
  });

  it('live + empty map + a FULL ledger (crash before first drain): fast path, stays live', async () => {
    await new Fts5IndexStrategy(db, P, meta).init({ entriesExisted: false });
    await bulk(5);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('live');
    expect(await count('fts_pending')).toBe(5);
  });

  describe('consistency check: failed checks take the reset path', () => {
    const lose = () => db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);

    it('ghost FTS rowid beyond max(fts_map.fts_rowid)', async () => {
      await liveStore(10);
      await db.runAsync(`INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags) VALUES (9999, 'g', 'e1', 'ghost', '', '')`);
      await lose();
      await new Fts5IndexStrategy(db, P, meta).init();
      expect(await count('entries_fts')).toBe(0);
      expect(await count('fts_map')).toBe(0);
      expect(await state()).toBe('rebuilding');
    });

    it('docsize count != fts_map count (a ghost in a gap)', async () => {
      await liveStore(10);
      await db.runAsync(`DELETE FROM ${P}fts_map WHERE fts_rowid = 3`);
      await lose();
      await new Fts5IndexStrategy(db, P, meta).init();
      expect(await count('entries_fts')).toBe(0);
      expect(await count('fts_map')).toBe(0);
    });

    it('fts_map missing while entries_fts has rows', async () => {
      await liveStore(10);
      await db.execAsync(`DROP TABLE ${P}fts_map`);
      await lose();
      await new Fts5IndexStrategy(db, P, meta).init();
      expect(await count('entries_fts')).toBe(0);
      expect(await count('fts_map')).toBe(0);
      expect(await state()).toBe('rebuilding');
    });
  });

  describe('7(f) detached stores', () => {
    it("pinned 'minisearch' keeps a detached store detached", async () => {
      await liveStore(5);
      await createIndexStrategy(db, P, meta, 'minisearch');
      expect(await createIndexStrategy(db, P, meta, 'minisearch')).toBeInstanceOf(MiniSearchIndexStrategy);
      expect(await state()).toBe('detached');
    });

    it.each(['auto', 'fts5'] as const)("'%s' re-attaches a detached store into rebuilding (no single-tx rebuild)", async (pref) => {
      await liveStore(5);
      await createIndexStrategy(db, P, meta, 'minisearch');
      const s = await createIndexStrategy(db, P, meta, pref);
      expect(s).toBeInstanceOf(Fts5IndexStrategy);
      expect(await state()).toBe('rebuilding');
      expect(await count('entries_fts')).toBe(0);
      expect(await count('fts_map')).toBe(0);
    });

    it("F12: pinned 'minisearch' detaches a rebuilding store (transition table: live/rebuilding -> detached)", async () => {
      await bulk(5);
      await new Fts5IndexStrategy(db, P, meta).init();
      expect(await state()).toBe('rebuilding');
      await createIndexStrategy(db, P, meta, 'minisearch');
      expect(await state()).toBe('detached');
    });
  });

  it('every probe runs before the first mutation: a probe failure leaves zero mutation', async () => {
    await liveStore(5);
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (sql.includes('entries_fts_docsize')) throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      return orig(sql, args as never);
    }) as never);
    await expect(new Fts5IndexStrategy(db, P, meta).init()).rejects.toThrow('disk I/O error');
    vi.restoreAllMocks();
    expect(await state()).toBeNull();
    expect(await meta.getMeta(FTS5_REBUILD_WM_KEY)).toBeNull();
  });
});
