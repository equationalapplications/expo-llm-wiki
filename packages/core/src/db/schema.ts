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
      embedding_blob BLOB,
      okf_type TEXT,
      ontology_checked_at INTEGER,
      heal_checked_at INTEGER,
      lifecycle_status TEXT NOT NULL DEFAULT 'stable',
      stale_after INTEGER,
      generated_by TEXT,
      last_verified_at INTEGER,
      last_verified_by TEXT,
      okf_sources TEXT,
      okf_verified TEXT,
      okf_usage_window TEXT,
      embedding_failed_at INTEGER,
      embedding_failure_kind TEXT,
      embedding_attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS ${prefix}entries_entity_idx ON ${prefix}entries(entity_id);
    CREATE INDEX IF NOT EXISTS ${prefix}entries_source_ref_idx ON ${prefix}entries(entity_id, source_ref);
    CREATE INDEX IF NOT EXISTS ${prefix}entries_source_hash_idx ON ${prefix}entries(entity_id, source_hash) WHERE source_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ${prefix}entries_updated_idx ON ${prefix}entries(updated_at DESC);

    -- source_ref_index: per-(entity, source_hash) record of the canonical sourceRef
    -- currently holding that hash. The partial UNIQUE index on (entity_id, source_hash)
    -- WHERE deleted_at IS NULL enforces the sourceRef-level TOCTOU-race invariant;
    -- entries-level uniqueness cannot express it because a single ingestDocument call
    -- writes N facts that all share (entity_id, source_ref, source_hash). See
    -- docs/superpowers/specs/2026-08-07-dependabot-concurrency-release-hygiene-design.md §B1.
    CREATE TABLE IF NOT EXISTS ${prefix}source_ref_index (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ${prefix}idx_source_ref_hash
      ON ${prefix}source_ref_index (entity_id, source_hash)
      WHERE deleted_at IS NULL;

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
      okf_type TEXT,
      lifecycle_status TEXT NOT NULL DEFAULT 'stable',
      stale_after INTEGER,
      generated_by TEXT,
      last_verified_at INTEGER,
      last_verified_by TEXT,
      okf_sources TEXT,
      okf_verified TEXT,
      okf_usage_window TEXT
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
  `);

  // OKF v0.2 indexes — gated on column existence so we never try to create an
  // index on a column that hasn't been added yet (upgrade-from-pre-v10 case).
  // The columns themselves are in the CREATE TABLE above (fresh installs get
  // them directly) and in migration v10 (upgrades get them via ALTER TABLE).
  // The migration also creates these same indexes, so the IF NOT EXISTS guard
  // makes either path safe.
  await createOkfV02IndexesIfColumnsExist(db, prefix);
}

async function createOkfV02IndexesIfColumnsExist(db: SQLiteAdapter, prefix: string): Promise<void> {
  for (const table of ['entries', 'tasks'] as const) {
    const cols = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(${prefix}${table})`
    );
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has('lifecycle_status')) {
      await db.execAsync(`CREATE INDEX IF NOT EXISTS ${prefix}${table}_lifecycle_status_idx ON ${prefix}${table}(lifecycle_status);`);
    }
    if (colNames.has('stale_after')) {
      await db.execAsync(`CREATE INDEX IF NOT EXISTS ${prefix}${table}_stale_after_idx ON ${prefix}${table}(stale_after);`);
    }
    if (colNames.has('last_verified_at')) {
      await db.execAsync(`CREATE INDEX IF NOT EXISTS ${prefix}${table}_last_verified_at_idx ON ${prefix}${table}(last_verified_at);`);
    }
  }
}
