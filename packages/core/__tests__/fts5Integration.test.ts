// packages/core/__tests__/fts5Integration.test.ts
import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const HASH = (b: number) => 'a'.repeat(56) + b.toString(16).padStart(8, '0');
const llm = { llmProvider: { generateText: async () => '{"facts":[]}' } };

async function open(db: SQLiteAdapter, indexStrategy: 'fts5' | 'minisearch' | 'auto') {
  const wiki = new WikiMemory(db, { ...llm, config: { indexStrategy } });
  await wiki.setup();
  return wiki;
}
async function upsert(wiki: WikiMemory, db: SQLiteAdapter, entity: string, batch: number, n = 10) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${batch}_${i}`, type: '', title: `cedar node ${batch} ${i}`, body: `body juniper ${batch}`,
  }));
  await db.withTransactionAsync((tx) => wiki.upsertGraph(entity, { sourceRef: `s${batch}.ts`, sourceHash: HASH(batch), nodes, edges: [] }, tx));
}
const hits = async (wiki: WikiMemory, q: string) =>
  (await wiki.__testAccess.searchService.searchKeyword(q, ['e1'], 100_000)).map((r) => r.id).sort();
const pending = async (db: SQLiteAdapter) => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_pending`))!.n;

describe('FTS5 end to end', () => {
  it('build is linear: each syncSearchIndex drains only that batch and never reads full entities', async () => {
    const db = openTestDatabase();
    const wiki = await open(db, 'fts5');
    const repo = wiki.__testAccess.entryRepo;
    const full = vi.spyOn(repo, 'findMiniSearchRows');
    const byIds = vi.spyOn(repo, 'findMiniSearchRowsByIds');
    for (let b = 0; b < 20; b++) {
      await upsert(wiki, db, 'e1', b);
      const queued = await pending(db);
      expect(queued).toBeGreaterThan(0);
      expect(queued).toBeLessThanOrEqual(40); // this batch's rows only, independent of b
      await wiki.syncSearchIndex('e1');
      expect(await pending(db)).toBe(0);
    }
    expect(full).not.toHaveBeenCalled();
    expect(byIds).not.toHaveBeenCalled();
    expect((await hits(wiki, 'cedar')).length).toBe(200);
  });

  it('crash between commit and drain: reopen catches up, soft-deletes disappear', async () => {
    const db = openTestDatabase();
    const w1 = await open(db, 'fts5');
    await upsert(w1, db, 'e1', 0);
    await w1.syncSearchIndex('e1');
    await upsert(w1, db, 'e1', 1); // committed, never drained
    await db.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = (SELECT id FROM ${P}entries WHERE title = 'cedar node 0 0')`);
    const w2 = await open(db, 'fts5'); // simulated restart on the same file
    const ids = await hits(w2, 'cedar');
    expect(ids.length).toBe(19);
    expect(await pending(db)).toBe(0);
  });

  it('host rollback leaves no ledger rows and no index rows', async () => {
    const db = openTestDatabase();
    const wiki = await open(db, 'fts5');
    await expect(db.withTransactionAsync(async (tx) => {
      await wiki.upsertGraph('e1', { sourceRef: 'r.ts', sourceHash: HASH(0), nodes: [{ id: 'r', type: '', title: 'cedar' }], edges: [] }, tx);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await pending(db)).toBe(0);
    await wiki.syncSearchIndex('e1');
    expect(await hits(wiki, 'cedar')).toEqual([]);
  });

  it('state changes: fts5 -> minisearch -> auto keep search correct', async () => {
    const db = openTestDatabase();
    const a = await open(db, 'fts5');
    await upsert(a, db, 'e1', 0);
    await a.syncSearchIndex('e1');
    const b = await open(db, 'minisearch');
    await upsert(b, db, 'e1', 1);
    await b.syncSearchIndex('e1');
    expect((await hits(b, 'cedar')).length).toBe(20);
    const c = await open(db, 'auto');
    expect((await hits(c, 'cedar')).length).toBe(20); // rebuilt on re-attach, including batch 1
  });

  it('read() keyword fallback returns FTS5 hits', async () => {
    const db = openTestDatabase();
    const wiki = await open(db, 'fts5');
    await upsert(wiki, db, 'e1', 0, 3);
    await wiki.syncSearchIndex('e1');
    const bundle = await wiki.read('e1', 'cedar'); // MemoryBundle
    expect(JSON.stringify(bundle)).toContain('cedar node 0 0');
  });
});
