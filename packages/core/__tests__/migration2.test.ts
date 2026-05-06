import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

async function makeV1Db() {
  const db = openTestDatabase();
  // Manually create the state a v1 DB would have: entries + FTS5 + triggers + schema_version=1
  await db.execAsync(`
    CREATE TABLE llm_wiki_entries (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL DEFAULT 'inferred',
      source_type TEXT NOT NULL DEFAULT 'agent_inferred',
      source_hash TEXT, source_ref TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
    );
    CREATE TABLE llm_wiki_tasks (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      resolved_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE llm_wiki_events (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, event_type TEXT NOT NULL,
      summary TEXT NOT NULL, related_entry_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE llm_wiki_checkpoints (
      entity_id TEXT PRIMARY KEY,
      heal_checkpoint INTEGER NOT NULL DEFAULT 0,
      memory_checkpoint INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE llm_wiki_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE llm_wiki_entries_fts USING fts5(
      title, body, tags,
      content='llm_wiki_entries', content_rowid='rowid',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER llm_wiki_entries_ai AFTER INSERT ON llm_wiki_entries BEGIN
      INSERT INTO llm_wiki_entries_fts(rowid, title, body, tags)
      VALUES (new.rowid, new.title, new.body, new.tags);
    END;
    CREATE TRIGGER llm_wiki_entries_ad AFTER DELETE ON llm_wiki_entries BEGIN
      INSERT INTO llm_wiki_entries_fts(llm_wiki_entries_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
    END;
    CREATE TRIGGER llm_wiki_entries_au AFTER UPDATE ON llm_wiki_entries BEGIN
      INSERT INTO llm_wiki_entries_fts(llm_wiki_entries_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      INSERT INTO llm_wiki_entries_fts(rowid, title, body, tags)
      VALUES (new.rowid, new.title, new.body, new.tags);
    END;
  `);
  await db.runAsync(`INSERT INTO llm_wiki_meta (key, value) VALUES ('schema_version', '1')`);
  return db;
}

describe('migration 2+3: remove FTS5, add embedding column, setup ends at version 3', () => {
  it('fresh install: embedding column exists, FTS5 table absent', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(llm_wiki_entries)');
    expect(cols.some(c => c.name === 'embedding')).toBe(true);

    const fts = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='llm_wiki_entries_fts'`
    );
    expect(fts).toBeNull();

    const meta = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM llm_wiki_meta WHERE key = 'schema_version'`
    );
    expect(meta?.value).toBe('3');
  });

  it('v1 DB: FTS5 table + triggers dropped, embedding column added, version becomes 3', async () => {
    const db = await makeV1Db();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    const fts = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='llm_wiki_entries_fts'`
    );
    expect(fts).toBeNull();

    const triggers = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='llm_wiki_entries'`
    );
    expect(triggers).toHaveLength(0);

    const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(llm_wiki_entries)');
    expect(cols.some(c => c.name === 'embedding')).toBe(true);

    const meta = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM llm_wiki_meta WHERE key = 'schema_version'`
    );
    expect(meta?.value).toBe('3');
  });

  it('running setup() twice is idempotent: embedding column appears once', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    await wiki.setup();

    const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(llm_wiki_entries)');
    expect(cols.filter(c => c.name === 'embedding')).toHaveLength(1);
  });
});
