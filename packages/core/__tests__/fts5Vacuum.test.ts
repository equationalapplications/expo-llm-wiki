// packages/core/__tests__/fts5Vacuum.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

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
    await db.runAsync(`UPDATE ${P}entries SET rowid = rowid + 100000`); // what an external VACUUM may do
    await new WikiMemory(db, cfg(1)).setup();
    const after = await wm(meta);
    expect(after.rowid === 0 || after.rowid > 100000).toBe(true); // restarted, then possibly one window
    for (let i = 0; i < 50 && (await meta.getMeta('fts5_index_state')) !== 'live'; i++) await new WikiMemory(db, cfg(1)).setup();
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
