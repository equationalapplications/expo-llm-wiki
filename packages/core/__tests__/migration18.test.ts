import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions } from '../src/types';

const stubOptions: WikiOptions = { llmProvider: { generateText: async () => '{}' } };
const P = 'llm_wiki_';
const IDX = `${P}entries_deleted_idx`;

async function version(db: SQLiteAdapter): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = 'schema_version'`);
  return row?.value ?? null;
}
async function indexSql(db: SQLiteAdapter): Promise<string | null> {
  const row = await db.getFirstAsync<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, [IDX]);
  return row?.sql ?? null;
}
async function fresh(): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await new WikiMemory(db, stubOptions).setup();
  return db;
}
async function rollBackTo17(db: SQLiteAdapter): Promise<void> {
  await db.execAsync(`DROP INDEX ${IDX}`);
  await db.runAsync(`UPDATE ${P}meta SET value = '17' WHERE key = 'schema_version'`);
}

describe('migration v18: partial index on entries(entity_id, deleted_at)', () => {
  it('is registered and a fresh store has the index and the stamp', async () => {
    expect(MIGRATIONS.some((m) => m.version === 18)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
    const db = await fresh();
    expect(await version(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    const sql = await indexSql(db);
    expect(sql).toContain('(entity_id, deleted_at)');
    expect(sql).toContain('WHERE deleted_at IS NOT NULL');
  });

  it('upgrades a v17 store, then a second setup() is a no-op', async () => {
    const db = await fresh();
    await rollBackTo17(db);
    await new WikiMemory(db, stubOptions).setup();
    expect(await indexSql(db)).not.toBeNull();
    expect(await version(db)).toBe(String(CURRENT_SCHEMA_VERSION));
    await expect(new WikiMemory(db, stubOptions).setup()).resolves.toBeUndefined();
  });

  it("'refuse' on a v17 store throws without building the index; 'allow' builds it", async () => {
    const db = await fresh();
    await rollBackTo17(db);
    await expect(new WikiMemory(db, stubOptions).setup({ migrations: 'refuse' })).rejects.toMatchObject({
      name: 'WikiMigrationRequiredError',
    });
    expect(await indexSql(db)).toBeNull();
    expect(await version(db)).toBe('17');
    await new WikiMemory(db, stubOptions).setup({ migrations: 'allow' });
    expect(await indexSql(db)).not.toBeNull();
  });
});

describe('prune queries use entries_deleted_idx', () => {
  type Call = { sql: string; args: unknown[] };
  function recording(db: SQLiteAdapter): { adapter: SQLiteAdapter; calls: Call[] } {
    const calls: Call[] = [];
    const rec = (sql: string, args: unknown[] = []) => {
      if (/SELECT|DELETE/.test(sql) && sql.includes('deleted_at')) calls.push({ sql, args });
    };
    const adapter: SQLiteAdapter = {
      ...db,
      execAsync: async (sql) => { rec(sql); return db.execAsync(sql); },
      runAsync: async (sql, args = []) => { rec(sql, args); return db.runAsync(sql, args); },
      getAllAsync: async (sql, args = []) => { rec(sql, args); return db.getAllAsync(sql, args); },
      getFirstAsync: async (sql, args = []) => { rec(sql, args); return db.getFirstAsync(sql, args); },
      withTransactionAsync: (fn) => db.withTransactionAsync((tx) => fn(tx)),
    };
    return { adapter, calls };
  }
  async function plan(db: SQLiteAdapter, call: Call): Promise<string> {
    const rows = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${call.sql}`, call.args);
    return rows.map((r) => r.detail).join(' | ');
  }
  async function populated() {
    const db = await fresh();
    const now = Date.now();
    await db.execAsync('BEGIN');
    for (let i = 0; i < 4000; i++) {
      await db.runAsync(
        `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?)`,
        [`id${i}`, i % 2 ? 'e1' : 'e2', 't', 'b', now, now, i % 1000 === 1 ? now - 5000 : null],
      );
    }
    await db.execAsync('COMMIT');
    await db.execAsync('ANALYZE');
    const { adapter, calls } = recording(db);
    const outbox = new OutboxRepository(adapter, P, false);
    return { db, adapter, now, calls, entries: new EntryRepository(adapter, P, outbox), meta: new MetadataRepository(adapter, P) };
  }

  it('getPrunableMetadata (cutoff and noCutoff) searches the partial index', async () => {
    const r = await populated();
    await r.entries.getPrunableMetadata('e1', r.now);
    await r.entries.getPrunableMetadata('e1', r.now, undefined, { noCutoff: true });
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) expect(await plan(r.db, c)).toContain(`USING INDEX ${IDX}`);
  });

  it('bulkDeletePruned chunk still resolves through an index and removes the rows', async () => {
    const r = await populated();
    const ids = ['id1', 'id1001', 'id2001', 'id3001'];
    await r.entries.bulkDeletePruned('e1', r.now, ids, r.adapter);
    const del = r.calls.find((c) => c.sql.startsWith('DELETE'))!;
    expect(await plan(r.db, del)).toMatch(new RegExp(`USING INDEX (${IDX}|sqlite_autoindex_${P}entries_1)`));
    expect((await r.db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries WHERE deleted_at IS NOT NULL`))!.n).toBe(0);
  });

  it('getDistinctEntityIds (both forms) scans the covering partial index, not the table', async () => {
    const r = await populated();
    await r.meta.getDistinctEntityIds(undefined, { softDeletedAll: true });
    await r.meta.getDistinctEntityIds(undefined, { softDeletedAtOrBefore: r.now });
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      const d = await plan(r.db, c);
      expect(d).toContain(IDX);
      expect(d).not.toMatch(new RegExp(`SCAN ${P}entries(?! USING)`));
    }
  });
});

describe('export/import across v17 and v18 stores', () => {
  it('a fact survives an export from a v17-stamped store into a fresh v18 store', async () => {
    const a = await fresh();
    await rollBackTo17(a);
    await a.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES ('f1','e1','T','B',1,1)`,
    );
    const src = new WikiMemory(a, stubOptions);
    const bundle = await src.exportDump(['e1']);
    const b = await fresh();
    const dst = new WikiMemory(b, stubOptions);
    await dst.importDump(bundle);
    const row = await b.getFirstAsync<{ title: string; body: string }>(`SELECT title, body FROM ${P}entries WHERE id = 'f1'`);
    expect(row).toEqual({ title: 'T', body: 'B' });
  });
});
