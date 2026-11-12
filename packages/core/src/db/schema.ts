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
      embedding_attempts INTEGER NOT NULL DEFAULT 0,
      valid_from INTEGER,
      valid_to INTEGER,
      superseded_by TEXT,
      superseded_at INTEGER
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

    CREATE INDEX IF NOT EXISTS ${prefix}edges_entity_id_idx ON ${prefix}edges(entity_id, id);

    CREATE TABLE IF NOT EXISTS ${prefix}events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      related_entry_id TEXT,
      created_at INTEGER NOT NULL,
      occurred_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS ${prefix}events_entity_idx ON ${prefix}events(entity_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${prefix}checkpoints (
      entity_id TEXT PRIMARY KEY,
      heal_checkpoint INTEGER NOT NULL DEFAULT 0,
      memory_checkpoint INTEGER NOT NULL DEFAULT 0,
      librarian_watermark_at INTEGER,
      librarian_watermark_id TEXT
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

  // Vector-removal ledger (spec durable-vector-removal §5.1-5.2). Filled by
  // triggers on entries so every soft-delete path, including host raw SQL,
  // enqueues. No schema_version bump: created on every open.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS ${prefix}vector_removals (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id       TEXT NOT NULL,
      fact_id         TEXT NOT NULL UNIQUE,
      enqueued_at     INTEGER NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      confirmed_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS ${prefix}vector_removals_pending
      ON ${prefix}vector_removals (entity_id, attempts, seq) WHERE confirmed_at IS NULL;

    CREATE TRIGGER IF NOT EXISTS ${prefix}vector_removals_enqueue
    AFTER UPDATE OF deleted_at ON ${prefix}entries
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    BEGIN
      -- DELETE then INSERT, not INSERT OR REPLACE: an outer UPSERT's conflict
      -- handling would override OR REPLACE and abort on fact_id (spec rev 5).
      DELETE FROM ${prefix}vector_removals WHERE fact_id = NEW.id;
      INSERT INTO ${prefix}vector_removals (entity_id, fact_id, enqueued_at)
      VALUES (NEW.entity_id, NEW.id, CAST(strftime('%s','now') AS INTEGER) * 1000);
    END;

    -- A hard delete outside prune (host SQL, an older engine after a
    -- downgrade). A live fact is owed only where an external index was in use;
    -- a soft-deleted one drops the rows nothing can owe (spec rev 5).
    CREATE TRIGGER IF NOT EXISTS ${prefix}vector_removals_hard_delete
    AFTER DELETE ON ${prefix}entries
    BEGIN
      DELETE FROM ${prefix}vector_removals
       WHERE fact_id = OLD.id
         AND (OLD.deleted_at IS NULL
              OR confirmed_at IS NOT NULL
              OR NOT EXISTS (SELECT 1 FROM ${prefix}meta WHERE key = 'external_index_in_use' AND value = '1'));
      INSERT INTO ${prefix}vector_removals (entity_id, fact_id, enqueued_at)
      SELECT OLD.entity_id, OLD.id, CAST(strftime('%s','now') AS INTEGER) * 1000
       WHERE OLD.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM ${prefix}meta WHERE key = 'external_index_in_use' AND value = '1');
    END;
  `);

  // OKF v0.2 indexes — gated on column existence so we never try to create an
  // index on a column that hasn't been added yet (upgrade-from-pre-v10 case).
  // The columns themselves are in the CREATE TABLE above (fresh installs get
  // them directly) and in migration v10 (upgrades get them via ALTER TABLE).
  // The migration also creates these same indexes, so the IF NOT EXISTS guard
  // makes either path safe.
  await createOkfV02IndexesIfColumnsExist(db, prefix);
  await createTemporalIndexesIfColumnsExist(db, prefix);
  await createResurrectTrigger(db, prefix);
}

const EMBED_MARKER_COLUMNS = ['embedding_failed_at', 'embedding_failure_kind', 'embedding_attempts'];

/** 0: no vector columns yet; 1: clears the vector (rev 6); 2: also clears the failure markers (rev 7). */
function resurrectLevel(sql: string): 0 | 1 | 2 {
  if (sql.includes('embedding_failed_at')) return 2;
  return sql.includes('embedding_blob') ? 1 : 0;
}

/**
 * The ledger's resurrect trigger (spec durable-vector-removal §5.2). A
 * confirmed removal means the host's index no longer holds the vector, so a
 * restore clears the stored one and the reembed job embeds the fact and
 * sends it again (rev 6). Its embed failure markers are cleared too, or the
 * job could defer or skip the fact for good (rev 7).
 *
 * Gated on column existence like the indexes below: on an upgrade this runs
 * before migrations 3 and 11 add the columns, and a trigger body naming a
 * missing column fails every restore. Those migrations call it again, and a
 * trigger built for fewer columns is replaced once more of them exist.
 */
export async function createResurrectTrigger(db: SQLiteAdapter, prefix: string): Promise<void> {
  const name = `${prefix}vector_removals_resurrect`;
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${prefix}entries)`);
  const names = new Set(cols.map((c) => c.name));
  const want: 0 | 1 | 2 = !(names.has('embedding_blob') && names.has('embedding'))
    ? 0
    : EMBED_MARKER_COLUMNS.every((c) => names.has(c)) ? 2 : 1;
  const existing = await db.getFirstAsync<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
    [name],
  );
  if (existing) {
    if (resurrectLevel(existing.sql ?? '') >= want) return;
    await db.execAsync(`DROP TRIGGER IF EXISTS ${name};`);
  }
  // Embedding columns don't fire FTS triggers.
  const clearVector = want === 0 ? '' : `
      UPDATE ${prefix}entries
         SET embedding_blob = NULL, embedding = NULL${want === 2 ? `,
             embedding_failed_at = NULL, embedding_failure_kind = NULL, embedding_attempts = 0` : ''}
       WHERE id = NEW.id
         AND EXISTS (SELECT 1 FROM ${prefix}vector_removals WHERE fact_id = NEW.id AND confirmed_at IS NOT NULL);`;
  await db.execAsync(`
    CREATE TRIGGER IF NOT EXISTS ${name}
    AFTER UPDATE OF deleted_at ON ${prefix}entries
    WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
    BEGIN${clearVector}
      DELETE FROM ${prefix}vector_removals WHERE fact_id = NEW.id;
    END;
  `);
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

/**
 * Temporal indexes (spec 2026-09-29 §4.1). Gated on column existence for the
 * same reason as the OKF v0.2 indexes: on an upgrade from < v13 this runs
 * before migration 13 has added the columns.
 */
export async function createTemporalIndexesIfColumnsExist(db: SQLiteAdapter, prefix: string): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${prefix}entries)`);
  const names = new Set(cols.map((c) => c.name));
  if (names.has('superseded_by')) {
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS ${prefix}entries_superseded_idx ON ${prefix}entries(entity_id, superseded_by) WHERE superseded_by IS NOT NULL;`,
    );
  }
  if (names.has('valid_from') && names.has('valid_to')) {
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS ${prefix}entries_temporal_idx ON ${prefix}entries(entity_id) WHERE valid_from IS NOT NULL OR valid_to IS NOT NULL;`,
    );
  }
}
