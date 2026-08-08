import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions } from '../src/types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

const PREFIX = 'llm_wiki_';
const INDEX_NAME = `${PREFIX}idx_entries_live_hash`;

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

describe('migration v9: add_live_hash_unique_index', () => {
  it('CURRENT_SCHEMA_VERSION is 9 after the v9 migration is registered', async () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    expect(MIGRATIONS[MIGRATIONS.length - 1].description).toBe('add_live_hash_unique_index');
  });

  it('v9 migration creates the partial UNIQUE index on the entries table', async () => {
    // WikiMemory.setup() on a fresh DB sets schema_version = CURRENT_SCHEMA_VERSION
    // (9) directly and skips running migrations — the migration's effect is
    // verified by forcing a v0→v9 upgrade path: reset schema_version and re-run
    // setup() so the migration loop executes.
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    expect(await readSchemaVersion(db)).toBe('9');

    // Simulate a v0 DB so setup() runs every migration including v9.
    await db.runAsync(
      `UPDATE ${PREFIX}meta SET value = '0' WHERE key = 'schema_version'`,
    );
    await wiki.setup();

    expect(await readIndexExists(db)).toBe(true);
    expect(await readSchemaVersion(db)).toBe('9');
  });

  it('rerunning the v9 migration is idempotent: index exists exactly once and version stays 9', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    await db.runAsync(
      `UPDATE ${PREFIX}meta SET value = '0' WHERE key = 'schema_version'`,
    );
    await wiki.setup();
    await wiki.setup();

    expect(await readIndexExists(db)).toBe(true);
    // schema_version is still '9' — not bumped twice.
    expect(await readSchemaVersion(db)).toBe('9');
  });

  it('soft-deleted duplicates and NULL hashes do not collide — setup succeeds', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    // Same (entity_id, source_hash) as a live row, but soft-deleted.
    await insertEntry(db, {
      id: 'tombstone',
      entityId: 'ent',
      sourceRef: 'old.md',
      sourceHash: 'a'.repeat(64),
      updatedAt: 1000,
      deletedAt: 999,
    });
    // Same (entity_id) but NULL source_hash — the partial index excludes NULL.
    await insertEntry(db, {
      id: 'nullhash',
      entityId: 'ent',
      sourceRef: 'unrelated.md',
      sourceHash: null,
      updatedAt: 1100,
    });

    // A second setup() on the populated DB must NOT throw on either fixture.
    await expect(wiki.setup()).resolves.toBeUndefined();

    // Both rows still present (no destructive cleanup happened).
    const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${PREFIX}entries`);
    const ids = rows.map(r => r.id).sort();
    expect(ids).toEqual(['nullhash', 'tombstone']);
  });

  it('abort path: pre-existing live duplicate causes setup to throw with the exact actionable prefix', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    // Simulate a v8 DB state: roll schema_version back to 8 so the v9
    // migration will run on the next setup() call. Insert two LIVE rows
    // sharing (entity_id, source_hash) — the v9 migration's check must
    // detect this and abort BEFORE the CREATE INDEX.
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
    await db.runAsync(
      `UPDATE ${PREFIX}meta SET value = '8' WHERE key = 'schema_version'`,
    );

    // Re-running setup() must re-attempt v9 and abort with the exact prefix
    // documented in the spec. Throwing before CREATE INDEX means the index is
    // never created and schema_version is never advanced.
    await expect(wiki.setup()).rejects.toThrow(
      /^Migration v9 \(add_live_hash_unique_index\) failed: existing live rows violate the new UNIQUE index\./,
    );

    // Index must NOT have been created (we threw before CREATE INDEX).
    expect(await readIndexExists(db)).toBe(false);

    // schema_version must NOT have been advanced past 8.
    expect(await readSchemaVersion(db)).toBe('8');

    // No destructive cleanup — both live rows still present.
    const rows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE deleted_at IS NULL ORDER BY id`,
    );
    expect(rows.map(r => r.id)).toEqual(['live-a', 'live-b']);
  });
});
