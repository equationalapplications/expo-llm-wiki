import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions } from '../src/types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

const PREFIX = 'llm_wiki_';
const DOCS = `${PREFIX}source_documents`;
const PASSAGES = `${PREFIX}source_passages`;

const DOC_COLS = ['id', 'entity_id', 'source_ref', 'source_hash', 'text', 'text_hash', 'char_count', 'created_at'];
const PASSAGE_COLS = ['id', 'entity_id', 'document_id', 'seq', 'start_offset', 'end_offset'];

async function version(db: SQLiteAdapter): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM ${PREFIX}meta WHERE key = 'schema_version'`,
  );
  return row?.value ?? null;
}

async function columns(db: SQLiteAdapter, table: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

async function setupThenRollBack(to: string): Promise<{ db: SQLiteAdapter; wiki: WikiMemory }> {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, stubOptions);
  await wiki.setup();
  await db.runAsync(`UPDATE ${PREFIX}meta SET value = ? WHERE key = 'schema_version'`, [to]);
  return { db, wiki };
}

describe('migration v17: add_source_store', () => {
  it('is registered as the v17 migration and fresh install stamps v17', async () => {
    expect(MIGRATIONS.some((m) => m.version === 17 && m.description === 'add_source_store')).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(17);
    const db = openTestDatabase();
    await new WikiMemory(db, stubOptions).setup();
    expect(await version(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(await columns(db, DOCS)).toEqual(DOC_COLS);
    expect(await columns(db, PASSAGES)).toEqual(PASSAGE_COLS);
  });

  it('migrates an old database by DDL (empty expected-shape tables do not abort)', async () => {
    const { db, wiki } = await setupThenRollBack('16');
    await expect(wiki.setup()).resolves.toBeUndefined();
    expect(await version(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(await columns(db, DOCS)).toEqual(DOC_COLS);
    expect(await columns(db, PASSAGES)).toEqual(PASSAGE_COLS);
  });

  it('migrates when the tables are absent entirely', async () => {
    const { db, wiki } = await setupThenRollBack('16');
    await db.runAsync(`DROP TABLE ${PASSAGES}`);
    await db.runAsync(`DROP TABLE ${DOCS}`);
    await wiki.setup();
    expect(await columns(db, DOCS)).toEqual(DOC_COLS);
  });

  it('is idempotent on a database with no stored sources', async () => {
    const { db, wiki } = await setupThenRollBack('0');
    await wiki.setup();
    await wiki.setup();
    expect(await version(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(await db.getAllAsync(`SELECT id FROM ${DOCS}`)).toEqual([]);
    expect(await db.getAllAsync(`SELECT id FROM ${PASSAGES}`)).toEqual([]);
  });

  it('both source_documents UNIQUE indexes are plain and enforce uniqueness', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stubOptions).setup();
    const ins = (id: string, ref: string, hash: string) =>
      db.runAsync(
        `INSERT INTO ${DOCS} (id, entity_id, source_ref, source_hash, text, text_hash, char_count, created_at)
         VALUES (?, 'e', ?, ?, 't', 'h', 1, 1)`,
        [id, ref, hash],
      );
    await ins('1', 'a.md', 'h1');
    await expect(ins('2', 'a.md', 'h2')).rejects.toThrow();
    await expect(ins('3', 'b.md', 'h1')).rejects.toThrow();
  });

  it('abort path: a table holding rows aborts before any write', async () => {
    const { db, wiki } = await setupThenRollBack('16');
    await db.runAsync(
      `INSERT INTO ${DOCS} (id, entity_id, source_ref, source_hash, text, text_hash, char_count, created_at)
       VALUES ('x', 'e', 'a.md', 'h', 't', 'th', 1, 1)`,
    );
    await db.runAsync(`DROP TABLE ${PASSAGES}`);
    await expect(wiki.setup()).rejects.toThrow(/^Migration v17 \(add_source_store\) failed: .*already holds 1 row/);
    expect(await version(db)).toBe('16');
    // the migration did not create the passages table we dropped (every-open DDL does, empty)
    expect(await db.getAllAsync(`SELECT id FROM ${PASSAGES}`)).toEqual([]);
    const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${DOCS}`);
    expect(rows.map((r) => r.id)).toEqual(['x']);
  });

  it('abort path: a differing column set aborts', async () => {
    const { db, wiki } = await setupThenRollBack('16');
    await db.runAsync(`DROP TABLE ${PASSAGES}`);
    await db.runAsync(`CREATE TABLE ${PASSAGES} (id TEXT PRIMARY KEY, entity_id TEXT, text TEXT)`);
    await expect(wiki.setup()).rejects.toThrow(/^Migration v17 \(add_source_store\) failed: .*expected \[/);
    expect(await version(db)).toBe('16');
    expect(await columns(db, PASSAGES)).toEqual(['id', 'entity_id', 'text']);
  });

  it('abort path: a stray wrong-shaped source_documents aborts, not a raw index error', async () => {
    const { db, wiki } = await setupThenRollBack('16');
    // Missing source_ref/source_hash: the every-open DDL's UNIQUE indexes on
    // those columns must not run before migration 17's precondition check.
    await db.runAsync(`DROP TABLE ${DOCS}`);
    await db.runAsync(`CREATE TABLE ${DOCS} (id TEXT PRIMARY KEY, entity_id TEXT, text TEXT)`);
    await expect(wiki.setup()).rejects.toThrow(/^Migration v17 \(add_source_store\) failed: .*expected \[/);
    expect(await version(db)).toBe('16');
  });

  it('additivity: no pre-existing table gained a source-store column', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stubOptions).setup();
    const tables = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '${PREFIX}%'`,
    );
    const storeOnly = ['text_hash', 'char_count', 'start_offset', 'end_offset', 'document_id'];
    for (const { name } of tables) {
      if (name === DOCS || name === PASSAGES) continue;
      const cols = await columns(db, name);
      for (const c of storeOnly) expect(cols, `${name}.${c}`).not.toContain(c);
    }
  });
});
