import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory, WikiExternalDeletionError } from '../src/index';

// Spec durable-vector-removal revision 5 (§8 tests 33-41).

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };
type Call = { entityId: string; factId: string; vector: unknown };

const open = (raw: any, hook?: (c: Call) => any, extra: any = {}) => {
  const calls: Call[] = [];
  const diags: any[] = [];
  const wiki = new WikiMemory(raw, {
    llmProvider: llm,
    onDiagnostic: (d: any) => diags.push(d),
    ...(hook
      ? { vectorRanker: { rankBySimilarity: async () => [], onEmbeddingPersisted: async (c: Call) => { calls.push(c); await hook(c); } } }
      : {}),
    ...extra,
  } as any);
  return { wiki, calls, diags };
};
const ins = (raw: any, id: string, entity = 'e1') =>
  raw.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES (?, ?, 't', 'b', 1, 1)`, [id, entity]);
const softDel = (raw: any, id: string) => raw.runAsync(`UPDATE ${P}entries SET deleted_at = 2 WHERE id = ?`, [id]);
const hardDel = (raw: any, id: string) => raw.runAsync(`DELETE FROM ${P}entries WHERE id = ?`, [id]);
const ledger = (raw: any) =>
  raw.getAllAsync(`SELECT fact_id, confirmed_at FROM ${P}vector_removals ORDER BY fact_id`) as Promise<any[]>;
async function markedStore() {
  const raw = openTestDatabase();
  await open(raw, () => {}).wiki.setup();
  return raw;
}
async function unmarkedStore() {
  const raw = openTestDatabase();
  await open(raw).wiki.setup();
  return raw;
}

describe('revision 5', () => {
  it('33: a re-delete through INSERT … ON CONFLICT DO UPDATE after a confirm and a restore succeeds', async () => {
    const raw = await markedStore();
    const t = open(raw, () => {});
    await t.wiki.setup();
    await ins(raw, 'a');
    await softDel(raw, 'a');
    await t.wiki.runExternalDeletions('e1');
    await raw.runAsync(`UPDATE ${P}entries SET deleted_at = NULL WHERE id = 'a'`);
    await raw.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES ('a', 'e1', 't', 'b', 1, 1)
       ON CONFLICT(id) DO UPDATE SET deleted_at = 9`,
    );
    const rows = await ledger(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed_at).toBeNull();
  });

  it('33b: importDump with a tombstone over a restored fact succeeds', async () => {
    const raw = await markedStore();
    const t = open(raw, () => {});
    await t.wiki.setup();
    const f = await t.wiki.remember('e1', { title: 'a', body: 'b' });
    const live = await t.wiki.exportDump(['e1']);
    await t.wiki.forget('e1', { entryId: f.id });
    await t.wiki.importDump(live);
    const tomb = JSON.parse(JSON.stringify(live));
    tomb.entities.e1.facts[0].deleted_at = Date.now();
    tomb.entities.e1.facts[0].updated_at = Date.now(); // newer, so merge applies it
    const before = t.calls.length;
    await expect(t.wiki.importDump(tomb, { merge: true })).resolves.toBeUndefined();
    // The tombstone is owed again and delivered by the import itself.
    expect(t.calls.slice(before).filter((c) => c.factId === f.id).map((c) => c.vector)).toEqual([null]);
  });

  it('34: hard-deleting a live fact is owed on a marked store and delivered', async () => {
    const raw = await markedStore();
    const t = open(raw, () => {});
    await t.wiki.setup();
    await ins(raw, 'a');
    await hardDel(raw, 'a');
    expect((await ledger(raw)).map((r) => r.fact_id)).toEqual(['a']);
    await t.wiki.runExternalDeletions('e1');
    expect(t.calls.map((c) => [c.factId, c.vector])).toEqual([['a', null]]);
    expect(await ledger(raw)).toEqual([]);
  });

  it('34b: hard-deleting a live fact on a store without the marker leaves no row', async () => {
    const raw = await unmarkedStore();
    await ins(raw, 'a');
    await hardDel(raw, 'a');
    expect(await ledger(raw)).toEqual([]);
  });

  it('35: hard-deleting a soft-deleted fact drops what nothing can owe', async () => {
    const raw = await markedStore();
    const t = open(raw, (c) => { if (c.factId === 'pend') throw new Error('nope'); });
    await t.wiki.setup();
    for (const id of ['conf', 'pend']) { await ins(raw, id); await softDel(raw, id); }
    await t.wiki.runExternalDeletions('e1');
    await hardDel(raw, 'conf');
    await hardDel(raw, 'pend');
    expect((await ledger(raw)).map((r) => r.fact_id)).toEqual(['pend']);

    const u = await unmarkedStore();
    await ins(u, 'x');
    await softDel(u, 'x');
    expect(await ledger(u)).toHaveLength(1);
    await hardDel(u, 'x');
    expect(await ledger(u)).toEqual([]);
  });

  it('36: a confirm whose fact was hard-deleted during the call leaves no row', async () => {
    const raw = await markedStore();
    const t = open(raw, async (c) => { await hardDel(raw, c.factId); });
    await t.wiki.setup();
    await ins(raw, 'a');
    await softDel(raw, 'a');
    await t.wiki.runExternalDeletions('e1');
    expect(t.calls).toHaveLength(1);
    expect(await ledger(raw)).toEqual([]);
  });

  it('37: the never-set-up forget fallback stops at the first timeout', async () => {
    const { openV8Database, insertV8Entry } = await import('./helpers/v8Schema');
    const db = await openV8Database();
    for (const id of ['a1', 'a2', 'a3']) await insertV8Entry(db, { id, entityId: 'ent', sourceRef: 'a.md', sourceHash: 'd'.repeat(64), updatedAt: 1 });
    const t = open(db, () => new Promise<void>(() => {}), { deletionHookTimeoutMs: 30 });
    let err: any;
    try { await t.wiki.forget('ent', { sourceRef: 'a.md' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WikiExternalDeletionError);
    expect(err.timedOut).toBe(true);
    expect(err.unconfirmedCount).toBe(3);
    expect(t.calls).toHaveLength(1);
  });

  it('37b: the never-set-up deliverRemovals fallback is bounded and stops at the first timeout', async () => {
    const { openV8Database } = await import('./helpers/v8Schema');
    const db = await openV8Database();
    const t = open(db, () => new Promise<void>(() => {}), { deletionHookTimeoutMs: 30 });
    const svc = (t.wiki as any).vectorRemovalService;
    const start = Date.now();
    await svc.deliverRemovals('ent', ['a1', 'a2', 'a3'], 'heal', 'call');
    expect(Date.now() - start).toBeLessThan(1000);
    expect(t.calls).toHaveLength(1);
    expect(t.diags.filter((d) => d.code === 'hook_failed')).toHaveLength(3);
  });

  it('38: when the embed-race enqueue fails, the hook gets null directly', async () => {
    const raw = openTestDatabase();
    const t = open(raw, async (c) => {
      if (c.vector !== null) await softDel(raw, c.factId);
    });
    await t.wiki.setup();
    await ins(raw, 'x');
    (t.wiki as any).vectorRemovalRepo.enqueueIfNotLive = () => Promise.reject(new Error('busy'));
    // The forget-time row exists already (trigger); make it look confirmed so only the fallback can send null.
    const svc = (t.wiki as any).embeddingService;
    await svc.storeFactVector({ id: 'x', entity_id: 'e1' }, new Float32Array([0.1, 0.2]), { operation: 'ingest', trigger: 'call' });
    const mine = t.calls.filter((c) => c.factId === 'x');
    expect(mine[mine.length - 1].vector).toBeNull();
  });

  it('38b: a vector call for a live fact opens no write transaction for the race check', async () => {
    const raw = openTestDatabase();
    const t = open(raw, () => {});
    await t.wiki.setup();
    await ins(raw, 'x');
    const orig = raw.withTransactionAsync.bind(raw);
    let txs = 0;
    raw.withTransactionAsync = (fn: any) => { txs++; return orig(fn); };
    const svc = (t.wiki as any).embeddingService;
    await svc.storeFactVector({ id: 'x', entity_id: 'e1' }, new Float32Array([0.1, 0.2]), { operation: 'ingest', trigger: 'call' });
    raw.withTransactionAsync = orig;
    expect(t.calls).toHaveLength(1);
    expect(txs).toBe(0);
  });

  it('39: the public ledger APIs on a never-set-up store return zeros', async () => {
    const { openV8Database } = await import('./helpers/v8Schema');
    for (const hook of [undefined, () => {}]) {
      const db = await openV8Database();
      const t = open(db, hook as any);
      await expect(t.wiki.getPendingExternalDeletions()).resolves.toEqual({ count: 0, oldestEnqueuedAt: null, maxAttempts: 0 });
      const r = await t.wiki.runExternalDeletions();
      expect(r).toMatchObject({ confirmed: 0, pending: 0, failedIds: [], timedOut: false });
      expect(r.transient).toBeUndefined();
    }
  });

  it('40: a syncSearchIndex() that throws keeps its stashed removal ids', async () => {
    const raw = await markedStore();
    const t = open(raw, () => {});
    await t.wiki.setup();
    const g = (id: string, hash: string) => ({ sourceRef: 'src/a.ts', sourceHash: hash, nodes: [{ id, type: '', title: 'sym ' + id }], edges: [] });
    await raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', g('n1', 'a'.repeat(64)), tx); });
    await t.wiki.syncSearchIndex('e1');
    await raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', g('n2', 'b'.repeat(64)), tx); });
    const w = t.wiki as any;
    const core = w.syncSearchIndexCore.bind(w);
    w.syncSearchIndexCore = () => Promise.reject(new Error('index down'));
    await expect(t.wiki.syncSearchIndex('e1')).rejects.toThrow('index down');
    expect(t.calls.filter((c) => c.factId === 'n1')).toEqual([]);
    w.syncSearchIndexCore = core;
    await t.wiki.syncSearchIndex('e1');
    expect(t.calls.filter((c) => c.factId === 'n1').map((c) => c.vector)).toEqual([null]);
  });

  it('41: under force, importing an unembedded live fact makes no hook call', async () => {
    const src = openTestDatabase();
    const s = new WikiMemory(src, { llmProvider: llm } as any);
    await s.setup();
    await s.remember('e1', { title: 'a', body: 'b' });
    const dump = await s.exportDump(['e1']);
    const raw = openTestDatabase();
    const t = open(raw, () => {}, { forceDeleteIgnoreRankerHook: true });
    await t.wiki.setup();
    await t.wiki.importDump(dump);
    expect(t.calls).toEqual([]);
  });
});
