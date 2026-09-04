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

describe('migration v11: embedding failure markers', () => {
  it('CURRENT_SCHEMA_VERSION is at least 11', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    expect(CURRENT_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it('adds the three marker columns to entries', async () => {
    const { db } = await makeWiki();
    expect(await columnExists(db, `${PREFIX}entries`, 'embedding_failed_at')).toBe(true);
    expect(await columnExists(db, `${PREFIX}entries`, 'embedding_failure_kind')).toBe(true);
    expect(await columnExists(db, `${PREFIX}entries`, 'embedding_attempts')).toBe(true);
  });

  it('defaults embedding_attempts to 0 and markers to NULL', async () => {
    const { db } = await makeWiki();
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('f1', 'e1', 't', 'b', 'certain', 'user_stated', 0, 0)`,
    );
    const row = await db.getFirstAsync<{
      embedding_attempts: number;
      embedding_failed_at: number | null;
      embedding_failure_kind: string | null;
    }>(`SELECT embedding_attempts, embedding_failed_at, embedding_failure_kind FROM ${PREFIX}entries WHERE id = 'f1'`);
    expect(row!.embedding_attempts).toBe(0);
    expect(row!.embedding_failed_at).toBeNull();
    expect(row!.embedding_failure_kind).toBeNull();
  });

  it('does not add the columns to tasks', async () => {
    const { db } = await makeWiki();
    expect(await columnExists(db, `${PREFIX}tasks`, 'embedding_failed_at')).toBe(false);
    expect(await columnExists(db, `${PREFIX}tasks`, 'embedding_failure_kind')).toBe(false);
    expect(await columnExists(db, `${PREFIX}tasks`, 'embedding_attempts')).toBe(false);
  });
});

describe('migration v11 ALTER TABLE path on a pre-v11 fixture', () => {
  async function makePreV11Wiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
    const db = openTestDatabase();
    // Build a pre-v11 entries table (no embedding marker columns).
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
        heal_checked_at INTEGER,
        lifecycle_status TEXT NOT NULL DEFAULT 'stable',
        stale_after INTEGER,
        generated_by TEXT,
        last_verified_at INTEGER,
        last_verified_by TEXT,
        okf_sources TEXT,
        okf_verified TEXT,
        okf_usage_window TEXT
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
        okf_type TEXT,
        lifecycle_status TEXT NOT NULL DEFAULT 'stable',
        stale_after INTEGER,
        generated_by TEXT,
        last_verified_at INTEGER,
        last_verified_by TEXT,
        okf_sources TEXT,
        okf_verified TEXT,
        okf_usage_window TEXT
      );
      CREATE TABLE ${PREFIX}meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('pre_existing', 'e1', 't', 'b', 'certain', 'user_stated', 1700000000000, 1700000000000)`,
    );
    await db.runAsync(`INSERT INTO ${PREFIX}meta (key, value) VALUES ('schema_version', '10')`);
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    return { wiki, db };
  }

  it('adds every documented v11 column on upgrade', async () => {
    const { db } = await makePreV11Wiki();
    expect(await columnExists(db, `${PREFIX}entries`, 'embedding_failed_at')).toBe(true);
    expect(await columnExists(db, `${PREFIX}entries`, 'embedding_failure_kind')).toBe(true);
    expect(await columnExists(db, `${PREFIX}entries`, 'embedding_attempts')).toBe(true);
    // tasks never get these columns
    expect(await columnExists(db, `${PREFIX}tasks`, 'embedding_failed_at')).toBe(false);
    expect(await columnExists(db, `${PREFIX}tasks`, 'embedding_attempts')).toBe(false);
  });

  it('preserves pre-existing rows and defaults attempts to 0', async () => {
    const { db } = await makePreV11Wiki();
    const row = await db.getFirstAsync<{
      id: string;
      title: string;
      embedding_failed_at: number | null;
      embedding_failure_kind: string | null;
      embedding_attempts: number;
    }>(
      `SELECT id, title, embedding_failed_at, embedding_failure_kind, embedding_attempts FROM ${PREFIX}entries WHERE id = 'pre_existing'`,
    );
    expect(row).toEqual({
      id: 'pre_existing',
      title: 't',
      embedding_failed_at: null,
      embedding_failure_kind: null,
      embedding_attempts: 0,
    });
  });

  it('stamps schema_version to CURRENT_SCHEMA_VERSION after upgrade', async () => {
    const { db } = await makePreV11Wiki();
    const v = await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${PREFIX}meta WHERE key = 'schema_version'`);
    expect(v?.value).toBe(String(CURRENT_SCHEMA_VERSION));
  });
});
