import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, addPriorValidToColumn } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const P = 'llm_wiki_';

async function cols(db: SQLiteAdapter): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${P}entries)`)).map((c) => c.name);
}

describe('migration v18: prior_valid_to', () => {
  it('is registered and is the current version', () => {
    expect(MIGRATIONS.some((m) => m.version === 18)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
  });

  it('fresh store has the column', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stubOptions).setup();
    expect(await cols(db)).toContain('prior_valid_to');
  });

  it('a v17-shaped store gains the column on setup and keeps existing rows', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stubOptions).setup();
    await db.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES ('f1','e1','t','b',5,5)`);
    await db.execAsync(`ALTER TABLE ${P}entries DROP COLUMN prior_valid_to`);
    await db.runAsync(`UPDATE ${P}meta SET value = '17' WHERE key = 'schema_version'`);
    await new WikiMemory(db, stubOptions).setup();
    expect(await cols(db)).toContain('prior_valid_to');
    const row = await db.getFirstAsync<Record<string, unknown>>(`SELECT * FROM ${P}entries WHERE id='f1'`);
    expect(row!.prior_valid_to).toBeNull();
    expect(row!.title).toBe('t');
  });

  it('the helper is idempotent', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stubOptions).setup();
    await addPriorValidToColumn(db, P);
    await addPriorValidToColumn(db, P);
    expect((await cols(db)).filter((c) => c === 'prior_valid_to')).toHaveLength(1);
  });
});
