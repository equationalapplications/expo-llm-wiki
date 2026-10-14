// packages/core/__tests__/idThreading.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { UnavailableIndexStrategy } from '../src/services/search/UnavailableIndexStrategy';

const P = 'llm_wiki_';
const HASH = (b: number) => 'a'.repeat(56) + b.toString(16).padStart(8, '0');
const stub = { llmProvider: { generateText: async () => '{"facts":[]}' } };
const CAP = WikiMemory.UPSERT_ID_STASH_CAP;
afterEach(() => { (WikiMemory as unknown as { UPSERT_ID_STASH_CAP: number }).UPSERT_ID_STASH_CAP = CAP; });

async function open(db: SQLiteAdapter, budget?: number): Promise<WikiMemory> {
  const w = new WikiMemory(db, { ...stub, config: { indexStrategy: 'fts5', ...(budget ? { setupBudgetMs: budget } : {}) } });
  await w.setup();
  return w;
}
async function rawBacklog(db: SQLiteAdapter, entity: string, n: number): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, 'filler', 'b', '[]', 1, 1)`, [`${entity}_bk_${i}`, entity]);
    }
  });
}
async function upsert(wiki: WikiMemory, db: SQLiteAdapter, entity: string, n: number): Promise<string[]> {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `${entity}_node_${i}`, type: '', title: `juniper ${i}`, body: 'x' }));
  await db.withTransactionAsync((tx) => wiki.upsertGraph(entity, { sourceRef: 'g.ts', sourceHash: HASH(1), nodes, edges: [] }, tx));
  return nodes.map((n) => n.id);
}
const hits = async (wiki: WikiMemory, entity: string, q: string) =>
  (await wiki.__testAccess.searchService.searchKeyword(q, [entity], 100_000)).map((r) => r.id);

describe('7(r) upsertGraph then search under a 5k backlog (#280 B5)', () => {
  it('syncSearchIndex(entityId): the new nodes are searchable even when the backlog is the same entity', async () => {
    const db = openTestDatabase();
    const wiki = await open(db);
    await rawBacklog(db, 'e1', 5000);
    const ids = await upsert(wiki, db, 'e1', 20);
    await wiki.syncSearchIndex('e1');
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...ids].sort());
  });

  it('no-arg syncSearchIndex(): stashed ids drain first, across entities, then the quantum', async () => {
    const db = openTestDatabase();
    const wiki = await open(db, 1);
    await rawBacklog(db, 'e1', 5000);
    const a = await upsert(wiki, db, 'e1', 20);
    const b = await upsert(wiki, db, 'e2', 5);
    await wiki.syncSearchIndex();
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...a].sort());
    expect((await hits(wiki, 'e2', 'juniper')).sort()).toEqual([...b].sort());
    expect((wiki as unknown as { upsertIdStash: Map<string, Map<string, number>> }).upsertIdStash.size).toBe(0);
  });

  it('the stash is capped: overflow falls back to the entity-targeted drain and does not grow', async () => {
    (WikiMemory as unknown as { UPSERT_ID_STASH_CAP: number }).UPSERT_ID_STASH_CAP = 5;
    const db = openTestDatabase();
    const wiki = await open(db);
    await upsert(wiki, db, 'e1', 20);
    const stash = (wiki as unknown as { upsertIdStash: Map<string, Map<string, number>> }).upsertIdStash;
    expect([...stash.values()].reduce((n, s) => n + s.size, 0)).toBeLessThanOrEqual(5);
    await wiki.syncSearchIndex('e1');
    expect((await hits(wiki, 'e1', 'juniper')).length).toBe(20); // 5 own ids + one ≤500-row foreign chunk; no other backlog
  });

  it('MiniSearch hosts still rebuild via markStale (F5)', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { ...stub, config: { indexStrategy: 'minisearch' } });
    await wiki.setup();
    const ids = await upsert(wiki, db, 'e1', 3);
    await wiki.syncSearchIndex('e1');
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...ids].sort());
    expect((wiki as unknown as { upsertIdStash: Map<string, Map<string, number>> }).upsertIdStash.size).toBe(0);
  });

  it.each([['e1'], [undefined]])('a failed drain keeps the stashed ids for the next syncSearchIndex(%s)', async (target) => {
    const db = openTestDatabase();
    const wiki = await open(db);
    const ids = await upsert(wiki, db, 'e1', 20);
    const internals = wiki as unknown as { upsertIdStash: Map<string, Map<string, number>>; upsertIdStashSize: number };
    const strategy = (wiki.__testAccess.searchService as unknown as { indexStrategy: { drain: () => Promise<void> } }).indexStrategy;
    const drain = strategy.drain;
    strategy.drain = async () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await wiki.syncSearchIndex(target);
    } finally {
      strategy.drain = drain;
      warn.mockRestore();
    }
    expect(internals.upsertIdStash.get('e1')?.size).toBe(20);
    expect(internals.upsertIdStashSize).toBe(20);

    await wiki.syncSearchIndex(target);
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...ids].sort());
    expect(internals.upsertIdStash.size).toBe(0);
    expect(internals.upsertIdStashSize).toBe(0);
  });
});

describe('stash generations (#284 review)', () => {
  it('an id re-stashed while its drain is in flight survives that drain and is indexed next call', async () => {
    const db = openTestDatabase();
    const wiki = await open(db);
    await upsert(wiki, db, 'e1', 3);
    await rawBacklog(db, 'e2', 5000); // a foreign backlog the follow-up chunk cannot clear
    const strategy = (wiki.__testAccess.searchService as unknown as { indexStrategy: { drain: (o?: unknown) => Promise<void> } }).indexStrategy;
    const drain = strategy.drain.bind(strategy);
    let reupserted = false;
    strategy.drain = async (o) => {
      await drain(o);
      if (reupserted) return;
      reupserted = true;
      // The update commits after the drain ran but before syncSearchIndex drops its snapshot.
      await db.withTransactionAsync((tx) => wiki.upsertGraph('e1', {
        sourceRef: 'g.ts', sourceHash: HASH(2), nodes: [{ id: 'e1_node_0', type: '', title: 'cedar', body: 'x' }], edges: [],
      }, tx));
    };
    try {
      await wiki.syncSearchIndex('e1');
    } finally {
      strategy.drain = drain;
    }
    const internals = wiki as unknown as { upsertIdStash: Map<string, Map<string, number>>; upsertIdStashSize: number };
    // The re-upsert stashed its node and the two facts it superseded, all after the peek.
    expect([...(internals.upsertIdStash.get('e1')?.keys() ?? [])].sort()).toEqual(['e1_node_0', 'e1_node_1', 'e1_node_2']);
    expect(internals.upsertIdStashSize).toBe(3);

    await wiki.syncSearchIndex('e1');
    expect(await hits(wiki, 'e1', 'cedar')).toEqual(['e1_node_0']);
    expect(await hits(wiki, 'e1', 'juniper')).toEqual([]);
    expect(internals.upsertIdStashSize).toBe(0);
  });
});

describe('upsertGraph review fixes (#284)', () => {
  it.each([['e1'], [undefined]])('facts superseded by upsertGraph leave the index under a foreign backlog (syncSearchIndex(%s))', async (target) => {
    const db = openTestDatabase();
    const wiki = await open(db, 1);
    const old = await upsert(wiki, db, 'e1', 20);
    await wiki.syncSearchIndex('e1');
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...old].sort());
    await rawBacklog(db, 'e2', 5000);
    // Same sourceRef, new hash: supersedes every juniper node.
    await db.withTransactionAsync((tx) => wiki.upsertGraph('e1', {
      sourceRef: 'g.ts', sourceHash: HASH(2), nodes: [{ id: 'e1_cedar', type: '', title: 'cedar', body: 'x' }], edges: [],
    }, tx));
    await wiki.syncSearchIndex(target);
    expect(await hits(wiki, 'e1', 'juniper')).toEqual([]);
    expect(await hits(wiki, 'e1', 'cedar')).toEqual(['e1_cedar']);
  });

  it('upsertGraph keeps its public return shape', async () => {
    const db = openTestDatabase();
    const wiki = await open(db);
    await upsert(wiki, db, 'e1', 2);
    const result = await db.withTransactionAsync((tx) => wiki.upsertGraph('e1', {
      sourceRef: 'g.ts', sourceHash: HASH(2), nodes: [{ id: 'e1_cedar', type: '', title: 'cedar', body: 'x' }], edges: [],
    }, tx));
    expect(Object.keys(result).sort()).toEqual(['edgesWritten', 'nodesWritten', 'superseded']);
  });

  it('while keyword search is unavailable the stash is kept, and drains after the re-init', async () => {
    const db = openTestDatabase();
    const wiki = await open(db);
    const service = wiki.__testAccess.searchService as unknown as { indexStrategy: unknown; setIndexStrategy: (s: unknown) => void };
    service.setIndexStrategy(new UnavailableIndexStrategy(new Error('outage')));
    const ids = await upsert(wiki, db, 'e1', 20);
    await wiki.syncSearchIndex('e1');
    const internals = wiki as unknown as { upsertIdStashSize: number };
    expect(internals.upsertIdStashSize).toBe(20);

    await wiki.syncSearchIndex(); // re-init succeeds, then the stash drains
    expect(service.indexStrategy).toBeInstanceOf(Fts5IndexStrategy);
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...ids].sort());
    expect(internals.upsertIdStashSize).toBe(0);
  });

  it('a successful re-init runs one budgeted quantum, not two', async () => {
    const db = openTestDatabase();
    const wiki = await open(db);
    const service = wiki.__testAccess.searchService;
    service.setIndexStrategy(new UnavailableIndexStrategy(new Error('outage')));
    const sync = vi.spyOn(service, 'sync');
    const syncStale = vi.spyOn(service, 'syncStale');
    await wiki.syncSearchIndex();
    expect(service.isKeywordAvailable()).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    expect(syncStale).toHaveBeenCalledTimes(1);
  });
});

describe("7(m') importDump(merge=false) under a 5k foreign backlog (#280 B5)", () => {
  it('every imported fact is searchable when the call returns', async () => {
    const src = openTestDatabase();
    const source = await open(src);
    await src.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 2000; i++) {
        await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`f${i}`, `walnut ${i}`]);
      }
    });
    const dump = await source.exportDump(['e1']);
    const db = openTestDatabase();
    const wiki = await open(db);
    await rawBacklog(db, 'e2', 5000);
    await wiki.importDump(dump, { merge: false });
    expect((await hits(wiki, 'e1', 'walnut')).length).toBe(2000);
  });
});
