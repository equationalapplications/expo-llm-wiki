// packages/core/__tests__/fts5Vacuum.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { restartRebuildAfterVacuum } from '../src/services/search/fts5Progress';
import { fts5TriggerNames } from '../src/services/search/fts5Sql';
import { setupDatabase } from '../src/db/schema';

afterEach(() => vi.restoreAllMocks());

const P = 'llm_wiki_';
const stub = { llmProvider: { generateText: async () => '{}' } };
const cfg = (setupBudgetMs?: number) => ({ ...stub, config: { indexStrategy: 'fts5' as const, ...(setupBudgetMs ? { setupBudgetMs } : {}) } });

async function rebuildingStore(): Promise<{ db: SQLiteAdapter; wiki: WikiMemory; meta: MetadataRepository }> {
  const db = openTestDatabase();
  await new WikiMemory(db, cfg()).setup();
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < 1500; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
    }
  });
  await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
  const wiki = new WikiMemory(db, cfg(1));
  await wiki.setup(); // re-arm + one window
  return { db, wiki, meta: new MetadataRepository(db, P) };
}
const wm = async (meta: MetadataRepository) => JSON.parse((await meta.getMeta('fts5_rebuild_wm'))!);
async function expectExactlyOnce(db: SQLiteAdapter): Promise<void> {
  const live = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries WHERE deleted_at IS NULL ORDER BY id`);
  expect(await db.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries_fts ORDER BY id`)).toEqual(live);
  expect((await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_map`))!.n).toBe(live.length);
}

describe('7(k) VACUUM guard (#280 B6)', () => {
  it('in-process runPrune({ vacuum: true }) restarts the rebuild from 0; syncSearchIndex() then completes exactly once', async () => {
    const { db, wiki, meta } = await rebuildingStore();
    expect((await wm(meta)).rowid).toBeGreaterThan(0);
    await wiki.runPrune('e1', { retainSoftDeletedFor: null, retainEventsFor: null, vacuum: true });
    expect(await wm(meta)).toEqual({ rowid: 0, id: null });
    expect(await meta.getMeta('fts5_orphan_sweep_cursor')).toBe('0');
    for (let i = 0; i < 50 && (await meta.getMeta('fts5_index_state')) !== 'live'; i++) await wiki.syncSearchIndex();
    expect(await meta.getMeta('fts5_index_state')).toBe('live');
    await expectExactlyOnce(db);
  });

  it('a post-VACUUM open (rowids renumbered outside the engine) detects the stale fingerprint and restarts', async () => {
    const { db, meta } = await rebuildingStore();
    const stale = await wm(meta);
    expect(stale.rowid).toBeGreaterThan(0);
    expect(stale.rowid).toBeLessThan(100000);
    await db.runAsync(`UPDATE ${P}entries SET rowid = rowid + 100000`); // what an external VACUUM may do
    await db.runAsync(`DELETE FROM ${P}fts_pending`); // a real VACUUM fires no triggers
    await new WikiMemory(db, cfg(1)).setup();
    // The stale fingerprint restarts the rebuild from 0 against a fresh (renumbered) snapshot; that quantum ends at the restart.
    expect(await wm(meta)).toEqual({ rowid: 0, id: null });
    expect(JSON.parse((await meta.getMeta('fts5_rebuild_snapshot'))!).entries).toBe(101500);
    expect(await meta.getMeta('fts5_orphan_sweep_cursor')).toBe('0');
    for (let i = 0; i < 50 && (await meta.getMeta('fts5_index_state')) !== 'live'; i++) await new WikiMemory(db, cfg(1)).setup();
    expect(await meta.getMeta('fts5_index_state')).toBe('live');
    await expectExactlyOnce(db);
  });

  it('a VACUUM restart between two window transactions of one quantum is not overwritten (final review I1)', async () => {
    const db = openTestDatabase();
    const meta = new MetadataRepository(db, P);
    await setupDatabase(db, P);
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init({ entriesExisted: false });
    // Rows reach the index only through windows: triggers off while inserting at high rowids.
    for (const t of fts5TriggerNames(P)) await db.execAsync(`DROP TRIGGER ${t}`);
    await db.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 1500; i++) {
        await tx.runAsync(`INSERT INTO ${P}entries (rowid, id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, 'e1', ?, 'b', '[]', 1, 1)`, [100001 + i, `r${i}`, `cedar ${i}`]);
      }
    });
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
    await new Fts5IndexStrategy(db, P, meta).init(); // trigger loss: keep-map re-arm, empty index, rebuilding
    expect(await meta.getMeta('fts5_index_state')).toBe('rebuilding');

    const orig = db.withTransactionAsync.bind(db);
    let wmWrites = 0;
    let injected = false;
    const origSet = meta.setMeta.bind(meta);
    vi.spyOn(meta, 'setMeta').mockImplementation((async (k: string, v: string, tx?: SQLiteAdapter) => {
      if (k === 'fts5_rebuild_wm') wmWrites++;
      return origSet(k, v, tx);
    }) as never);
    vi.spyOn(db, 'withTransactionAsync').mockImplementation((async (fn: (tx: SQLiteAdapter) => Promise<unknown>) => {
      if (wmWrites === 1 && !injected) {
        injected = true; // between window tx 1 and 2: an in-process VACUUM compacts rowids, then the B6 restart
        await orig(async (tx) => { await tx.runAsync(`UPDATE ${P}entries SET rowid = rowid - 100000`); });
        await restartRebuildAfterVacuum(db, P, meta);
      }
      return orig(fn as never);
    }) as never);
    await s.drain({ mode: 'full', deadline: Number.POSITIVE_INFINITY });
    expect(injected).toBe(true);
    vi.restoreAllMocks();
    for (let i = 0; i < 50 && (await meta.getMeta('fts5_index_state')) !== 'live'; i++) await s.drain();
    expect(await meta.getMeta('fts5_index_state')).toBe('live');
    await expectExactlyOnce(db);
  });

  it('a live store is untouched by the vacuum reset', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, cfg());
    await wiki.setup();
    await wiki.runPrune('e1', { retainSoftDeletedFor: null, retainEventsFor: null, vacuum: true });
    const meta = new MetadataRepository(db, P);
    expect(await meta.getMeta('fts5_index_state')).toBe('live');
    expect(await meta.getMeta('fts5_rebuild_wm')).toBeNull();
  });
});
