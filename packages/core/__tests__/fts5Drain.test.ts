// packages/core/__tests__/fts5Drain.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import {
  fts5TablesDdl, fts5PendingIndexesDdl, idDrainChunkSql, entityDrainChunkSql, entityDrainHiSql,
} from '../src/services/search/fts5Sql';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;

beforeEach(async () => {
  db = openTestDatabase();
  await setupDatabase(db, P);
  meta = new MetadataRepository(db, P);
});

async function bulk(entity: string, n: number, idPrefix = entity): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(
        `INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, 'b', '[]', 1, 1)`,
        [`${idPrefix}_${i}`, entity, `filler ${i}`]);
    }
  });
}
const pending = async () => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_pending`))!.n;
const indexed = async (id: string) => (await db.getFirstAsync(`SELECT 1 AS x FROM ${P}fts_map WHERE id = ?`, [id])) !== null;

/** A live, empty FTS5 store (B2 makes this `init({ entriesExisted: false })`). */
async function liveStrategy(budgetMs?: number): Promise<Fts5IndexStrategy> {
  const s = new Fts5IndexStrategy(db, P, meta, budgetMs);
  await s.init({ entriesExisted: false });
  return s;
}

describe('fts5 drain SQL (#280 B1)', () => {
  it('prepares against the schema and the index DDL is idempotent', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE p_entries (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER)`);
    raw.exec(fts5TablesDdl('p_'));
    for (const s of [...idDrainChunkSql('p_'), ...entityDrainChunkSql('p_'), entityDrainHiSql('p_')]) {
      expect(() => raw.prepare(s)).not.toThrow();
    }
    raw.exec(fts5PendingIndexesDdl('p_'));
    raw.exec(fts5PendingIndexesDdl('p_'));
    const idx = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'p_fts_pending' ORDER BY name`).all() as { name: string }[];
    expect(idx.map((r) => r.name)).toEqual(['p_fts_pending_entity', 'p_fts_pending_id']);
  });
});

describe('Fts5IndexStrategy.drain modes (#280 B1)', () => {
  it('7(m) ledger mode: own ids drain to completion under a 5k foreign backlog, plus exactly one foreign chunk', async () => {
    const s = await liveStrategy();
    await bulk('e2', 5000);
    await bulk('e1', 1200, 'mine');
    const mine = Array.from({ length: 1200 }, (_, i) => `mine_${i}`);
    await s.drain({ mode: 'ledger', entityId: 'e1', ids: mine });
    for (const id of ['mine_0', 'mine_599', 'mine_1199']) expect(await indexed(id)).toBe(true);
    expect(await pending()).toBe(4500); // own 1200 to completion + ONE seq-ordered foreign chunk of 500
    expect((await s.search('filler', { entityIds: ['e1'], limit: 5000 })).length).toBe(1200);
  });

  it('ledger mode, entity target, no ids: one entity-targeted chunk (counts as the foreign chunk)', async () => {
    const s = await liveStrategy();
    await bulk('e2', 1000);
    await bulk('e1', 700);
    await s.drain({ mode: 'ledger', entityId: 'e1' });
    const left = await db.getAllAsync<{ entity_id: string; n: number }>(
      `SELECT entity_id, count(*) AS n FROM ${P}fts_pending GROUP BY entity_id ORDER BY entity_id`);
    expect(left).toEqual([{ entity_id: 'e1', n: 200 }, { entity_id: 'e2', n: 1000 }]);
  });

  it('full mode (the default) with room in the budget drains the whole ledger', async () => {
    const s = await liveStrategy();
    await bulk('e1', 1203);
    await s.drain();
    expect(await pending()).toBe(0);
  });

  it('full mode checks the deadline between chunks: an overrun deadline runs exactly one chunk, and calls converge', async () => {
    const s = await liveStrategy();
    await bulk('e1', 2600);
    await s.drain({ mode: 'full', deadline: 0 });
    expect(await pending()).toBe(2100);
    for (let i = 0; i < 10 && (await pending()) > 0; i++) await s.drain({ mode: 'full', deadline: 0 });
    expect(await pending()).toBe(0);
  });

  it('full mode drains the caller ids to completion even past the deadline; only the backlog is bounded', async () => {
    const s = await liveStrategy();
    await bulk('e2', 2000);
    await bulk('e1', 1200, 'mine');
    const mine = Array.from({ length: 1200 }, (_, i) => `mine_${i}`);
    await s.drain({ mode: 'full', deadline: 0, ids: mine });
    for (const id of ['mine_0', 'mine_599', 'mine_1199']) expect(await indexed(id)).toBe(true);
    expect(await pending()).toBe(1500); // own 1200 to completion + ONE overrun foreign chunk of 500
  });

  it('ids with no ledger row (already drained, or never written) are a no-op', async () => {
    const s = await liveStrategy();
    await bulk('e1', 3);
    await s.drain();
    await expect(s.drain({ mode: 'ledger', ids: ['e1_0', 'nope'] })).resolves.toBeUndefined();
    expect(await indexed('e1_0')).toBe(true);
  });
});
