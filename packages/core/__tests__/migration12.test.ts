import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

async function freshDb(): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await new WikiMemory(db, stubOptions).setup();
  return db;
}

/** Explicitly created (non-autoindex) indexes on edges, with their column lists. */
async function edgeIndexes(db: SQLiteAdapter): Promise<Record<string, string[]>> {
  const list = await db.getAllAsync<{ name: string; origin: string }>(`PRAGMA index_list(${PREFIX}edges)`);
  const out: Record<string, string[]> = {};
  for (const { name, origin } of list) {
    if (origin !== 'c') continue;
    const cols = await db.getAllAsync<{ name: string }>(`PRAGMA index_info(${name})`);
    out[name] = cols.map((c) => c.name);
  }
  return out;
}

async function schemaVersion(db: SQLiteAdapter): Promise<string | undefined> {
  return (await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${PREFIX}meta WHERE key = 'schema_version'`))?.value;
}

/** Turn a fresh DB back into a v11 DB: old index, no new index, version 11. */
async function downgradeToV11(db: SQLiteAdapter): Promise<void> {
  await db.execAsync(`
    DROP INDEX IF EXISTS ${PREFIX}edges_entity_id_idx;
    CREATE INDEX IF NOT EXISTS ${PREFIX}edges_entity_idx ON ${PREFIX}edges(entity_id);
  `);
  await db.runAsync(`UPDATE ${PREFIX}meta SET value = '11' WHERE key = 'schema_version'`);
}

describe('migration v12: composite edges(entity_id, id) index', () => {
  it('CURRENT_SCHEMA_VERSION is the last migration and at least 12', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    expect(CURRENT_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it('fresh install has edges_entity_id_idx on (entity_id, id) and no edges_entity_idx', async () => {
    const db = await freshDb();
    expect(await edgeIndexes(db)).toEqual({ [`${PREFIX}edges_entity_id_idx`]: ['entity_id', 'id'] });
  });

  it('upgrades a v11 database: new index present, old index gone, version stamped', async () => {
    const db = await freshDb();
    await downgradeToV11(db);
    expect(Object.keys(await edgeIndexes(db))).toEqual([`${PREFIX}edges_entity_idx`]);
    await db.runAsync(
      `INSERT INTO ${PREFIX}edges (id, entity_id, source_id, target_id, edge_type, created_at) VALUES ('edge_1', 'e1', 's', 't', 'rel', 0)`,
    );

    await new WikiMemory(db, stubOptions).setup();

    expect(await edgeIndexes(db)).toEqual({ [`${PREFIX}edges_entity_id_idx`]: ['entity_id', 'id'] });
    expect(await schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    const kept = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${PREFIX}edges`);
    expect(kept).toEqual([{ id: 'edge_1' }]);
  });

  it('v12 itself creates the new index and drops the old one (independent of schema.ts)', async () => {
    const db = await freshDb();
    await downgradeToV11(db);
    await MIGRATIONS.find((m) => m.version === 12)!.run(db, PREFIX);
    expect(await edgeIndexes(db)).toEqual({ [`${PREFIX}edges_entity_id_idx`]: ['entity_id', 'id'] });
  });

  it('running v12 twice is a no-op', async () => {
    const db = await freshDb();
    const v12 = MIGRATIONS.find((m) => m.version === 12)!;
    await v12.run(db, PREFIX);
    await v12.run(db, PREFIX);
    expect(await edgeIndexes(db)).toEqual({ [`${PREFIX}edges_entity_id_idx`]: ['entity_id', 'id'] });
  });

  it('a fresh database and an upgraded database end with the same edges indexes', async () => {
    const fresh = await freshDb();
    const upgraded = await freshDb();
    await downgradeToV11(upgraded);
    await new WikiMemory(upgraded, stubOptions).setup();
    expect(await edgeIndexes(upgraded)).toEqual(await edgeIndexes(fresh));
  });
});