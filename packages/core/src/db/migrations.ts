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
      await db.withTransactionAsync(async (tx) => {
        await tx.execAsync(`
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
  {
    version: 5,
    description: 'Add okf_type to entries/tasks for OKF type fidelity; create edges table for OKF graph import',
    run: async (db, prefix) => {
      for (const table of ['entries', 'tasks'] as const) {
        const cols = await db.getAllAsync<{ name: string }>(
          `PRAGMA table_info(${prefix}${table})`
        );
        if (!cols.some(c => c.name === 'okf_type')) {
          await db.execAsync(`ALTER TABLE ${prefix}${table} ADD COLUMN okf_type TEXT`);
        }
      }
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS ${prefix}edges (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(entity_id, source_id, target_id, edge_type)
        );
        CREATE INDEX IF NOT EXISTS ${prefix}edges_entity_idx ON ${prefix}edges (entity_id);
      `);
    },
  },
  {
    version: 6,
    description: 'Add entity_manifests table for per-entity ontology state',
    run: async (db, prefix) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS ${prefix}entity_manifests (
          entity_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL DEFAULT 'off',
          manifest_json TEXT NOT NULL DEFAULT '{"node_types":[],"edge_types":[]}',
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 7,
    description: 'Add ontology_checked_at to entries for ontology backfill recheck cooldown',
    run: async (db, prefix) => {
      // ALTER TABLE ADD COLUMN must run outside any explicit transaction —
      // SQLite (and expo-sqlite) do not permit schema alterations inside
      // a BEGIN...COMMIT block. Same pattern as v2/v3/v5.
      const cols = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(${prefix}entries)`
      );
      if (!cols.some(c => c.name === 'ontology_checked_at')) {
        await db.execAsync(
          `ALTER TABLE ${prefix}entries ADD COLUMN ontology_checked_at INTEGER`
        );
      }
    },
  },
  {
    version: 8,
    description: 'Add heal_checked_at to entries for heal recheck cooldown',
    run: async (db, prefix) => {
      // ALTER TABLE ADD COLUMN must run outside any explicit transaction —
      // SQLite (and expo-sqlite) do not permit schema alterations inside
      // a BEGIN...COMMIT block. Same pattern as v2/v3/v5/v7.
      const cols = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(${prefix}entries)`
      );
      if (!cols.some(c => c.name === 'heal_checked_at')) {
        await db.execAsync(
          `ALTER TABLE ${prefix}entries ADD COLUMN heal_checked_at INTEGER`
        );
      }
    },
  },
  {
    version: 9,
    description: 'add_live_hash_unique_index',
    run: async (db, prefix) => {
      // Defense-in-depth safety net for the #79 TOCTOU race fix: enforce at
      // the DB level that at most one LIVE row per (entity_id, source_hash)
      // exists. The partial WHERE clause lets soft-deleted rows and NULL-hash
      // legacy rows coexist — same (entity_id, source_hash) may still exist
      // across a soft-delete + re-ingest cycle.
      //
      // If a previous ingest already produced live duplicates (i.e. a race
      // beat the new app-level guard), abort with an actionable error rather
      // than auto-resolving — auto-resolving would either destroy facts or
      // pick a wrong canonical, both worse than failing safe. The thrown
      // error escapes setup() BEFORE the CREATE INDEX runs, so the index is
      // never created and schema_version is never advanced.
      const duplicates = await db.getAllAsync<{ entity_id: string; source_hash: string; cnt: number }>(
        `SELECT entity_id, source_hash, COUNT(*) AS cnt
         FROM ${prefix}entries
         WHERE deleted_at IS NULL AND source_hash IS NOT NULL
         GROUP BY entity_id, source_hash
         HAVING COUNT(*) > 1`
      );
      if (duplicates.length > 0) {
        const sample = duplicates
          .slice(0, 5)
          .map(d => `(entity_id=${d.entity_id}, source_hash=${d.source_hash.slice(0, 12)}…, count=${d.cnt})`)
          .join(', ');
        throw new Error(
          `Migration v9 (add_live_hash_unique_index) failed: existing live rows violate the new UNIQUE index. ` +
          `Found ${duplicates.length} duplicate (entity_id, source_hash) groups. ` +
          `First ${Math.min(5, duplicates.length)}: ${sample}. ` +
          `Resolve by consolidating duplicates before re-running setup.`
        );
      }
      await db.execAsync(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${prefix}idx_entries_live_hash
         ON ${prefix}entries (entity_id, source_hash)
         WHERE deleted_at IS NULL AND source_hash IS NOT NULL`
      );
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
