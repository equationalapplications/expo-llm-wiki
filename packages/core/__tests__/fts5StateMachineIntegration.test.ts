// packages/core/__tests__/fts5StateMachineIntegration.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { fts5TriggerNames } from '../src/services/search/fts5Sql';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const N = 2400;
const stub = { llmProvider: { generateText: async () => '{}' } };
const open = async (db: SQLiteAdapter, setupBudgetMs = 1) => {
  const w = new WikiMemory(db, { ...stub, config: { indexStrategy: 'fts5', setupBudgetMs } });
  await w.setup();
  return w;
};
const stateOf = (db: SQLiteAdapter) => new MetadataRepository(db, P).getMeta('fts5_index_state');
async function builtStore(): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await open(db, 1500);
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < N; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
    }
  });
  await open(db, 60_000); // drain the backlog: live, fully indexed
  expect(await stateOf(db)).toBe('live');
  return db;
}
async function expectExactlyOnce(db: SQLiteAdapter): Promise<void> {
  const live = await db.getAllAsync<{ id: string; title: string }>(`SELECT id, title FROM ${P}entries WHERE deleted_at IS NULL ORDER BY id`);
  expect(await db.getAllAsync(`SELECT id, title FROM ${P}entries_fts ORDER BY id`)).toEqual(live);
  expect((await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_map`))!.n).toBe(live.length);
}
async function convergeByOpens(db: SQLiteAdapter, max = 100): Promise<WikiMemory> {
  let w = await open(db);
  for (let i = 0; i < max && (await stateOf(db)) !== 'live'; i++) w = await open(db);
  expect(await stateOf(db)).toBe('live');
  return w;
}

describe('FTS state machine, integration (#280 B7, ≥2k rows)', () => {
  it('7(g) marker + trigger loss: re-arm on open, triggers present after the transition and after a mid-rebuild resume', async () => {
    const db = await builtStore();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
    await db.execAsync(`DROP TRIGGER ${fts5TriggerNames(P)[2]}`);
    await open(db);
    expect(await stateOf(db)).toBe('rebuilding');
    const trig = async () => (await db.getAllAsync(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)).length;
    expect(await trig()).toBe(3);
    await open(db); // mid-rebuild resume
    expect(await trig()).toBe(3);
    const w = await convergeByOpens(db);
    await expectExactlyOnce(db);
    expect((await w.__testAccess.searchService.searchKeyword('cedar', ['e1'], 10_000)).length).toBe(N);
  });

  it('7(j) resume across opens from watermark K is exactly-once', async () => {
    const db = await builtStore();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
    await open(db); await open(db); await open(db);
    const wm = JSON.parse((await new MetadataRepository(db, P).getMeta('fts5_rebuild_wm'))!);
    expect(wm.rowid).toBeGreaterThan(0);
    expect(wm.rowid).toBeLessThan(N);
    await convergeByOpens(db);
    await expectExactlyOnce(db);
  });

  it('7(a) concurrent writes between opens, incl. drain-before-window, stay exactly-once', async () => {
    const db = await builtStore();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
    const w = await open(db);
    await db.runAsync(`UPDATE ${P}entries SET title = 'zebra' WHERE id = 'r2300'`);
    await w.__testAccess.searchService.syncEntries('e1', ['r2300']); // drained ahead of its window
    for (let i = 0; i < 5; i++) {
      await db.runAsync(`UPDATE ${P}entries SET title = ? WHERE id = ?`, [`yak ${i}`, `r${i * 400}`]);
      await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', 'new', 'b', '[]', 1, 1)`, [`n${i}`]);
      await open(db);
    }
    const last = await convergeByOpens(db);
    await expectExactlyOnce(db);
    expect((await last.__testAccess.searchService.searchKeyword('zebra', ['e1'], 10)).map((r) => r.id)).toEqual(['r2300']);
  });
});
