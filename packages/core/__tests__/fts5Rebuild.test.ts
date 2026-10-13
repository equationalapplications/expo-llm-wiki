// packages/core/__tests__/fts5Rebuild.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { FTS5_STATE_KEY, FTS5_REBUILD_WM_KEY, fts5TriggerNames } from '../src/services/search/fts5Sql';
import { reanchorRebuildFingerprint } from '../src/services/search/fts5Progress';
import { WikiMemory } from '../src/WikiMemory';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;

beforeEach(async () => {
  db = openTestDatabase();
  await setupDatabase(db, P);
  meta = new MetadataRepository(db, P);
});

async function bulk(n: number, from = 0, entity = 'e1'): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = from; i < from + n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, 'b', '[]', 1, 1)`,
        [`r${i}`, entity, `cedar ${i}`]);
    }
  });
}
const state = () => meta.getMeta(FTS5_STATE_KEY);
const wm = async () => JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!) as { rowid: number; id: string | null };
const count = async (t: string) => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}${t}`))!.n;
const pending = () => count('fts_pending');

/** Exactly-once: one FTS row and one map row per live entry, none for anything else. */
async function expectExactlyOnce(): Promise<void> {
  const live = await db.getAllAsync<{ id: string; title: string }>(`SELECT id, title FROM ${P}entries WHERE deleted_at IS NULL ORDER BY id`);
  const fts = await db.getAllAsync<{ id: string; title: string }>(`SELECT id, title FROM ${P}entries_fts ORDER BY id`);
  expect(fts).toEqual(live);
  expect(await count('fts_map')).toBe(live.length);
  expect(await db.getAllAsync(`SELECT m.id FROM ${P}fts_map m LEFT JOIN ${P}entries_fts f ON f.rowid = m.fts_rowid WHERE f.rowid IS NULL`)).toEqual([]);
}

/** Pre-FTS store of n rows, armed into rebuilding. */
async function armed(n: number): Promise<Fts5IndexStrategy> {
  await bulk(n);
  const s = new Fts5IndexStrategy(db, P, meta);
  await s.init();
  expect(await state()).toBe('rebuilding');
  return s;
}
/** One quantum with an already-overrun deadline: at most one ledger chunk, else exactly one window. */
const step = (s: Fts5IndexStrategy) => s.drain({ mode: 'full', deadline: 0 });
async function converge(s: Fts5IndexStrategy, max = 200): Promise<void> {
  for (let i = 0; i < max && (await state()) !== 'live'; i++) await step(s);
  expect(await state()).toBe('live');
}

describe('rebuild windows (#280 B3)', () => {
  it('converges a pre-FTS store exactly once, one ≤500-row window per overrun quantum', async () => {
    const s = await armed(1200);
    await step(s);
    expect((await wm()).rowid).toBe(500);
    expect((await wm()).id).toBe('r499');
    await converge(s);
    await expectExactlyOnce();
    expect(await meta.getMeta(FTS5_REBUILD_WM_KEY)).toBeNull();
  });

  it('7(j) resume from watermark K on a new instance is exactly-once', async () => {
    let s = await armed(2000);
    await step(s); await step(s);
    expect((await wm()).rowid).toBe(1000);
    s = new Fts5IndexStrategy(db, P, meta); // simulated restart
    await s.init();
    expect((await wm()).rowid).toBe(1000);
    await converge(s);
    await expectExactlyOnce();
  });

  it('7(a) concurrent writers incl. drain-before-window: no duplicate, no stall', async () => {
    const s = await armed(1500);
    await step(s); // window 1: rowids 1..500
    await db.runAsync(`UPDATE ${P}entries SET title = 'zebra' WHERE id = 'r1200'`); // above the watermark
    await s.drain({ mode: 'ledger', entityId: 'e1', ids: ['r1200'] }); // drained BEFORE its window
    expect(await db.getFirstAsync(`SELECT title FROM ${P}entries_fts WHERE id = 'r1200'`)).toEqual({ title: 'zebra' });
    await db.runAsync(`UPDATE ${P}entries SET title = 'yak' WHERE id = 'r10'`); // below the watermark
    await db.runAsync(`UPDATE ${P}entries SET deleted_at = 5 WHERE id = 'r700'`);
    await bulk(30, 5000); // new rows above the snapshot: ledgered only
    await converge(s);
    await expectExactlyOnce();
    expect((await s.search('zebra', { entityIds: ['e1'], limit: 10 })).map((r) => r.id)).toEqual(['r1200']);
  });

  it('7(i) arbitration: ledger first; an overrun ledger drain skips windows; write turns never window', async () => {
    const s = await armed(1200);
    await bulk(600, 5000); // ledgered after the re-arm
    await s.drain({ mode: 'ledger', ids: ['r5000'] });
    expect(await wm()).toEqual({ rowid: 0, id: null }); // write turn: drain-only, never a window
    expect(await pending()).toBe(99); // 600 - 1 own - ONE foreign chunk of 500
    await step(s);
    expect(await pending()).toBe(0); // ledger first
    expect(await wm()).toEqual({ rowid: 0, id: null }); // that ledger chunk overran the deadline: no window
    await step(s);
    expect((await wm()).rowid).toBe(500); // ledger empty: one window
    await s.drain(); // generous deadline: the rest converges in one quantum
    expect(await state()).toBe('live');
    await expectExactlyOnce();
  });

  it('manual rowid change under the fingerprint restarts from 0', async () => {
    const s = await armed(1200);
    await step(s);
    const before = await wm();
    await db.runAsync(`UPDATE ${P}entries SET rowid = 99999 WHERE rowid = ?`, [before.rowid]);
    await step(s);
    expect(await wm()).toEqual({ rowid: 0, id: null });
    await converge(s);
    await expectExactlyOnce();
  });

  it('a hard delete of the fingerprint row re-anchors in-tx: no restart', async () => {
    const s = await armed(1200);
    await step(s);
    expect(await wm()).toEqual({ rowid: 500, id: 'r499' });
    await db.withTransactionAsync(async (tx) => {
      await tx.runAsync(`DELETE FROM ${P}entries WHERE id IN ('r498', 'r499')`);
      await reanchorRebuildFingerprint(tx, P, ['r498', 'r499']);
    });
    expect(await wm()).toEqual({ rowid: 498, id: 'r497' });
    await step(s); // drains the two delete-trigger ledger rows; that overran, so no window
    expect(await wm()).toEqual({ rowid: 498, id: 'r497' }); // fingerprint valid: not restarted
    await step(s);
    expect((await wm()).rowid).toBeGreaterThan(498); // advanced from the re-anchored watermark
    await converge(s);
    await expectExactlyOnce();
  });

  it('re-anchor ignores deletes that do not include the fingerprint id', async () => {
    const s = await armed(1200);
    await step(s);
    await db.withTransactionAsync(async (tx) => {
      await tx.runAsync(`DELETE FROM ${P}entries WHERE id = 'r10'`);
      await reanchorRebuildFingerprint(tx, P, ['r10']);
    });
    expect(await wm()).toEqual({ rowid: 500, id: 'r499' });
  });

  it("7(g') orphans: with triggers down, a hard-deleted row and a renamed row are swept; neither is searchable", async () => {
    await bulk(40);
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await converge(s);
    for (const t of fts5TriggerNames(P)) await db.execAsync(`DROP TRIGGER ${t}`);
    await db.runAsync(`DELETE FROM ${P}entries WHERE id = 'r5'`);
    await db.runAsync(`UPDATE ${P}entries SET id = 'renamed', title = 'moved' WHERE id = 'r6'`);
    await s.init(); // trigger loss: keep-map re-arm
    expect(await state()).toBe('rebuilding');
    await converge(s);
    await expectExactlyOnce();
    expect(await s.search('cedar 5', { entityIds: ['e1'], limit: 50 }).then((r) => r.map((x) => x.id))).not.toContain('r5');
    expect(await db.getFirstAsync(`SELECT 1 AS x FROM ${P}fts_map WHERE id IN ('r5', 'r6')`)).toBeNull();
  });

  it('the flip still happens under a steady trickle of writes', async () => {
    const s = await armed(1200);
    for (let i = 0; i < 40 && (await state()) !== 'live'; i++) {
      await bulk(10, 10_000 + i * 10);
      await s.drain({ mode: 'full' });
    }
    expect(await state()).toBe('live');
    await s.drain();
    await expectExactlyOnce();
  });

  it('trailing hard deletes cannot strand the watermark below the snapshot (F9)', async () => {
    const s = await armed(1000);
    await db.runAsync(`DELETE FROM ${P}entries WHERE rowid > 990`);
    await converge(s);
    await expectExactlyOnce();
  });

  it('state gate: a live store never reads the watermark', async () => {
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init({ entriesExisted: false });
    await bulk(10);
    const spy = vi.spyOn(meta, 'getMeta');
    await s.drain();
    expect(spy.mock.calls.map((c) => c[0])).not.toContain(FTS5_REBUILD_WM_KEY);
  });
});


describe('runPrune re-anchors the fingerprint (#280 B3)', () => {
  it('prune hard-deletes the fingerprint row: re-anchored, no restart, converges exactly once', async () => {
    const wdb = openTestDatabase();
    const stub = { llmProvider: { generateText: async () => '{}' }, config: { indexStrategy: 'fts5' as const } };
    await new WikiMemory(wdb, stub).setup();
    await wdb.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 1200; i++) {
        await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
      }
    });
    await wdb.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`); // marker loss
    const wiki = new WikiMemory(wdb, { ...stub, config: { indexStrategy: 'fts5' as const, setupBudgetMs: 1 } });
    await wiki.setup(); // re-arm + one window
    const wmeta = new MetadataRepository(wdb, P);
    const before = JSON.parse((await wmeta.getMeta(FTS5_REBUILD_WM_KEY))!);
    await wdb.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = ?`, [before.id]);
    await wiki.runPrune('e1', { retainSoftDeletedFor: 0, retainEventsFor: null });
    const after = JSON.parse((await wmeta.getMeta(FTS5_REBUILD_WM_KEY))!);
    expect(after.rowid).toBeLessThan(before.rowid);
    expect(after.rowid).toBeGreaterThan(0);
    for (let i = 0; i < 50 && (await wmeta.getMeta('fts5_index_state')) !== 'live'; i++) await wiki.syncSearchIndex();
    expect(await wmeta.getMeta('fts5_index_state')).toBe('live');
    expect((await wdb.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}entries_fts`))!.n).toBe(1199);
  });
});
