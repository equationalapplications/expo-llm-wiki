import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MIGRATIONS } from '../src/db/migrations';
import type { SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';

async function entryColumns(db: SQLiteAdapter): Promise<string[]> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${PREFIX}entries)`);
  return cols.map(c => c.name);
}

describe('migration v8 — heal_checked_at', () => {
  it('fresh install has the column via base schema', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    expect(await entryColumns(db)).toContain('heal_checked_at');
  });

  it('upgrade from v7 adds the column, and re-running is idempotent', async () => {
    const db = openTestDatabase();
    // Simulate a pre-v8 install: base schema without the new column.
    await db.execAsync(`
      CREATE TABLE ${PREFIX}entries (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'inferred',
        source_type TEXT NOT NULL DEFAULT 'librarian_inferred', source_hash TEXT, source_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
        embedding TEXT, embedding_blob BLOB, okf_type TEXT, ontology_checked_at INTEGER
      );
    `);
    const v8 = MIGRATIONS.find(m => m.version === 8)!;
    expect(v8).toBeDefined();
    await v8.run(db, PREFIX);
    expect(await entryColumns(db)).toContain('heal_checked_at');
    await v8.run(db, PREFIX); // idempotent — no throw
    expect((await entryColumns(db)).filter(c => c === 'heal_checked_at')).toHaveLength(1);
  });
});
