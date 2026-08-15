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

describe('migration v10 ALTER TABLE path on a pre-v10 fixture', () => {
  // Open a :memory: db, hand-build the v9 tables WITHOUT the OKF v0.2 columns,
  // stamp schema_version = 9, then run WikiMemory.setup(). setup() must apply
  // v10 (ALTER TABLE) and add every expected column + index while preserving
  // rows that already lived in the table.
  async function makePreV10Wiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
    const db = openTestDatabase();
    await db.execAsync(`
      CREATE TABLE ${PREFIX}entries (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        confidence TEXT NOT NULL DEFAULT 'inferred',
        source_type TEXT NOT NULL DEFAULT 'librarian_inferred',
        source_hash TEXT,
        source_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        embedding TEXT,
        embedding_blob BLOB,
        okf_type TEXT,
        ontology_checked_at INTEGER,
        heal_checked_at INTEGER
      );
      CREATE TABLE ${PREFIX}tasks (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        deleted_at INTEGER,
        okf_type TEXT
      );
      CREATE TABLE ${PREFIX}meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Pre-existing rows that the migration must NOT touch.
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('pre_existing', 'e1', 'pre-existing title', 'pre-existing body', 'certain', 'user_stated', 1700000000000, 1700000000000)`,
    );
    await db.runAsync(
      `INSERT INTO ${PREFIX}tasks (id, entity_id, description, status, priority, created_at, updated_at) VALUES ('pre_task', 'e1', 'pre-existing task', 'pending', 0, 1700000000000, 1700000000000)`,
    );
    await db.runAsync(`INSERT INTO ${PREFIX}meta (key, value) VALUES ('schema_version', '9')`);
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    return { wiki, db };
  }

  it('adds every documented OKF v0.2 column on upgrade', async () => {
    const { db } = await makePreV10Wiki();
    const expected = ['lifecycle_status', 'stale_after', 'generated_by', 'last_verified_at', 'last_verified_by', 'okf_sources', 'okf_verified', 'okf_usage_window'];
    for (const table of ['entries', 'tasks'] as const) {
      for (const c of expected) {
        expect(await columnExists(db, `${PREFIX}${table}`, c)).toBe(true);
      }
    }
  });

  it('creates the documented OKF v0.2 indexes on upgrade', async () => {
    const { db } = await makePreV10Wiki();
    const indexes = await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '${PREFIX}%_idx'`);
    const names = new Set(indexes.map((i) => i.name));
    for (const table of ['entries', 'tasks'] as const) {
      expect(names.has(`${PREFIX}${table}_lifecycle_status_idx`)).toBe(true);
      expect(names.has(`${PREFIX}${table}_stale_after_idx`)).toBe(true);
      expect(names.has(`${PREFIX}${table}_last_verified_at_idx`)).toBe(true);
    }
  });

  it('preserves pre-existing rows on upgrade (no rewrite of content columns)', async () => {
    const { db } = await makePreV10Wiki();
    const row = await db.getFirstAsync<{ id: string; title: string; body: string; lifecycle_status: string; stale_after: number | null }>(
      `SELECT id, title, body, lifecycle_status, stale_after FROM ${PREFIX}entries WHERE id = 'pre_existing'`,
    );
    expect(row).toEqual({
      id: 'pre_existing',
      title: 'pre-existing title',
      body: 'pre-existing body',
      // SQLite DEFAULT 'stable' applies to existing rows on ALTER TABLE ADD COLUMN.
      lifecycle_status: 'stable',
      stale_after: null,
    });
    const task = await db.getFirstAsync<{ id: string; description: string; lifecycle_status: string }>(
      `SELECT id, description, lifecycle_status FROM ${PREFIX}tasks WHERE id = 'pre_task'`,
    );
    expect(task).toEqual({
      id: 'pre_task',
      description: 'pre-existing task',
      lifecycle_status: 'stable',
    });
  });

  it('stamps schema_version to CURRENT_SCHEMA_VERSION after upgrade', async () => {
    const { db } = await makePreV10Wiki();
    const v = await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${PREFIX}meta WHERE key = 'schema_version'`);
    expect(v?.value).toBe(String(CURRENT_SCHEMA_VERSION));
  });
});
