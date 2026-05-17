import type { SQLiteAdapter } from '../types';

export async function setupDatabase(db: SQLiteAdapter, prefix: string) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS ${prefix}entries (
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
      embedding_blob BLOB
    );

    CREATE INDEX IF NOT EXISTS ${prefix}entries_entity_idx ON ${prefix}entries(entity_id);
    CREATE INDEX IF NOT EXISTS ${prefix}entries_source_ref_idx ON ${prefix}entries(entity_id, source_ref);
    CREATE INDEX IF NOT EXISTS ${prefix}entries_source_hash_idx ON ${prefix}entries(entity_id, source_hash) WHERE source_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ${prefix}entries_updated_idx ON ${prefix}entries(updated_at DESC);

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

    CREATE TABLE IF NOT EXISTS ${prefix}meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

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

    CREATE INDEX IF NOT EXISTS ${prefix}outbox_created_at
      ON ${prefix}outbox (created_at);
  `);
}
