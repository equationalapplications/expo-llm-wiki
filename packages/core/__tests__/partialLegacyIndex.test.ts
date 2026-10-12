import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';

const P = 'llm_wiki_';
const stub = { llmProvider: { generateText: async () => '{}' } } as const;

async function indexExists(db: ReturnType<typeof openTestDatabase>) {
  return (await db.getFirstAsync(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='${P}entries_partial_covering_idx'`)) != null;
}

describe('partial legacy index', () => {
  it('v14 is the last migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(14);
    expect(MIGRATIONS[MIGRATIONS.length - 1].version).toBe(14);
  });

  it('fresh store gets the index', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    expect(await indexExists(db)).toBe(true);
    for (let i = 0; i < 1000; i++) {
      await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES (?, 'e', 't', 'b', 1, 1)`, [`f${i}`]);
    }
    const plan = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT 1 FROM ${P}entries WHERE entity_id = 'e' AND deleted_at IS NULL AND title = 't' AND source_ref IS NOT NULL AND created_at = 1 LIMIT 1`);
    expect(plan.map((r) => r.detail).join(' ')).toContain('entries_partial_covering_idx');
  });

  it('v13 store gains the index through v14', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    await db.execAsync(`DROP INDEX ${P}entries_partial_covering_idx`);
    await db.runAsync(`UPDATE ${P}meta SET value = '13' WHERE key = 'schema_version'`);
    await new WikiMemory(db, stub).setup();
    expect(await indexExists(db)).toBe(true);
    const v = await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key='schema_version'`);
    expect(v?.value).toBe('14');
  });

  it('a current-version store missing the index is NOT repaired by every-open DDL', async () => {
    // Pins "new indexes only via migrations/fresh path": setupDatabase must not build it.
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    await db.execAsync(`DROP INDEX ${P}entries_partial_covering_idx`);
    await new WikiMemory(db, stub).setup();
    expect(await indexExists(db)).toBe(false);
  });
});