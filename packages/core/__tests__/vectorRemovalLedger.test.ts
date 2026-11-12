import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/WikiMemory';
import { VectorRemovalRepository } from '../src/repositories/VectorRemovalRepository';
import type { SQLiteAdapter } from '../src/types';

const llm = { generateText: async () => '{}' };

async function open(prefix = 'llm_wiki_') {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, {
    llmProvider: llm,
    ...(prefix === 'llm_wiki_' ? {} : { config: { tablePrefix: prefix } }),
  } as any);
  await wiki.setup();
  return db;
}

async function addEntry(db: SQLiteAdapter, id: string, entity = 'e1', p = 'llm_wiki_') {
  await db.runAsync(
    `INSERT INTO ${p}entries (id, entity_id, title, body, created_at, updated_at) VALUES (?, ?, 't', 'b', 1, 1)`,
    [id, entity],
  );
}
const rows = (db: SQLiteAdapter, p = 'llm_wiki_') =>
  db.getAllAsync<any>(`SELECT * FROM ${p}vector_removals ORDER BY seq`);

describe('vector_removals triggers', () => {
  it('a soft delete enqueues one row', async () => {
    const db = await open();
    await addEntry(db, 'a');
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 1 WHERE id = 'a'`);
    const r = await rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].attempts).toBe(0);
    expect(r[0].confirmed_at).toBeNull();
    expect(r[0].fact_id).toBe('a');
  });

  it('resurrection removes the unconfirmed row', async () => {
    const db = await open();
    await addEntry(db, 'a');
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 1 WHERE id = 'a'`);
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = NULL WHERE id = 'a'`);
    expect(await rows(db)).toHaveLength(0);
  });

  it('a soft delete and resurrection in one transaction leave no row', async () => {
    const db = await open();
    await addEntry(db, 'a');
    await db.withTransactionAsync(async (tx) => {
      await tx.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 1 WHERE id = 'a'`);
      await tx.runAsync(`UPDATE llm_wiki_entries SET deleted_at = NULL WHERE id = 'a'`);
    });
    expect(await rows(db)).toHaveLength(0);
  });

  it('a re-delete after confirmation re-enqueues with a new seq', async () => {
    const db = await open();
    await addEntry(db, 'a');
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 1 WHERE id = 'a'`);
    const first = (await rows(db))[0];
    await db.runAsync(`UPDATE llm_wiki_vector_removals SET confirmed_at = 5 WHERE seq = ?`, [first.seq]);
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = NULL WHERE id = 'a'`);
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 2 WHERE id = 'a'`);
    const r = await rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].confirmed_at).toBeNull();
    expect(r[0].seq).toBeGreaterThan(first.seq);
  });

  it('a bulk soft delete of 1000 facts enqueues 1000 rows in one statement', async () => {
    const db = await open();
    await db.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 1000; i++) await addEntry(tx, `f${i}`);
    });
    let calls = 0;
    const orig = db.runAsync.bind(db);
    db.runAsync = (async (...a: Parameters<typeof orig>) => {
      calls++;
      return orig(...a);
    }) as typeof db.runAsync;
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 1 WHERE entity_id = 'e1'`);
    expect(calls).toBe(1);
    expect(await rows(db)).toHaveLength(1000);
  });

  it('rows are scoped by entity', async () => {
    const db = await open();
    await addEntry(db, 'a', 'e1');
    await addEntry(db, 'b', 'e2');
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 1`);
    const r = await rows(db);
    expect(r.map((x) => [x.fact_id, x.entity_id]).sort()).toEqual([['a', 'e1'], ['b', 'e2']]);
  });

  it('vectorRemoval schema works under a custom prefix', async () => {
    const db = await open('x_');
    await addEntry(db, 'a', 'e1', 'x_');
    await db.runAsync(`UPDATE x_entries SET deleted_at = 1 WHERE id = 'a'`);
    expect(await rows(db, 'x_')).toHaveLength(1);
    const t = await db.getAllAsync<any>(`SELECT name FROM sqlite_master WHERE name LIKE 'llm_wiki_vector%'`);
    expect(t).toHaveLength(0);
  });

  it('a fresh setup creates the table, index and all three triggers; setup twice is idempotent', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: llm });
    await wiki.setup();
    await wiki.setup();
    const names = (await db.getAllAsync<any>(`SELECT name FROM sqlite_master WHERE name LIKE 'llm_wiki_vector_removals%'`))
      .map((r) => r.name).sort();
    expect(names).toEqual([
      'llm_wiki_vector_removals',
      'llm_wiki_vector_removals_enqueue',
      'llm_wiki_vector_removals_hard_delete',
      'llm_wiki_vector_removals_pending',
      'llm_wiki_vector_removals_resurrect',
    ]);
  });
});

describe('VectorRemovalRepository', () => {
  async function setup() {
    const db = await open();
    const repo = new VectorRemovalRepository(db, 'llm_wiki_');
    return { db, repo };
  }

  it('readPage orders by attempts, seq and reports fact_state', async () => {
    const { db, repo } = await setup();
    await addEntry(db, 'live');
    await addEntry(db, 'del');
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 1 WHERE id = 'del'`);
    // 'live' ledger row via backstop (entry still live), 'gone' has no entry
    await repo.backstopEnqueue('e1', ['live', 'gone'], 1000, db);
    const all = await rows(db);
    const seqOf = (id: string) => all.find((r) => r.fact_id === id).seq;
    await repo.bumpAttempts([seqOf('del')], 5, db);
    const max = await repo.maxSeq();
    const page = await repo.readPage({}, { maxSeq: max, attempts: -1, seq: 0 }, 10, db);
    expect(page.map((r) => r.fact_id)).toEqual(['live', 'gone', 'del']);
    expect(Object.fromEntries(page.map((r) => [r.fact_id, r.fact_state]))).toEqual({
      live: 'live', gone: 'gone', del: 'deleted',
    });
    const after = await repo.readPage({}, { maxSeq: max, attempts: 0, seq: seqOf('live') }, 10, db);
    expect(after.map((r) => r.fact_id)).toEqual(['gone', 'del']);
    const scoped = await repo.readPage({ ids: ['gone'] }, { maxSeq: max, attempts: -1, seq: 0 }, 10, db);
    expect(scoped.map((r) => r.fact_id)).toEqual(['gone']);
    const noEnt = await repo.readPage({ entityId: 'zzz' }, { maxSeq: max, attempts: -1, seq: 0 }, 10, db);
    expect(noEnt).toEqual([]);
  });

  it('backstopEnqueue skips ids that already have rows', async () => {
    const { db, repo } = await setup();
    await addEntry(db, 'a');
    await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 1 WHERE id = 'a'`);
    const before = (await rows(db))[0];
    const n = await repo.backstopEnqueue('e1', ['a', 'b'], 1000, db);
    expect(n).toBe(1);
    const r = await rows(db);
    expect(r.map((x) => x.fact_id).sort()).toEqual(['a', 'b']);
    expect(r.find((x) => x.fact_id === 'a').seq).toBe(before.seq);
  });

  it('confirm, bumpAttempts and deleteBySeq touch only the given seqs', async () => {
    const { db, repo } = await setup();
    await repo.backstopEnqueue('e1', ['a', 'b', 'c'], 1000, db);
    const [a, b, c] = await rows(db);
    await repo.confirm([a.seq], 77, db);
    await repo.bumpAttempts([b.seq], 88, db);
    await repo.deleteBySeq([c.seq], db);
    const r = await rows(db);
    expect(r).toHaveLength(2);
    expect(r[0].confirmed_at).toBe(77);
    expect(r[1].attempts).toBe(1);
    expect(r[1].last_attempt_at).toBe(88);
    expect(r[1].confirmed_at).toBeNull();
    expect(r[0].attempts).toBe(0);
    const st = await repo.statusFor(['a', 'b', 'zz']);
    expect(st.get('a')).toBe('confirmed');
    expect(st.get('b')).toBe('pending');
    expect(st.has('zz')).toBe(false);
  });

  it('stats, discard, entitiesWithPending and deleteForFacts', async () => {
    const { db, repo } = await setup();
    await repo.backstopEnqueue('e1', ['a', 'b'], 1000, db);
    await repo.backstopEnqueue('e2', ['c'], 2000, db);
    expect(await repo.entitiesWithPending()).toEqual(['e1', 'e2']);
    const s = await repo.pendingStats('e1');
    expect(s).toEqual({ count: 2, oldestEnqueuedAt: 1000, maxAttempts: 0 });
    await repo.deleteForFacts('e1', ['a'], db);
    expect((await repo.pendingStats('e1')).count).toBe(1);
    expect(await repo.discardPending('e1')).toBe(1);
    expect((await repo.pendingStats()).count).toBe(1);
    expect(await repo.discardPending()).toBe(1);
    expect(await repo.pendingStats()).toEqual({ count: 0, oldestEnqueuedAt: null, maxAttempts: 0 });
  });

  it('backstopEnqueue chunks large id lists', async () => {
    const { db, repo } = await setup();
    const ids = Array.from({ length: 1200 }, (_, i) => `i${i}`);
    expect(await repo.backstopEnqueue('e1', ids, 1, db)).toBe(1200);
  });
});
