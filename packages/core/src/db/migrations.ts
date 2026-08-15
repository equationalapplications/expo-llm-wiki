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
    description: 'add_source_ref_index',
    run: async (db, prefix) => {
      // Defense-in-depth safety net for the #79 TOCTOU race fix. The original
      // design put a UNIQUE index on `entries(entity_id, source_hash)`, but
      // that conflates per-fact and per-sourceRef granularity: a single
      // `ingestDocument` writes N facts that all share
      // (entity_id, source_ref, source_hash), and the 2nd–Nth inserts hit
      // SQLITE_CONSTRAINT_UNIQUE inside the normal multi-fact path. The
      // correct invariant is "at most one sourceRef per (entity, hash)", so
      // the constraint lives on a dedicated per-(entity, hash) table that
      // records the canonical sourceRef for each hash. See
      // docs/superpowers/specs/2026-08-07-dependabot-concurrency-release-hygiene-design.md §B1.
      //
      // Abort path: if any (entity_id, source_hash) already has live rows
      // under multiple distinct source_refs, a previous race beat the new
      // app-level guard. The migration aborts with an actionable error
      // rather than auto-resolving — auto-resolving would either destroy
      // facts or pick a wrong canonical, both worse than failing safe. The
      // thrown error escapes setup() BEFORE the CREATE TABLE runs, so the
      // new table is never created and schema_version is never advanced.
      const duplicates = await db.getAllAsync<{ entity_id: string; source_hash: string; n_refs: number }>(
        `SELECT entity_id, source_hash, COUNT(DISTINCT source_ref) AS n_refs
         FROM ${prefix}entries
         WHERE deleted_at IS NULL AND source_hash IS NOT NULL
         GROUP BY entity_id, source_hash
         HAVING COUNT(DISTINCT source_ref) > 1`
      );
      if (duplicates.length > 0) {
        const sample = duplicates
          .slice(0, 5)
          .map(d => `(entity_id=${d.entity_id}, source_hash=${d.source_hash.slice(0, 12)}…, n_refs=${d.n_refs})`)
          .join(', ');
        throw new Error(
          `Migration v9 (add_source_ref_index) failed: existing live rows have multiple sourceRefs sharing a hash. ` +
          `Found ${duplicates.length} duplicate (entity_id, source_hash) groups. ` +
          `First ${Math.min(5, duplicates.length)}: ${sample}. ` +
          `Resolve each by calling forget({ sourceRef: <loser> }) for the offending sourceRef, then re-run setup.`
        );
      }
      await db.execAsync(
        `CREATE TABLE IF NOT EXISTS ${prefix}source_ref_index (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ${prefix}idx_source_ref_hash
          ON ${prefix}source_ref_index (entity_id, source_hash)
          WHERE deleted_at IS NULL;`
      );
      // Backfill: for each (entity_id, source_hash) group with live entries,
      // pick the sourceRef of the entry that wins
      // `ROW_NUMBER() OVER (PARTITION BY entity_id, source_hash ORDER BY updated_at ASC, id ASC) = 1`.
      // The tie-breaker `id ASC` matches `findLatestSourceHash` ordering so
      // the canonical row is deterministic. INSERT OR IGNORE with a
      // deterministic ID (`sri_<entity_id>:<source_hash>`) makes the backfill
      // idempotent — re-running v9 is a no-op.
      await db.execAsync(
        `INSERT OR IGNORE INTO ${prefix}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at)
         SELECT
           'sri:' || entity_id || ':' || source_hash,
           entity_id,
           source_hash,
           source_ref,
           updated_at,
           NULL
         FROM (
           SELECT
             entity_id, source_hash, source_ref, updated_at,
             ROW_NUMBER() OVER (
               PARTITION BY entity_id, source_hash
               ORDER BY updated_at ASC, id ASC
             ) AS rn
           FROM ${prefix}entries
           WHERE deleted_at IS NULL
             AND source_hash IS NOT NULL
             AND source_ref IS NOT NULL
         ) ranked
         WHERE rn = 1;`
      );
    },
  },
  {
    version: 10,
    description: 'OKF v0.2: add lifecycle_status, stale_after, generated_by, last_verified_*, okf_sources, okf_verified, okf_usage_window to entries and tasks',
    run: async (db, prefix) => {
      // ALTER TABLE ADD COLUMN must run outside any explicit transaction — same constraint
      // as v2/v3/v5/v7/v8. We do all eight columns per table, then indexes, inside
      // a single execAsync batch where possible. SQLite ALTER on the same table from
      // separate statements is fine; we just can't wrap it in BEGIN...COMMIT.
      for (const table of ['entries', 'tasks'] as const) {
        const cols = await db.getAllAsync<{ name: string }>(
          `PRAGMA table_info(${prefix}${table})`
        );
        const existing = new Set(cols.map((c) => c.name));
        const adds: Array<[string, string]> = [
          ['lifecycle_status', `ALTER TABLE ${prefix}${table} ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'stable'`],
          ['stale_after', `ALTER TABLE ${prefix}${table} ADD COLUMN stale_after INTEGER`],
          ['generated_by', `ALTER TABLE ${prefix}${table} ADD COLUMN generated_by TEXT`],
          ['last_verified_at', `ALTER TABLE ${prefix}${table} ADD COLUMN last_verified_at INTEGER`],
          ['last_verified_by', `ALTER TABLE ${prefix}${table} ADD COLUMN last_verified_by TEXT`],
          ['okf_sources', `ALTER TABLE ${prefix}${table} ADD COLUMN okf_sources TEXT`],
          ['okf_verified', `ALTER TABLE ${prefix}${table} ADD COLUMN okf_verified TEXT`],
          ['okf_usage_window', `ALTER TABLE ${prefix}${table} ADD COLUMN okf_usage_window TEXT`],
        ];
        for (const [name, sql] of adds) {
          if (!existing.has(name)) await db.execAsync(sql);
        }
      }
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS ${prefix}entries_lifecycle_status_idx ON ${prefix}entries(lifecycle_status);
        CREATE INDEX IF NOT EXISTS ${prefix}entries_stale_after_idx ON ${prefix}entries(stale_after);
        CREATE INDEX IF NOT EXISTS ${prefix}entries_last_verified_at_idx ON ${prefix}entries(last_verified_at);
        CREATE INDEX IF NOT EXISTS ${prefix}tasks_lifecycle_status_idx ON ${prefix}tasks(lifecycle_status);
        CREATE INDEX IF NOT EXISTS ${prefix}tasks_stale_after_idx ON ${prefix}tasks(stale_after);
        CREATE INDEX IF NOT EXISTS ${prefix}tasks_last_verified_at_idx ON ${prefix}tasks(last_verified_at);
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
