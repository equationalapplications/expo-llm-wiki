import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

async function makeWiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, stubOptions);
  await wiki.setup();
  return { wiki, db };
}

async function columnExists(db: SQLiteAdapter, table: string, column: string): Promise<boolean> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

describe('migration v10 (OKF v0.2 columns)', () => {
  it('CURRENT_SCHEMA_VERSION advances to the latest migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it('adds lifecycle_status to entries and tasks with default "stable"', async () => {
    const { db } = await makeWiki();
    expect(await columnExists(db, `${PREFIX}entries`, 'lifecycle_status')).toBe(true);
    expect(await columnExists(db, `${PREFIX}tasks`, 'lifecycle_status')).toBe(true);
    const row = await db.getFirstAsync<any>(`SELECT lifecycle_status FROM ${PREFIX}entries LIMIT 1`).catch(() => null);
    // Existing rows: SQLite default 'stable' applies. Insert a probe row to assert.
    await db.runAsync(`INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('probe_e', 'e', 't', 'b', 'certain', 'user_stated', 0, 0)`);
    const probe = await db.getFirstAsync<{ lifecycle_status: string }>(`SELECT lifecycle_status FROM ${PREFIX}entries WHERE id = 'probe_e'`);
    expect(probe?.lifecycle_status).toBe('stable');
    void row;
  });

  it('adds the documented nullable columns to both tables', async () => {
    const { db } = await makeWiki();
    const nullableCols = ['stale_after', 'generated_by', 'last_verified_at', 'last_verified_by', 'okf_sources', 'okf_verified', 'okf_usage_window'];
    for (const c of nullableCols) {
      expect(await columnExists(db, `${PREFIX}entries`, c)).toBe(true);
      expect(await columnExists(db, `${PREFIX}tasks`, c)).toBe(true);
    }
  });

  it('creates indexes on lifecycle_status, stale_after, last_verified_at', async () => {
    const { db } = await makeWiki();
    const indexes = await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '${PREFIX}%_idx'`);
    const names = new Set(indexes.map((i) => i.name));
    // Naming matches the existing convention (`entries_entity_idx`, `entries_updated_idx`
    // in schema.ts), not a new `idx_` prefix.
    expect(names.has(`${PREFIX}entries_lifecycle_status_idx`)).toBe(true);
    expect(names.has(`${PREFIX}entries_stale_after_idx`)).toBe(true);
    expect(names.has(`${PREFIX}entries_last_verified_at_idx`)).toBe(true);
    expect(names.has(`${PREFIX}tasks_lifecycle_status_idx`)).toBe(true);
    expect(names.has(`${PREFIX}tasks_stale_after_idx`)).toBe(true);
    expect(names.has(`${PREFIX}tasks_last_verified_at_idx`)).toBe(true);
  });

  it('a FRESH database (no prior entries table) also gets the v0.2 columns', async () => {
    // WikiMemory.setup() skips every entry in MIGRATIONS when the entries table
    // did not already exist before setup() was called — it stamps
    // schema_version = CURRENT_SCHEMA_VERSION directly and relies entirely on
    // schema.ts's CREATE TABLE for a brand-new database (see the
    // `entriesExistedBeforeSetup` branch in WikiMemory.setup()). So this
    // migration is not enough on its own — Step 7.3b adds the same columns
    // and indexes to schema.ts's CREATE TABLE statements.
    const { db } = await makeWiki();
    const nullableCols = ['lifecycle_status', 'stale_after', 'generated_by', 'last_verified_at', 'last_verified_by', 'okf_sources', 'okf_verified', 'okf_usage_window'];
    for (const c of nullableCols) {
      expect(await columnExists(db, `${PREFIX}entries`, c)).toBe(true);
      expect(await columnExists(db, `${PREFIX}tasks`, c)).toBe(true);
    }
    const indexes = await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '${PREFIX}%_idx'`);
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has(`${PREFIX}entries_lifecycle_status_idx`)).toBe(true);
    expect(names.has(`${PREFIX}tasks_lifecycle_status_idx`)).toBe(true);
  });
});
