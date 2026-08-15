import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions } from '../src/types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

const PREFIX = 'llm_wiki_';
const INDEX_NAME = `${PREFIX}idx_source_ref_hash`;
const TABLE_NAME = `${PREFIX}source_ref_index`;

/**
 * Insert one row directly into `${prefix}entries` so the test can fabricate
 * a "pre-existing live duplicate" fixture that a fresh schema setup would
 * otherwise reject. The values match the columns setupDatabase creates.
 */
async function insertEntry(
  db: SQLiteAdapter,
  row: {
    id: string;
    entityId: string;
    sourceRef: string | null;
    sourceHash: string | null;
    updatedAt: number;
    deletedAt?: number | null;
  },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type,
      source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.entityId,
      'T',
      'B',
      '[]',
      'certain',
      'immutable_document',
      row.sourceHash,
      row.sourceRef,
      row.updatedAt,
      row.updatedAt,
      null,
      0,
      row.deletedAt ?? null,
    ],
  );
}

async function readSchemaVersion(db: SQLiteAdapter): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM ${PREFIX}meta WHERE key = 'schema_version'`,
  );
  return row?.value ?? null;
}

async function readIndexExists(db: SQLiteAdapter): Promise<boolean> {
  const row = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='index' AND name = ?`,
    [INDEX_NAME],
  );
  return row !== null;
}

async function readTableExists(db: SQLiteAdapter): Promise<boolean> {
  const row = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    [TABLE_NAME],
  );
  return row !== null;
}

async function readSourceRefIndexRow(
  db: SQLiteAdapter,
  entityId: string,
  sourceHash: string,
): Promise<{ source_ref: string; deleted_at: number | null } | null> {
  return db.getFirstAsync(
    `SELECT source_ref, deleted_at FROM ${TABLE_NAME}
     WHERE entity_id = ? AND source_hash = ?`,
    [entityId, sourceHash],
  );
}

describe('migration v9: add_source_ref_index', () => {
  it('CURRENT_SCHEMA_VERSION is at least 9 after the v9 migration is registered', async () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    expect(MIGRATIONS[MIGRATIONS.length - 1].description).not.toBe('add_source_ref_index');
  });

  it('v9 migration creates the source_ref_index table and its UNIQUE index', async () => {
    // WikiMemory.setup() on a fresh DB sets schema_version = CURRENT_SCHEMA_VERSION
    // (now 10) directly and skips running migrations — the migration's effect is
    // verified by forcing a v0→v9 upgrade path: reset schema_version and re-run
    // setup() so the migration loop executes.
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    expect(await readSchemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));

    // Simulate a v0 DB so setup() runs every migration including v9.
    await db.runAsync(
      `UPDATE ${PREFIX}meta SET value = '0' WHERE key = 'schema_version'`,
    );
    await wiki.setup();

    expect(await readIndexExists(db)).toBe(true);
    expect(await readTableExists(db)).toBe(true);
    expect(await readSchemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
  });

  it('rerunning the v9 migration is idempotent: index/table exist exactly once and version stays stable', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    await db.runAsync(
      `UPDATE ${PREFIX}meta SET value = '0' WHERE key = 'schema_version'`,
    );
    await wiki.setup();
    await wiki.setup();

    expect(await readIndexExists(db)).toBe(true);
    expect(await readTableExists(db)).toBe(true);
    // schema_version is stable — not bumped twice.
    expect(await readSchemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
  });

  it('soft-deleted duplicates and NULL hashes do not collide — backfill succeeds, setup returns', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    // Live row with the same (entity_id, source_hash) as the tombstone below.
    // The new v9 backfill must pick the live row's sourceRef; soft-deleted
    // and NULL-hash rows are excluded.
    await insertEntry(db, {
      id: 'live',
      entityId: 'ent',
      sourceRef: 'current.md',
      sourceHash: 'a'.repeat(64),
      updatedAt: 1000,
    });
    // Same (entity_id, source_hash) as the live row, but soft-deleted.
    // The backfill's `WHERE deleted_at IS NULL` filter excludes this row.
    await insertEntry(db, {
      id: 'tombstone',
      entityId: 'ent',
      sourceRef: 'old.md',
      sourceHash: 'a'.repeat(64),
      updatedAt: 1000,
      deletedAt: 999,
    });
    // Same (entity_id) but NULL source_hash — the backfill's
    // `AND source_hash IS NOT NULL` filter excludes this row.
    await insertEntry(db, {
      id: 'nullhash',
      entityId: 'ent',
      sourceRef: 'unrelated.md',
      sourceHash: null,
      updatedAt: 1100,
    });

    // Force a v0→v9 upgrade path: drop the source_ref_index table (it was
    // created by setupDatabase on the fresh DB) and reset schema_version to
    // 0 so the migration loop runs and the backfill executes.
    await db.runAsync(`DROP TABLE ${TABLE_NAME}`);
    await db.runAsync(
      `UPDATE ${PREFIX}meta SET value = '0' WHERE key = 'schema_version'`,
    );
    await expect(wiki.setup()).resolves.toBeUndefined();

    // All three entries rows still present (no destructive cleanup happened).
    const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${PREFIX}entries`);
    const ids = rows.map(r => r.id).sort();
    expect(ids).toEqual(['live', 'nullhash', 'tombstone']);

    // The source_ref_index backfill picked the live row's sourceRef.
    const sriRow = await readSourceRefIndexRow(db, 'ent', 'a'.repeat(64));
    expect(sriRow).not.toBeNull();
    expect(sriRow!.source_ref).toBe('current.md');
    expect(sriRow!.deleted_at).toBeNull();
  });

  it('abort path: pre-existing live duplicate sourceRefs cause setup to throw with the exact actionable prefix', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    // Simulate a v8 DB state: roll schema_version back to 8 so the v9
    // migration will run on the next setup() call. Drop the source_ref_index
    // table (it was created by setupDatabase on the fresh DB) so the
    // assertion below proves the migration did NOT create it. Insert two
    // LIVE rows sharing (entity_id, source_hash) under DISTINCT source_refs
    // — the v9 migration's check must detect this and abort BEFORE the
    // CREATE TABLE. The new check counts DISTINCT source_refs, not rows;
    // multiple facts per sourceRef are no longer a violation.
    const dupHash = 'd'.repeat(64);
    await insertEntry(db, {
      id: 'live-a',
      entityId: 'ent',
      sourceRef: 'a.md',
      sourceHash: dupHash,
      updatedAt: 1000,
    });
    await insertEntry(db, {
      id: 'live-b',
      entityId: 'ent',
      sourceRef: 'b.md',
      sourceHash: dupHash,
      updatedAt: 1100,
    });
    await db.runAsync(`DROP TABLE ${TABLE_NAME}`);
    await db.runAsync(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
    await db.runAsync(
      `UPDATE ${PREFIX}meta SET value = '8' WHERE key = 'schema_version'`,
    );

    // Re-running setup() must re-attempt v9 and abort with the exact prefix
    // documented in the spec. Throwing before CREATE TABLE means the new
    // table is never created and schema_version is never advanced.
    await expect(wiki.setup()).rejects.toThrow(
      /^Migration v9 \(add_source_ref_index\) failed: existing live rows have multiple sourceRefs sharing a hash\./,
    );

    // Table and index exist (they were recreated by setupDatabase's
    // IF NOT EXISTS at the start of the second setup() call), but the
    // backfill did NOT run — the source_ref_index table is empty.
    expect(await readTableExists(db)).toBe(true);
    const sriRows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${TABLE_NAME}`,
    );
    expect(sriRows).toEqual([]);

    // schema_version must NOT have been advanced past 8.
    expect(await readSchemaVersion(db)).toBe('8');

    // No destructive cleanup — both live rows still present.
    const rows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE deleted_at IS NULL ORDER BY id`,
    );
    expect(rows.map(r => r.id)).toEqual(['live-a', 'live-b']);
  });

  it('backfill picks the earliest sourceRef per (entity, hash) when multiple sourceRefs share a hash (pre-backfilled state)', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    // Force a v0→v9 upgrade path. The first setup() above already
    // created the v9 table; reset schema_version to 0 and re-run setup
    // to verify the backfill is idempotent and picks the canonical
    // sourceRef.
    const dupHash = 'd'.repeat(64);
    await insertEntry(db, {
      id: 'live-a',
      entityId: 'ent',
      sourceRef: 'a.md',
      sourceHash: dupHash,
      updatedAt: 2000,
    });
    await insertEntry(db, {
      id: 'live-b',
      entityId: 'ent',
      sourceRef: 'b.md',
      sourceHash: dupHash,
      updatedAt: 1000, // earlier than live-a, so the backfill must pick this
    });
    await db.runAsync(
      `UPDATE ${PREFIX}meta SET value = '0' WHERE key = 'schema_version'`,
    );

    // Two live rows under distinct sourceRefs sharing one hash → the
    // v9 abort path fires. The test exercises the backfill at the
    // v9→current setup() path once the abort is cleared. For this
    // test, drop one of the duplicate sourceRefs to let the backfill
    // run.
    await db.runAsync(
      `UPDATE ${PREFIX}entries SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND entity_id = ?`,
      [3000, 3000, 'live-b', 'ent'],
    );
    await wiki.setup();

    // The backfill must have picked the earlier sourceRef (b.md had the
    // smaller updated_at, but a.md is the only live row now after the
    // soft-delete above).
    const sriRow = await readSourceRefIndexRow(db, 'ent', dupHash);
    expect(sriRow).not.toBeNull();
    expect(sriRow!.source_ref).toBe('a.md');
    expect(sriRow!.deleted_at).toBeNull();
  });
});
