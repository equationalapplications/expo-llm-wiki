import type { SQLiteAdapter } from '../types';

export interface Migration {
  version: number;
  description: string;
  run: (db: SQLiteAdapter, prefix: string) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Rebuild FTS5 with porter unicode61 tokenizer (superseded by v2)',
    run: async (_db, _prefix) => {
      // This migration is superseded by v2 which drops FTS5 entirely.
      // It is kept as a no-op so upgrade paths from v0 do not require FTS5 support.
    },
  },
  {
    version: 2,
    description: 'Remove FTS5; add embedding column for semantic retrieval',
    run: async (db, prefix) => {
      // Drop FTS5 artifacts in a transaction.
      await db.withTransactionAsync(async () => {
        await db.execAsync(`
          DROP TRIGGER IF EXISTS ${prefix}entries_ai;
          DROP TRIGGER IF EXISTS ${prefix}entries_ad;
          DROP TRIGGER IF EXISTS ${prefix}entries_au;
          DROP TABLE IF EXISTS ${prefix}entries_fts;
        `);
      });
      // ALTER TABLE ADD COLUMN must run outside any explicit transaction —
      // SQLite (and expo-sqlite) do not permit schema alterations inside
      // a BEGIN...COMMIT block.
      const cols = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(${prefix}entries)`
      );
      if (!cols.some(c => c.name === 'embedding')) {
        await db.execAsync(`ALTER TABLE ${prefix}entries ADD COLUMN embedding TEXT`);
      }
    },
  },
  {
    version: 3,
    description: 'Add embedding_blob BLOB column for Float32Array vector storage',
    run: async (db, prefix) => {
      const cols = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(${prefix}entries)`
      );
      if (!cols.some(c => c.name === 'embedding_blob')) {
        await db.execAsync(
          `ALTER TABLE ${prefix}entries ADD COLUMN embedding_blob BLOB`
        );
      }
    },
  },
  {
    version: 4,
    description: 'Create outbox table for change data capture',
    run: async (db, prefix) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS ${prefix}outbox (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ${prefix}outbox_entity_id_created_at
          ON ${prefix}outbox (entity_id, created_at);
      `);
    },
  },
];

// Verify MIGRATIONS are in strictly ascending version order at module load time.
// This prevents skipped or repeated migrations caused by out-of-order entries.
for (let i = 1; i < MIGRATIONS.length; i++) {
  if (MIGRATIONS[i].version <= MIGRATIONS[i - 1].version) {
    throw new Error(
      `migrations.ts: MIGRATIONS must be in strictly ascending version order. ` +
      `Found version ${MIGRATIONS[i].version} after ${MIGRATIONS[i - 1].version} at index ${i}.`
    );
  }
}

// Derived from the last (highest) migration version so it never drifts out of sync.
export const CURRENT_SCHEMA_VERSION =
  MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
