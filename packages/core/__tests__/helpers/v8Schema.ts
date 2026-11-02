import type { SQLiteAdapter } from '../../src/types';
import { openTestDatabase } from './sqliteAdapter';

/**
 * Genuine schema_version-8 store, for pre-v9 tests (specs/forget-pre-v9 §5).
 *
 * The DDL is verbatim `setupDatabase` from commit 8ebee301 (migration v8);
 * `git diff 8ebee301 4e9aa8d1~1 -- packages/core/src/db/schema.ts` is empty,
 * so this is the schema every database had right before v9 shipped. No
 * v10–v13 columns, no source_ref_index, no entries_fts. A v8 store always
 * has `meta`; databases older than that are out of scope.
 */
export function v8SchemaDdl(prefix: string): string {
  return `
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
      embedding_blob BLOB,
      okf_type TEXT,
      ontology_checked_at INTEGER,
      heal_checked_at INTEGER
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
      deleted_at INTEGER,
      okf_type TEXT
    );

    CREATE INDEX IF NOT EXISTS ${prefix}tasks_entity_idx ON ${prefix}tasks(entity_id, status);

    CREATE TABLE IF NOT EXISTS ${prefix}edges (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(entity_id, source_id, target_id, edge_type)
    );

    CREATE INDEX IF NOT EXISTS ${prefix}edges_entity_idx ON ${prefix}edges(entity_id);

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

    CREATE TABLE IF NOT EXISTS ${prefix}entity_manifests (
      entity_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'off',
      manifest_json TEXT NOT NULL DEFAULT '{"node_types":[],"edge_types":[]}',
      updated_at INTEGER NOT NULL
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
`;
}

export async function openV8Database(prefix = 'llm_wiki_'): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await db.execAsync(v8SchemaDdl(prefix));
  await db.runAsync(`INSERT INTO ${prefix}meta (key, value) VALUES ('schema_version', '8')`);
  return db;
}

/** Inserts a live v8-shaped entry; current source_type value so assertNoLegacySourceTypes passes. */
export async function insertV8Entry(
  db: SQLiteAdapter,
  row: { id: string; entityId: string; sourceRef: string; sourceHash: string; updatedAt: number },
  prefix = 'llm_wiki_',
): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${prefix}entries (id, entity_id, title, body, tags, confidence, source_type,
       source_hash, source_ref, created_at, updated_at, access_count)
     VALUES (?, ?, 'T', 'B', '[]', 'certain', 'immutable_document', ?, ?, ?, ?, 0)`,
    [row.id, row.entityId, row.sourceHash, row.sourceRef, row.updatedAt, row.updatedAt],
  );
}

/** The read-only listing query printed in reference/errors.md (spec §3.3). */
export function listDupGroupsSql(prefix = 'llm_wiki_'): string {
  return `SELECT entity_id, source_hash, GROUP_CONCAT(DISTINCT source_ref) AS source_refs
FROM ${prefix}entries
WHERE deleted_at IS NULL AND source_hash IS NOT NULL
GROUP BY entity_id, source_hash
HAVING COUNT(DISTINCT source_ref) > 1;`;
}

export async function sourceRefIndexExists(db: SQLiteAdapter, prefix = 'llm_wiki_'): Promise<boolean> {
  const row = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [`${prefix}source_ref_index`]);
  return row !== null;
}

export async function schemaVersion(db: SQLiteAdapter, prefix = 'llm_wiki_'): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM ${prefix}meta WHERE key = 'schema_version'`);
  return row?.value ?? null;
}
