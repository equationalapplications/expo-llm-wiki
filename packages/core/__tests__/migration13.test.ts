import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const P = 'llm_wiki_';

async function freshDb(): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await new WikiMemory(db, stubOptions).setup();
  return db;
}
async function cols(db: SQLiteAdapter, table: string): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${P}${table})`)).map((c) => c.name);
}
async function indexNames(db: SQLiteAdapter, table: string): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>(`PRAGMA index_list(${P}${table})`)).map((i) => i.name);
}
/** Turn a fresh DB back into a v12-shaped DB. */
async function downgradeToV12(db: SQLiteAdapter): Promise<void> {
  await db.execAsync(`
    DROP INDEX IF EXISTS ${P}entries_superseded_idx;
    DROP INDEX IF EXISTS ${P}entries_temporal_idx;
    ALTER TABLE ${P}entries DROP COLUMN valid_from;
    ALTER TABLE ${P}entries DROP COLUMN valid_to;
    ALTER TABLE ${P}entries DROP COLUMN superseded_by;
    ALTER TABLE ${P}entries DROP COLUMN superseded_at;
    ALTER TABLE ${P}events DROP COLUMN occurred_at;
    ALTER TABLE ${P}checkpoints DROP COLUMN librarian_watermark_at;
    ALTER TABLE ${P}checkpoints DROP COLUMN librarian_watermark_id;
  `);
  await db.runAsync(`UPDATE ${P}meta SET value = '12' WHERE key = 'schema_version'`);
}

describe('migration v13: temporal columns + librarian watermark', () => {
  it('is the last migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(13);
    expect(MIGRATIONS[MIGRATIONS.length - 1].version).toBe(13);
  });

  it('fresh install has every new column and both indexes', async () => {
    const db = await freshDb();
    expect(await cols(db, 'entries')).toEqual(expect.arrayContaining(['valid_from', 'valid_to', 'superseded_by', 'superseded_at']));
    expect(await cols(db, 'events')).toContain('occurred_at');
    expect(await cols(db, 'checkpoints')).toEqual(expect.arrayContaining(['librarian_watermark_at', 'librarian_watermark_id']));
    expect(await indexNames(db, 'entries')).toEqual(expect.arrayContaining([`${P}entries_superseded_idx`, `${P}entries_temporal_idx`]));
  });

  it('upgrades a v12 database without touching existing rows', async () => {
    const db = await freshDb();
    await downgradeToV12(db);
    await db.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES ('fact_1', 'e1', 't', 'b', 5, 5)`,
    );
    await new WikiMemory(db, stubOptions).setup();
    expect(await cols(db, 'entries')).toEqual(expect.arrayContaining(['valid_from', 'valid_to', 'superseded_by', 'superseded_at']));
    expect(await cols(db, 'events')).toContain('occurred_at');
    const row = await db.getFirstAsync<Record<string, unknown>>(`SELECT * FROM ${P}entries WHERE id = 'fact_1'`);
    expect(row).toMatchObject({ valid_from: null, valid_to: null, superseded_by: null, superseded_at: null });
    const v = await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = 'schema_version'`);
    expect(v?.value).toBe('13');
  });

  it('v13 is idempotent when columns already exist', async () => {
    const db = await freshDb();
    await expect(MIGRATIONS.find((m) => m.version === 13)!.run(db, P)).resolves.toBeUndefined();
  });
});
