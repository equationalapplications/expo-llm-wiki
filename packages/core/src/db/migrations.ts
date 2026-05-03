import type { SQLiteAdapter } from '../types';

export interface Migration {
  version: number;
  description: string;
  run: (db: SQLiteAdapter, prefix: string) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Rebuild FTS5 with porter unicode61 tokenizer',
    run: async (db, prefix) => {
      await db.withTransactionAsync(async () => {
        await db.execAsync(`
          DROP TRIGGER IF EXISTS ${prefix}entries_ai;
          DROP TRIGGER IF EXISTS ${prefix}entries_ad;
          DROP TRIGGER IF EXISTS ${prefix}entries_au;
          DROP TABLE IF EXISTS ${prefix}entries_fts;
          CREATE VIRTUAL TABLE ${prefix}entries_fts USING fts5(
            title,
            body,
            tags,
            content='${prefix}entries',
            content_rowid='rowid',
            tokenize='porter unicode61'
          );
          INSERT INTO ${prefix}entries_fts(rowid, title, body, tags)
            SELECT rowid, title, body, tags FROM ${prefix}entries;
          CREATE TRIGGER ${prefix}entries_ai AFTER INSERT ON ${prefix}entries BEGIN
            INSERT INTO ${prefix}entries_fts(rowid, title, body, tags)
            VALUES (new.rowid, new.title, new.body, new.tags);
          END;
          CREATE TRIGGER ${prefix}entries_ad AFTER DELETE ON ${prefix}entries BEGIN
            INSERT INTO ${prefix}entries_fts(${prefix}entries_fts, rowid, title, body, tags)
            VALUES ('delete', old.rowid, old.title, old.body, old.tags);
          END;
          CREATE TRIGGER ${prefix}entries_au AFTER UPDATE ON ${prefix}entries BEGIN
            INSERT INTO ${prefix}entries_fts(${prefix}entries_fts, rowid, title, body, tags)
            VALUES ('delete', old.rowid, old.title, old.body, old.tags);
            INSERT INTO ${prefix}entries_fts(rowid, title, body, tags)
            VALUES (new.rowid, new.title, new.body, new.tags);
          END;
        `);
      });
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
      // ALTER TABLE must run outside the transaction — SQLite does not allow
      // ALTER TABLE on a table whose triggers were just dropped in the same tx
      // on all platforms.
      const cols = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(${prefix}entries)`
      );
      if (!cols.some(c => c.name === 'embedding')) {
        await db.execAsync(`ALTER TABLE ${prefix}entries ADD COLUMN embedding TEXT`);
      }
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
