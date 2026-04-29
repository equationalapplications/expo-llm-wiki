import * as SQLite from 'expo-sqlite';

export async function setupDatabase(db: SQLite.SQLiteDatabase, prefix: string) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS ${prefix}entries (
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

    -- FTS5 Virtual Table for full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS ${prefix}entries_fts USING fts5(
      title,
      body,
      tags,
      content='${prefix}entries',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS5 in sync with entries
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

    CREATE TABLE IF NOT EXISTS ${prefix}tasks (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      deleted_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS ${prefix}tasks_entity_idx ON ${prefix}tasks(entity_id, status);

    CREATE TABLE IF NOT EXISTS ${prefix}events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      related_entry_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ${prefix}events_entity_idx ON ${prefix}events(entity_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${prefix}checkpoints (
      entity_id TEXT PRIMARY KEY,
      heal_checkpoint INTEGER NOT NULL DEFAULT 0,
      memory_checkpoint INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migration: normalize source_ref values that pre-date the strip-separator rule (spec §13).
  // Idempotent — after the first run, no rows match the WHERE clause so subsequent calls
  // are no-ops.  Covers the three transformations that normalizeSourceRef() applies:
  //   • remove '/'  • remove '\'  • remove NUL bytes
  await db.runAsync(`
    UPDATE ${prefix}entries
    SET source_ref = TRIM(REPLACE(REPLACE(REPLACE(source_ref, '/', ''), '\', ''), CHAR(0), ''))
    WHERE source_ref IS NOT NULL
      AND (
        INSTR(source_ref, '/') > 0
        OR INSTR(source_ref, '\') > 0
        OR INSTR(source_ref, CHAR(0)) > 0
      )
  `);
}
