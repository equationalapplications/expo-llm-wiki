import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import {
  ENTRIES_WM_KEY,
  NORMALIZE_STAMP_KEY,
  SRI_WM_KEY,
  probePendingWork,
  runSourceRefNormalize,
} from '../src/db/sourceRefNormalize';
import { normalizeSourceRef } from '../src/utils/pure';
import { WikiMigrationRequiredError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const P = 'llm_wiki_';
const LEGACY_IDX = `${P}entries_legacy_source_type_idx`;

async function freshDb(): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await new WikiMemory(db, stubOptions).setup();
  return db;
}
async function meta(db: SQLiteAdapter, key: string): Promise<string | null> {
  return (await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = ?`, [key]))?.value ?? null;
}
async function clearStamp(db: SQLiteAdapter): Promise<void> {
  await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [NORMALIZE_STAMP_KEY]);
}
async function insertEntry(db: SQLiteAdapter, id: string, sourceRef: string | null): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at) VALUES (?, 'e1', 't', 'b', ?, 1, 1)`,
    [id, sourceRef],
  );
}
async function insertSri(db: SQLiteAdapter, id: string, hash: string, sourceRef: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${P}source_ref_index (id, entity_id, source_hash, source_ref, created_at) VALUES (?, 'e1', ?, ?, 1)`,
    [id, hash, sourceRef],
  );
}
async function indexNames(db: SQLiteAdapter): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>(`PRAGMA index_list(${P}entries)`)).map((i) => i.name);
}

describe('normalizeSourceRef', () => {
  it('is a fixed point at the 255-char boundary', () => {
    const raw = 'a'.repeat(254) + ' b';
    const once = normalizeSourceRef(raw);
    expect(once).toBe('a'.repeat(254));
    expect(normalizeSourceRef(once!)).toBe(once);
  });

  it('is idempotent over a spread of inputs', () => {
    const inputs = ['  x  ', 'a/b\\c', '///', 'x'.repeat(300), `${'y'.repeat(253)}  z`, 'ok.md'];
    for (const v of inputs) {
      const n = normalizeSourceRef(v);
      if (n !== null) expect(normalizeSourceRef(n)).toBe(n);
    }
  });
});

describe('migration v14: legacy source_type partial index', () => {
  it('is the current schema version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(14);
    expect(MIGRATIONS[MIGRATIONS.length - 1].version).toBe(14);
  });

  it('fresh store gets the index, the stamp, and schema_version 14', async () => {
    const db = await freshDb();
    expect(await indexNames(db)).toContain(LEGACY_IDX);
    expect(await meta(db, 'schema_version')).toBe('14');
    expect(JSON.parse((await meta(db, NORMALIZE_STAMP_KEY))!)).toEqual({ schema_version: 14, normalize_alg: 1 });
  });

  it('upgrades a v13 store: builds the index and normalizes refs', async () => {
    const db = await freshDb();
    await db.execAsync(`DROP INDEX ${LEGACY_IDX}`);
    await clearStamp(db);
    await db.runAsync(`UPDATE ${P}meta SET value = '13' WHERE key = 'schema_version'`);
    await insertEntry(db, 'f1', ' mail/a.md ');
    await new WikiMemory(db, stubOptions).setup();
    expect(await indexNames(db)).toContain(LEGACY_IDX);
    expect(await meta(db, 'schema_version')).toBe('14');
    expect((await db.getFirstAsync<{ source_ref: string }>(`SELECT source_ref FROM ${P}entries WHERE id = 'f1'`))?.source_ref).toBe('maila.md');
  });

  it('fresh-store finalize is atomic: a failed index build leaves no schema_version to strand it', async () => {
    const db = openTestDatabase();
    const realExec = db.execAsync.bind(db);
    let failIndex = true;
    db.execAsync = async (sql: string) => {
      if (failIndex && sql.includes('entries_legacy_source_type_idx')) throw new Error('simulated crash');
      return realExec(sql);
    };
    await expect(new WikiMemory(db, stubOptions).setup()).rejects.toThrow('simulated crash');
    expect(await meta(db, 'schema_version')).toBeNull();
    expect(await meta(db, NORMALIZE_STAMP_KEY)).toBeNull();

    failIndex = false;
    await new WikiMemory(db, stubOptions).setup();
    expect(await indexNames(db)).toContain(LEGACY_IDX);
    expect(await meta(db, 'schema_version')).toBe('14');
  });

  it('setupDatabase does not create the index on an existing store', async () => {
    const db = await freshDb();
    await db.execAsync(`DROP INDEX ${LEGACY_IDX}`);
    await new WikiMemory(db, stubOptions).setup();
    expect(await indexNames(db)).not.toContain(LEGACY_IDX);
  });
});

describe('runSourceRefNormalize', () => {
  it('rewrites entries (NULL when empty) and soft-deletes NULL-normalizing source_ref_index rows', async () => {
    const db = await freshDb();
    await clearStamp(db);
    await insertEntry(db, 'f1', 'a/b.md');
    await insertEntry(db, 'f2', '///');
    await insertEntry(db, 'f3', 'clean.md');
    await insertSri(db, 's1', 'h1', ' x/y ');
    await insertSri(db, 's2', 'h2', '///');
    const m = new MetadataRepository(db, P);

    await runSourceRefNormalize(db, P, m);

    const entries = await db.getAllAsync<{ id: string; source_ref: string | null }>(`SELECT id, source_ref FROM ${P}entries ORDER BY id`);
    expect(entries).toEqual([
      { id: 'f1', source_ref: 'ab.md' },
      { id: 'f2', source_ref: null },
      { id: 'f3', source_ref: 'clean.md' },
    ]);
    const sri = await db.getAllAsync<{ id: string; source_ref: string; deleted_at: number | null }>(
      `SELECT id, source_ref, deleted_at FROM ${P}source_ref_index ORDER BY id`);
    expect(sri[0]).toMatchObject({ id: 's1', source_ref: 'xy', deleted_at: null });
    expect(sri[1]).toMatchObject({ id: 's2', source_ref: '///' });
    expect(sri[1].deleted_at).not.toBeNull();
    expect(await meta(db, NORMALIZE_STAMP_KEY)).not.toBeNull();
    expect(await meta(db, ENTRIES_WM_KEY)).toBeNull();
    expect(await meta(db, SRI_WM_KEY)).toBeNull();
  });

  it('chunks past 500 rows and clears watermarks on completion', async () => {
    const db = await freshDb();
    await clearStamp(db);
    await db.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 1201; i++) {
        await tx.runAsync(
          `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at) VALUES (?, 'e1', 't', 'b', ?, 1, 1)`,
          [`f${i}`, `dir/${i}`]);
      }
    });
    await runSourceRefNormalize(db, P, new MetadataRepository(db, P));
    const bad = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries WHERE source_ref LIKE 'dir/%'`);
    expect(bad?.n).toBe(0);
    expect(await meta(db, ENTRIES_WM_KEY)).toBeNull();
  });

  it('resumes from a valid watermark and restarts from 0 when its fingerprint mismatches', async () => {
    const db = await freshDb();
    await clearStamp(db);
    await insertEntry(db, 'f1', 'a/1');
    await insertEntry(db, 'f2', 'a/2');
    const f1 = await db.getFirstAsync<{ rowid: number }>(`SELECT rowid FROM ${P}entries WHERE id = 'f1'`);
    const m = new MetadataRepository(db, P);

    // Valid watermark at f1: f1 is treated as already done.
    await m.setMeta(ENTRIES_WM_KEY, JSON.stringify({ rowid: f1!.rowid, id: 'f1' }), db);
    await runSourceRefNormalize(db, P, m);
    const rows1 = await db.getAllAsync<{ id: string; source_ref: string }>(`SELECT id, source_ref FROM ${P}entries ORDER BY id`);
    expect(rows1).toEqual([{ id: 'f1', source_ref: 'a/1' }, { id: 'f2', source_ref: 'a2' }]);

    // Mismatched fingerprint (e.g. rowids reshuffled by VACUUM): full rescan.
    await clearStamp(db);
    await m.setMeta(ENTRIES_WM_KEY, JSON.stringify({ rowid: f1!.rowid, id: 'other' }), db);
    await runSourceRefNormalize(db, P, m);
    expect((await db.getFirstAsync<{ source_ref: string }>(`SELECT source_ref FROM ${P}entries WHERE id = 'f1'`))?.source_ref).toBe('a1');
  });

  it('is skipped when the stamp matches', async () => {
    const db = await freshDb();
    await insertEntry(db, 'f1', 'a/b');
    await runSourceRefNormalize(db, P, new MetadataRepository(db, P));
    expect((await db.getFirstAsync<{ source_ref: string }>(`SELECT source_ref FROM ${P}entries WHERE id = 'f1'`))?.source_ref).toBe('a/b');
  });
});

describe('probePendingWork + migration gate', () => {
  it('reports nothing on a fresh or up-to-date store', async () => {
    const empty = openTestDatabase();
    expect(await probePendingWork(new MetadataRepository(empty, P), P)).toBeNull();
    const db = await freshDb();
    expect(await probePendingWork(new MetadataRepository(db, P), P)).toBeNull();
  });

  it("treats entries without a meta table as a v0 schema migration, and 'refuse' does not create meta", async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE TABLE ${P}entries (id TEXT PRIMARY KEY)`);
    expect(await probePendingWork(new MetadataRepository(db, P), P))
      .toEqual({ type: 'schema_migration', fromVersion: 0, toVersion: CURRENT_SCHEMA_VERSION });
    await expect(new WikiMemory(db, stubOptions).setup({ migrations: 'refuse' })).rejects.toBeInstanceOf(WikiMigrationRequiredError);
    expect(await new MetadataRepository(db, P).tableExists(`${P}meta`)).toBe(false);
  });

  it('reports both pass watermarks', async () => {
    const db = await freshDb();
    await clearStamp(db);
    const m = new MetadataRepository(db, P);
    await m.setMeta(SRI_WM_KEY, JSON.stringify({ rowid: 7, id: 'x' }), db);
    expect(await probePendingWork(m, P)).toEqual({ type: 'source_ref_normalize', entriesWatermark: 0, sourceRefIndexWatermark: 7 });
  });

  it("'refuse' throws on a pending schema migration without mutating, naming real versions", async () => {
    const db = await freshDb();
    await db.execAsync(`DROP INDEX ${LEGACY_IDX}`);
    await db.runAsync(`UPDATE ${P}meta SET value = '13' WHERE key = 'schema_version'`);
    const err = await new WikiMemory(db, stubOptions).setup({ migrations: 'refuse' }).catch((e) => e);
    expect(err).toBeInstanceOf(WikiMigrationRequiredError);
    expect(err.pendingWork).toEqual({ type: 'schema_migration', fromVersion: 13, toVersion: 14 });
    expect(err.message).toContain('v13 -> v14');
    expect(await meta(db, 'schema_version')).toBe('13');
    expect(await indexNames(db)).not.toContain(LEGACY_IDX);
  });

  it("'auto' throws on a schema migration but runs a pending normalize", async () => {
    const db = await freshDb();
    await clearStamp(db);
    await insertEntry(db, 'f1', 'a/b');
    await new WikiMemory(db, stubOptions).setup({ migrations: 'auto' });
    expect((await db.getFirstAsync<{ source_ref: string }>(`SELECT source_ref FROM ${P}entries WHERE id = 'f1'`))?.source_ref).toBe('ab');

    await db.runAsync(`UPDATE ${P}meta SET value = '13' WHERE key = 'schema_version'`);
    await expect(new WikiMemory(db, stubOptions).setup({ migrations: 'auto' })).rejects.toBeInstanceOf(WikiMigrationRequiredError);
  });

  it("'refuse' passes once a plain setup() has stamped the store", async () => {
    const db = await freshDb();
    await clearStamp(db);
    await expect(new WikiMemory(db, stubOptions).setup({ migrations: 'refuse' })).rejects.toThrow(/normalize stamp missing/);
    await new WikiMemory(db, stubOptions).setup();
    await expect(new WikiMemory(db, stubOptions).setup({ migrations: 'refuse' })).resolves.toBeUndefined();
  });
});
