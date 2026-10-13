// packages/core/__tests__/setupBudget.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { DEFAULT_SETUP_BUDGET_MS } from '../src/index';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const stub = { llmProvider: { generateText: async () => '{}' } } as const;
const open = (db: SQLiteAdapter, config: Record<string, unknown> = {}) =>
  new WikiMemory(db, { ...stub, config: { indexStrategy: 'fts5', ...config } });
const pending = async (db: SQLiteAdapter) => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_pending`))!.n;
const indexes = async (db: SQLiteAdapter) => (await db.getAllAsync<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`, [`${P}fts_pending`])).map((r) => r.name);
async function backlog(db: SQLiteAdapter, n: number): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`b_${i}`, `t ${i}`]);
    }
  });
}

describe('setupBudgetMs (#280 B1)', () => {
  it('defaults to 1500 and is exported', () => {
    expect(DEFAULT_SETUP_BUDGET_MS).toBe(1500);
  });

  it('rejects a non-positive or non-finite budget before touching the store', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const db = openTestDatabase();
      await expect(open(db, { setupBudgetMs: bad }).setup()).rejects.toThrow(TypeError);
      expect(await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = '${P}entries'`)).toBeNull();
    }
  });

  it('setupBudgetMs: 1 leaves a backlog on one open and converges across opens', async () => {
    const db = openTestDatabase();
    await open(db).setup();
    await backlog(db, 3000);
    await open(db, { setupBudgetMs: 1 }).setup();
    expect(await pending(db)).toBeGreaterThan(0);
    for (let i = 0; i < 20 && (await pending(db)) > 0; i++) await open(db, { setupBudgetMs: 1 }).setup();
    expect(await pending(db)).toBe(0);
  });
});

describe('schema v15 (#280 B1)', () => {
  it('CURRENT_SCHEMA_VERSION is 15', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(15);
  });

  it('a fresh FTS5 store gets the fts_pending indexes from init (v15 never runs on it)', async () => {
    const db = openTestDatabase();
    await open(db).setup();
    expect(await indexes(db)).toEqual([`${P}fts_pending_entity`, `${P}fts_pending_id`]);
  });

  it("'refuse' on a v14 store throws schema_migration 14 -> 15 with zero mutation; plain setup() migrates", async () => {
    const db = openTestDatabase();
    await open(db).setup();
    await db.execAsync(`DROP INDEX ${P}fts_pending_id; DROP INDEX ${P}fts_pending_entity;`);
    await db.runAsync(`UPDATE ${P}meta SET value = '14' WHERE key = 'schema_version'`);
    await expect(open(db).setup({ migrations: 'refuse' })).rejects.toMatchObject({
      name: 'WikiMigrationRequiredError',
      pendingWork: { type: 'schema_migration', fromVersion: 14, toVersion: 15 },
    });
    expect(await indexes(db)).toEqual([]);
    expect((await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = 'schema_version'`))!.value).toBe('14');
    await open(db).setup();
    expect(await indexes(db)).toEqual([`${P}fts_pending_entity`, `${P}fts_pending_id`]);
  });

  it('v15 on a store without a ledger (MiniSearch) is a no-op', async () => {
    const db = openTestDatabase();
    await open(db, { indexStrategy: 'minisearch' }).setup();
    await db.runAsync(`UPDATE ${P}meta SET value = '14' WHERE key = 'schema_version'`);
    await open(db, { indexStrategy: 'minisearch' }).setup();
    expect((await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = 'schema_version'`))!.value).toBe('15');
    expect(await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = '${P}fts_pending'`)).toBeNull();
  });
});
