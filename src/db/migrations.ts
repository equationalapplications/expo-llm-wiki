import type * as SQLite from 'expo-sqlite';

export interface Migration {
  version: number;
  description: string;
  run: (db: SQLite.SQLiteDatabase, prefix: string) => Promise<void>;
}

export const CURRENT_SCHEMA_VERSION = 1;

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
];
