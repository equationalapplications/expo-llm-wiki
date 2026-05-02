import { describe, it, expect, beforeEach } from 'vitest';
import type * as SQLite from 'expo-sqlite';
import { WikiMemory } from '../src/WikiMemory';
import type { LLMProvider, WikiFact } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';

const llmProvider: LLMProvider = {
  generateText: async () => '{}',
};

async function openDb() {
  return openTestDatabase();
}

function makeFact(overrides: Partial<WikiFact>): WikiFact {
  const now = Date.now();
  return {
    id: 'f1',
    entity_id: 'user-1',
    title: 'title',
    body: 'body',
    tags: [],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    ...overrides,
  };
}

describe('FTS5 porter stemmer', () => {
  let db: SQLite.SQLiteDatabase;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = await openDb();
    wiki = new WikiMemory(db, { llmProvider });
    await wiki.setup();
  });

  it('matches morphological variants (running → runs)', async () => {
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', title: 'Morning routine', body: 'User runs every morning' })], tasks: [], events: [] } },
    });
    const result = await wiki.read('user-1', 'running');
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].body).toContain('runs');
  });

  it('matches base form (run → runs)', async () => {
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', title: 'Routine', body: 'User runs every morning' })], tasks: [], events: [] } },
    });
    const result = await wiki.read('user-1', 'run');
    expect(result.facts.length).toBeGreaterThan(0);
  });
});

describe('FTS5 porter upgrade migration', () => {
  it('rebuilds pre-porter FTS5 table and preserves searchability', async () => {
    const db = await openDb();
    const prefix = 'llm_wiki_';

    // Simulate pre-porter install: create entries + non-porter FTS5 + triggers + a row.
    await db.execAsync(`
      CREATE TABLE ${prefix}entries (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        confidence TEXT NOT NULL DEFAULT 'inferred',
        source_type TEXT NOT NULL DEFAULT 'agent_inferred',
        source_hash TEXT,
        source_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS ${prefix}entries_entity_idx ON ${prefix}entries(entity_id);
      CREATE INDEX IF NOT EXISTS ${prefix}entries_source_ref_idx ON ${prefix}entries(entity_id, source_ref);
      CREATE INDEX IF NOT EXISTS ${prefix}entries_source_hash_idx ON ${prefix}entries(entity_id, source_hash) WHERE source_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ${prefix}entries_updated_idx ON ${prefix}entries(updated_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS ${prefix}entries_fts USING fts5(
        title, body, tags,
        content='${prefix}entries',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS ${prefix}entries_ai AFTER INSERT ON ${prefix}entries BEGIN
        INSERT INTO ${prefix}entries_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS ${prefix}entries_ad AFTER DELETE ON ${prefix}entries BEGIN
        INSERT INTO ${prefix}entries_fts(${prefix}entries_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS ${prefix}entries_au AFTER UPDATE ON ${prefix}entries BEGIN
        INSERT INTO ${prefix}entries_fts(${prefix}entries_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags);
        INSERT INTO ${prefix}entries_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags);
      END;
    `);
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO ${prefix}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'user-1', 'Routine', 'User runs every morning', '[]', now, now]
    );

    // Now run setup — must detect missing porter and rebuild.
    const wiki = new WikiMemory(db, { llmProvider });
    await wiki.setup();

    // Confirm new FTS5 sql contains porter.
    const meta = await db.getFirstAsync<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [`${prefix}entries_fts`]
    );
    expect(meta?.sql).toContain('porter');

    // Confirm the existing fact is searchable via stem.
    const result = await wiki.read('user-1', 'running');
    expect(result.facts.length).toBeGreaterThan(0);
  });

  it('is idempotent: second setup() does not drop facts', async () => {
    const db = await openDb();
    const wiki = new WikiMemory(db, { llmProvider });
    await wiki.setup();
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', title: 't', body: 'User runs every morning' })], tasks: [], events: [] } },
    });
    await wiki.setup(); // second call
    const result = await wiki.read('user-1', 'running');
    expect(result.facts.length).toBeGreaterThan(0);
  });

  it('does not skip rebuild when tablePrefix contains the substring "porter"', async () => {
    const db = openTestDatabase();
    const prefix = 'my_porter_';

    // Simulate pre-porter install with a colliding prefix.
    await db.execAsync(`
      CREATE TABLE ${prefix}entries (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'inferred',
        source_type TEXT NOT NULL DEFAULT 'agent_inferred', source_hash TEXT, source_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
      );
      CREATE VIRTUAL TABLE ${prefix}entries_fts USING fts5(
        title, body, tags, content='${prefix}entries', content_rowid='rowid'
      );
      CREATE TRIGGER ${prefix}entries_ai AFTER INSERT ON ${prefix}entries BEGIN
        INSERT INTO ${prefix}entries_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
      END;
    `);
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO ${prefix}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'user-1', 'Routine', 'User runs every morning', '[]', now, now]
    );

    const wiki = new WikiMemory(db, { llmProvider, config: { tablePrefix: 'my_porter_' } });
    await wiki.setup();

    const meta = await db.getFirstAsync<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [`${prefix}entries_fts`]
    );
    // Must match the tokenize clause, not just the prefix substring.
    expect(meta?.sql).toMatch(/tokenize\s*=\s*['"]porter\s+unicode61['"]/i);

    const result = await wiki.read('user-1', 'running');
    expect(result.facts.length).toBeGreaterThan(0);
  });
});
