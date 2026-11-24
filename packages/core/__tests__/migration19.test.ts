import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, addEventsForgottenAtColumn, createEventsForgottenIndex } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions } from '../src/types';

const stubOptions: WikiOptions = { llmProvider: { generateText: async () => '{}' } };
const P = 'llm_wiki_';
const IDX = `${P}events_forgotten_idx`;

async function version(db: SQLiteAdapter): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = 'schema_version'`);
  return row?.value ?? null;
}
async function indexSql(db: SQLiteAdapter): Promise<string | null> {
  const row = await db.getFirstAsync<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, [IDX]);
  return row?.sql ?? null;
}
async function eventCols(db: SQLiteAdapter): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${P}events)`)).map((c) => c.name);
}
async function fresh(): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await new WikiMemory(db, stubOptions).setup();
  return db;
}
async function rollBackTo18(db: SQLiteAdapter): Promise<void> {
  await db.execAsync(`DROP INDEX IF EXISTS ${IDX}`);
  await db.execAsync(`ALTER TABLE ${P}events DROP COLUMN forgotten_at`);
  await db.runAsync(`UPDATE ${P}meta SET value = '18' WHERE key = 'schema_version'`);
}

describe('migration v19: events.forgotten_at and events_forgotten_idx', () => {
  it('is registered; a fresh store has the column, the partial index and the stamp', async () => {
    expect(MIGRATIONS.some((m) => m.version === 19)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
    const db = await fresh();
    expect(await version(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(await eventCols(db)).toContain('forgotten_at');
    const sql = await indexSql(db);
    expect(sql).toContain('(entity_id, forgotten_at)');
    expect(sql).toContain('WHERE forgotten_at IS NOT NULL');
  });

  it('upgrades a v18 store, then a second setup() is a no-op', async () => {
    const db = await fresh();
    await rollBackTo18(db);
    await new WikiMemory(db, stubOptions).setup();
    expect(await eventCols(db)).toContain('forgotten_at');
    expect(await indexSql(db)).not.toBeNull();
    expect(await version(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    await expect(new WikiMemory(db, stubOptions).setup()).resolves.toBeUndefined();
  });

  it("'refuse' on a v18 store throws without building the index; 'allow' builds it", async () => {
    const db = await fresh();
    await rollBackTo18(db);
    await expect(new WikiMemory(db, stubOptions).setup({ migrations: 'refuse' })).rejects.toMatchObject({
      name: 'WikiMigrationRequiredError',
    });
    expect(await indexSql(db)).toBeNull();
    expect(await version(db)).toBe('18');
    await new WikiMemory(db, stubOptions).setup({ migrations: 'allow' });
    expect(await indexSql(db)).not.toBeNull();
  });

  it('helpers are idempotent', async () => {
    const db = await fresh();
    await addEventsForgottenAtColumn(db, P);
    await addEventsForgottenAtColumn(db, P);
    await createEventsForgottenIndex(db, P);
    await createEventsForgottenIndex(db, P);
    expect((await eventCols(db)).filter((c) => c === 'forgotten_at')).toHaveLength(1);
  });
});
