import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { WikiMigrationRequiredError } from '../src/types';
import type { SQLiteAdapter, WikiOptions } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import {
  insertV8Entry,
  listDupGroupsSql,
  openV8Database,
  schemaVersion,
  sourceRefIndexExists,
} from './helpers/v8Schema';

// specs/forget-pre-v9 (#316): forget() on a database stuck before migration v9.

const P = 'llm_wiki_';
const H1 = 'd'.repeat(64);
const H2 = 'e'.repeat(64);
const options: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
  config: { enableOutbox: true },
};

/** v8 store with one live duplicate group: a.md (2 rows, earlier) and b.md (1 row) share H1. */
async function dupFixture(): Promise<SQLiteAdapter> {
  const db = await openV8Database();
  await insertV8Entry(db, { id: 'a1', entityId: 'ent', sourceRef: 'a.md', sourceHash: H1, updatedAt: 1000 });
  await insertV8Entry(db, { id: 'a2', entityId: 'ent', sourceRef: 'a.md', sourceHash: H1, updatedAt: 1000 });
  await insertV8Entry(db, { id: 'b1', entityId: 'ent', sourceRef: 'b.md', sourceHash: H1, updatedAt: 1100 });
  return db;
}

async function liveIds(db: SQLiteAdapter): Promise<string[]> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM ${P}entries WHERE deleted_at IS NULL ORDER BY id`);
  return rows.map(r => r.id);
}

async function outboxDeletes(db: SQLiteAdapter): Promise<string[]> {
  const rows = await db.getAllAsync<{ record_id: string }>(
    `SELECT record_id FROM ${P}outbox WHERE operation = 'DELETE' ORDER BY record_id`);
  return rows.map(r => r.record_id);
}

async function liveIndexRows(db: SQLiteAdapter) {
  return db.getAllAsync<{ entity_id: string; source_hash: string; source_ref: string }>(
    `SELECT entity_id, source_hash, source_ref FROM ${P}source_ref_index
     WHERE deleted_at IS NULL ORDER BY entity_id, source_hash`);
}

/** Runs the documented listing query and forgets every ref but the first (sorted) per group. */
async function forgetLosers(db: SQLiteAdapter, wiki: WikiMemory): Promise<number> {
  const groups = await db.getAllAsync<{ entity_id: string; source_hash: string; source_refs: string }>(listDupGroupsSql(P));
  for (const g of groups) {
    const [, ...losers] = g.source_refs.split(',').sort();
    for (const loser of losers) await wiki.forget(g.entity_id, { sourceRef: loser, sourceHash: g.source_hash });
  }
  return groups.length;
}

describe('forget() before migration v9 (#316)', () => {
  it('fixture: openV8Database is a genuine v8 store that setup() migrates to CURRENT', async () => {
    const db = await openV8Database();
    const cols = (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${P}entries)`)).map(c => c.name);
    expect(cols).toContain('heal_checked_at');
    expect(cols).not.toContain('lifecycle_status');
    expect(cols).not.toContain('valid_to');
    expect(await sourceRefIndexExists(db)).toBe(false);
    expect(await schemaVersion(db)).toBe('8');

    await insertV8Entry(db, { id: 'x1', entityId: 'ent', sourceRef: 'x.md', sourceHash: H1, updatedAt: 1 });
    await new WikiMemory(db, options).setup();
    expect(await schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(await liveIndexRows(db)).toEqual([{ entity_id: 'ent', source_hash: H1, source_ref: 'x.md' }]);
  });

  it('case B: forget({ sourceRef }) on a never-set-up v8 store deletes the loser and leaves the index absent', async () => {
    const db = await dupFixture();
    const wiki = new WikiMemory(db, options);

    await expect(wiki.forget('ent', { sourceRef: 'b.md' })).resolves.toEqual({ deleted: { entries: 1, tasks: 0 } });

    expect(await liveIds(db)).toEqual(['a1', 'a2']);
    expect(await sourceRefIndexExists(db)).toBe(false);
    expect(await outboxDeletes(db)).toEqual(['b1']);
  });

  it('clearAll + includeEvents on a never-set-up v8 store wipes facts, edges and events, and leaves the index absent (spec import-followups §6)', async () => {
    const db = await dupFixture();
    await insertV8Entry(db, { id: 'o1', entityId: 'other', sourceRef: 'o.md', sourceHash: H2, updatedAt: 1 });
    await db.runAsync(`INSERT INTO ${P}edges (id, entity_id, source_id, target_id, edge_type, created_at) VALUES ('g1', 'ent', 'a1', 'b1', 'rel', 1), ('g2', 'other', 'o1', 'o1', 'rel', 1)`);
    await db.runAsync(`INSERT INTO ${P}events (id, entity_id, event_type, summary, related_entry_id, created_at) VALUES ('v1', 'ent', 'observation', 'x', NULL, 1), ('v2', 'other', 'observation', 'y', NULL, 1)`);
    const wiki = new WikiMemory(db, options);

    await expect(wiki.forget('ent', { clearAll: true, includeEvents: true }))
      .resolves.toEqual({ deleted: { entries: 3, tasks: 0, events: 1 }, metadataReset: true });

    expect(await liveIds(db)).toEqual(['o1']);
    expect(await sourceRefIndexExists(db)).toBe(false);
    expect((await db.getAllAsync<{ id: string }>(`SELECT id FROM ${P}edges ORDER BY id`)).map(r => r.id)).toEqual(['g2']);
    expect((await db.getAllAsync<{ id: string }>(`SELECT id FROM ${P}events ORDER BY id`)).map(r => r.id)).toEqual(['v2']);
  });

  it('case C: forget({ sourceRef }) works after setup({ migrations: "refuse" }) refused the open', async () => {
    const db = await dupFixture();
    const wiki = new WikiMemory(db, options);
    await expect(wiki.setup({ migrations: 'refuse' })).rejects.toBeInstanceOf(WikiMigrationRequiredError);
    expect(await sourceRefIndexExists(db)).toBe(false);

    await expect(wiki.forget('ent', { sourceRef: 'b.md' })).resolves.toEqual({ deleted: { entries: 1, tasks: 0 } });

    expect(await liveIds(db)).toEqual(['a1', 'a2']);
    expect(await sourceRefIndexExists(db)).toBe(false);
    expect(await outboxDeletes(db)).toEqual(['b1']);
  });

  it('case A: the documented recovery loop on one instance completes setup()', async () => {
    const db = await dupFixture();
    const wiki = new WikiMemory(db, options);

    let message = '';
    await wiki.setup().then(
      () => { throw new Error('setup() should have thrown'); },
      (e: Error) => { message = e.message; },
    );
    expect(message).toMatch(
      /^Migration v9 \(add_source_ref_index\) failed: existing live rows have multiple sourceRefs sharing a hash\./,
    );
    expect(message).toContain('Found 1 duplicate (entity_id, source_hash) groups.');
    expect(message).toMatch(/\(entity_id=ent, source_hash=d{12}…, n_refs=2\)/);
    expect(message).toContain("forget(entityId, { sourceRef: <loser>, sourceHash: <group's full source_hash> })");
    expect(message).toMatch(/then re-run setup\(\)\.$/);
    expect(await schemaVersion(db)).toBe('8');

    expect(await forgetLosers(db, wiki)).toBe(1);
    await wiki.setup();

    expect(await schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(await liveIndexRows(db)).toEqual([{ entity_id: 'ent', source_hash: H1, source_ref: 'a.md' }]);
    expect(await liveIds(db)).toEqual(['a1', 'a2']);
  });

  it('recovery loop from a never-set-up instance, two groups, then setup() on a new instance', async () => {
    const db = await dupFixture();
    await insertV8Entry(db, { id: 'x1', entityId: 'ent2', sourceRef: 'x.md', sourceHash: H2, updatedAt: 2000 });
    await insertV8Entry(db, { id: 'y1', entityId: 'ent2', sourceRef: 'y.md', sourceHash: H2, updatedAt: 2100 });

    // Recovery tool run before any 'allow' open (spec §2.2): source_ref_index genuinely absent.
    const recovery = new WikiMemory(db, options);
    expect(await sourceRefIndexExists(db)).toBe(false);
    expect(await forgetLosers(db, recovery)).toBe(2);
    expect(await db.getAllAsync(listDupGroupsSql(P))).toEqual([]);
    expect(await outboxDeletes(db)).toEqual(['b1', 'y1']);

    const app = new WikiMemory(db, options);
    await app.setup();

    expect(await schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(await liveIndexRows(db)).toEqual([
      { entity_id: 'ent', source_hash: H1, source_ref: 'a.md' },
      { entity_id: 'ent2', source_hash: H2, source_ref: 'x.md' },
    ]);
    expect(await liveIds(db)).toEqual(['a1', 'a2', 'x1']);
  });
});

describe('recovery is scoped per group (#316)', () => {
  it('a ref that loses one group but keeps another keeps its kept rows', async () => {
    // a.md keeps H1 (earliest, sorted first) but loses H2 to 0.md; b.md loses H1.
    const db = await openV8Database();
    await insertV8Entry(db, { id: 'a1', entityId: 'ent', sourceRef: 'a.md', sourceHash: H1, updatedAt: 1000 });
    await insertV8Entry(db, { id: 'b1', entityId: 'ent', sourceRef: 'b.md', sourceHash: H1, updatedAt: 1100 });
    await insertV8Entry(db, { id: 'z1', entityId: 'ent', sourceRef: '0.md', sourceHash: H2, updatedAt: 900 });
    await insertV8Entry(db, { id: 'a3', entityId: 'ent', sourceRef: 'a.md', sourceHash: H2, updatedAt: 1200 });
    const wiki = new WikiMemory(db, options);

    expect(await forgetLosers(db, wiki)).toBe(2);
    expect(await liveIds(db)).toEqual(['a1', 'z1']);

    await wiki.setup();
    expect(await liveIndexRows(db)).toEqual([
      { entity_id: 'ent', source_hash: H1, source_ref: 'a.md' },
      { entity_id: 'ent', source_hash: H2, source_ref: '0.md' },
    ]);
  });
});

describe('custom tablePrefix (#316)', () => {
  const X = 'x_';
  const xOptions: WikiOptions = { ...options, config: { ...options.config, tablePrefix: X } };

  it('pre-v9: forget({ sourceRef }) skips the missing x_source_ref_index', async () => {
    const db = await openV8Database(X);
    await insertV8Entry(db, { id: 'a1', entityId: 'ent', sourceRef: 'a.md', sourceHash: H1, updatedAt: 1000 }, X);
    await insertV8Entry(db, { id: 'b1', entityId: 'ent', sourceRef: 'b.md', sourceHash: H1, updatedAt: 1100 }, X);
    const wiki = new WikiMemory(db, xOptions);
    await expect(wiki.forget('ent', { sourceRef: 'b.md' })).resolves.toEqual({ deleted: { entries: 1, tasks: 0 } });
    expect(await sourceRefIndexExists(db, X)).toBe(false);
    await wiki.setup();
    expect(await schemaVersion(db, X)).toBe(String(CURRENT_SCHEMA_VERSION));
  });

  it('post-v9: forget({ sourceRef }) soft-deletes the x_source_ref_index row', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, xOptions);
    await wiki.setup();
    await insertV8Entry(db, { id: 'r1', entityId: 'ent', sourceRef: 'r.md', sourceHash: H1, updatedAt: 1 }, X);
    await db.runAsync(
      `INSERT INTO ${X}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at)
       VALUES ('sri_test_r', 'ent', ?, 'r.md', 1, NULL)`, [H1]);
    await expect(wiki.forget('ent', { sourceRef: 'r.md' })).resolves.toEqual({ deleted: { entries: 1, tasks: 0 } });
    const row = await db.getFirstAsync<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM ${X}source_ref_index WHERE id = 'sri_test_r'`);
    expect(row?.deleted_at).not.toBeNull();
  });
});

describe('docs recipe (#316)', () => {
  it('reference/errors.md prints the exact listing query these tests run', () => {
    const docs = readFileSync(
      new URL('../../../apps/docs/src/content/docs/reference/errors.md', import.meta.url), 'utf8');
    expect(docs).toContain(listDupGroupsSql(P));
  });
});

describe('forget() after migration v9 is unchanged (#316)', () => {
  async function v15WithIndexedRef(): Promise<{ db: SQLiteAdapter; wiki: WikiMemory }> {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, options);
    await wiki.setup();
    await db.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, tags, confidence, source_type,
         source_hash, source_ref, created_at, updated_at, access_count)
       VALUES ('r1', 'ent', 'T', 'B', '[]', 'certain', 'immutable_document', ?, 'r.md', 1, 1, 0)`,
      [H1],
    );
    await db.runAsync(
      `INSERT INTO ${P}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at)
       VALUES ('sri_test_r', 'ent', ?, 'r.md', 1, NULL)`,
      [H1],
    );
    return { db, wiki };
  }

  it('soft-deletes the source_ref_index row as before', async () => {
    const { db, wiki } = await v15WithIndexedRef();
    await expect(wiki.forget('ent', { sourceRef: 'r.md' })).resolves.toEqual({ deleted: { entries: 1, tasks: 0 } });
    const row = await db.getFirstAsync<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM ${P}source_ref_index WHERE id = 'sri_test_r'`);
    expect(row?.deleted_at).not.toBeNull();
  });

  it('boundary: schema_version 9 with source_ref_index missing refuses', async () => {
    const { db, wiki } = await v15WithIndexedRef();
    await db.runAsync(`DROP TABLE ${P}source_ref_index`);
    await db.runAsync(`UPDATE ${P}meta SET value = '9' WHERE key = 'schema_version'`);
    await expect(wiki.forget('ent', { sourceRef: 'r.md' })).rejects.toThrow(
      'forget(): source_ref_index is missing on a schema_version=9 database; run setup()',
    );
    expect(await liveIds(db)).toEqual(['r1']);
  });

  it.each([['unparseable', "'abc'"], ['missing', null]])(
    'boundary: %s schema_version counts as pre-v9 and skips the index',
    async (_label, value) => {
      const db = await dupFixture();
      if (value === null) await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'schema_version'`);
      else await db.runAsync(`UPDATE ${P}meta SET value = ${value} WHERE key = 'schema_version'`);
      const wiki = new WikiMemory(db, options);
      await expect(wiki.forget('ent', { sourceRef: 'b.md' })).resolves.toEqual({ deleted: { entries: 1, tasks: 0 } });
      expect(await liveIds(db)).toEqual(['a1', 'a2']);
    },
  );

  it('a v9+ store missing source_ref_index still refuses, with an actionable message, deleting nothing', async () => {
    const { db, wiki } = await v15WithIndexedRef();
    await db.runAsync(`DROP TABLE ${P}source_ref_index`);

    await expect(wiki.forget('ent', { sourceRef: 'r.md' })).rejects.toThrow(
      `forget(): source_ref_index is missing on a schema_version=${CURRENT_SCHEMA_VERSION} database; run setup()`,
    );
    expect(await liveIds(db)).toEqual(['r1']);
  });
});
