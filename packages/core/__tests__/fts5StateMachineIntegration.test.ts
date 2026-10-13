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

  it('content that only windows can deliver: rows written with all triggers off, incl. a soft-delete and a hard-delete orphan (final review I3)', async () => {
    const db = await builtStore();
    for (const t of fts5TriggerNames(P)) await db.execAsync(`DROP TRIGGER ${t}`);
    await db.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 600; i++) {
        await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`w${i}`, `walnut ${i}`]);
      }
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at, deleted_at) VALUES ('wdel', 'e1', 'walnut gone', 'b', '[]', 1, 1, 1)`);
      await tx.runAsync(`UPDATE ${P}entries SET title = 'walnut changed' WHERE id = 'r10'`);
      await tx.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = 'r5'`); // indexed, now soft-deleted
      await tx.runAsync(`DELETE FROM ${P}entries WHERE id = 'r20'`); // indexed, now an orphan map row
    });
    expect(await db.getFirstAsync(`SELECT 1 FROM ${P}fts_pending LIMIT 1`)).toBeNull(); // no ledger: only windows/sweep can converge
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
    const w = await convergeByOpens(db);
    await expectExactlyOnce(db);
    expect(await db.getFirstAsync(`SELECT 1 FROM ${P}fts_map WHERE id IN ('r5', 'r20', 'wdel')`)).toBeNull();
    const hits = await w.__testAccess.searchService.searchKeyword('walnut', ['e1'], 10_000);
    expect(hits.length).toBe(601); // w0..w599 + r10; never wdel
    expect((await w.__testAccess.searchService.searchKeyword('cedar', ['e1'], 10_000)).length).toBe(N - 3);
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
