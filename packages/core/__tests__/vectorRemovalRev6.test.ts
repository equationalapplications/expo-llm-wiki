import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';

// Spec durable-vector-removal revision 6 (§8 tests 43-45), from the Fable (high) review.

const P = 'llm_wiki_';
type Call = { entityId: string; factId: string; vector: unknown };

const open = (raw: any, hook: (c: Call) => any, extra: any = {}) => {
  const calls: Call[] = [];
  const diags: any[] = [];
  const wiki = new WikiMemory(raw, {
    llmProvider: { generateText: async () => '{}', embed: async () => [0.1, 0.2, 0.3] },
    onDiagnostic: (d: any) => diags.push(d),
    vectorRanker: { rankBySimilarity: async () => [], onEmbeddingPersisted: async (c: Call) => { calls.push(c); await hook(c); } },
    ...extra,
  } as any);
  return { wiki, calls, diags };
};
const ins = (raw: any, id: string, entity = 'e1') =>
  raw.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES (?, ?, 't', 'b', 1, 1)`, [id, entity]);
const softDel = (raw: any, id: string) => raw.runAsync(`UPDATE ${P}entries SET deleted_at = 2 WHERE id = ?`, [id]);
const restore = (raw: any, id: string) => raw.runAsync(`UPDATE ${P}entries SET deleted_at = NULL WHERE id = ?`, [id]);
const ledger = (raw: any) =>
  raw.getAllAsync(`SELECT fact_id, confirmed_at IS NOT NULL AS confirmed FROM ${P}vector_removals ORDER BY fact_id`) as Promise<any[]>;

describe('revision 6', () => {
  it('43: a node re-added by upsertGraph after its removal was confirmed gets its vector again', async () => {
    const raw = openTestDatabase();
    const t = open(raw, () => {}, { config: { maintenance: 'deferred' } });
    await t.wiki.setup();
    const graph = (ids: string[], hash: string) => ({
      sourceRef: 'src/a.ts', sourceHash: hash.repeat(64),
      nodes: ids.map((id) => ({ id, type: '', title: 'sym ' + id })), edges: [],
    });
    const up = async (ids: string[], h: string) => {
      await raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph(ids, h), tx); });
      await t.wiki.syncSearchIndex('e1');
    };
    await up(['n1', 'n2'], 'a');
    await t.wiki.runPendingMaintenance();
    await up(['n2'], 'b');
    const n1 = () => t.calls.filter((c) => c.factId === 'n1').map((c) => (c.vector === null ? null : 'vec'));
    expect(n1()).toEqual(['vec', null]);
    await up(['n1', 'n2'], 'c');
    await t.wiki.runPendingMaintenance();
    expect(n1()).toEqual(['vec', null, 'vec']);
    expect(await ledger(raw)).toEqual([]);
  });

  it('44: a delete inside a host transaction that is undone sends the live fact no null', async () => {
    const raw = openTestDatabase();
    const t = open(raw, async (c) => {
      if (c.vector !== null) {
        // The host supersedes the fact inside its own transaction, still open when the call resolves.
        await raw.execAsync('BEGIN');
        await softDel(raw, c.factId);
      }
    });
    await t.wiki.setup();
    await ins(raw, 'x');
    const svc = (t.wiki as any).embeddingService;
    await svc.storeFactVector({ id: 'x', entity_id: 'e1' }, new Float32Array([0.1, 0.2]), { operation: 'reembed', trigger: 'call' });
    await restore(raw, 'x');
    await raw.execAsync('COMMIT');
    expect(t.calls.map((c) => c.vector === null)).toEqual([false]);
    expect(await ledger(raw)).toEqual([]);
  });

  it('44b: a delete inside a host transaction that commits is delivered by the next drain', async () => {
    const raw = openTestDatabase();
    const t = open(raw, async (c) => {
      if (c.vector !== null) {
        await raw.execAsync('BEGIN');
        await softDel(raw, c.factId);
      }
    });
    await t.wiki.setup();
    await ins(raw, 'x');
    const svc = (t.wiki as any).embeddingService;
    await svc.storeFactVector({ id: 'x', entity_id: 'e1' }, new Float32Array([0.1, 0.2]), { operation: 'reembed', trigger: 'call' });
    await raw.execAsync('COMMIT');
    await t.wiki.runExternalDeletions('e1');
    expect(t.calls.map((c) => c.vector === null)).toEqual([false, true]);
  });

  it('45: prune does not report a fact restored during its drain as an unconfirmed removal', async () => {
    const raw = openTestDatabase();
    let once = true;
    const t = open(raw, async (c) => {
      if (c.vector === null && c.factId === 'a' && once) {
        once = false;
        await restore(raw, 'b');
      }
    });
    await t.wiki.setup();
    await ins(raw, 'a');
    await ins(raw, 'b');
    await softDel(raw, 'b');
    await t.wiki.runExternalDeletions('e1');
    await softDel(raw, 'a');
    const r = await t.wiki.runPrune('e1', { retainSoftDeletedFor: 0 });
    expect(r.entries).toBe(1);
    const left = (await raw.getAllAsync(`SELECT id, deleted_at FROM ${P}entries`)) as any[];
    expect(left).toEqual([{ id: 'b', deleted_at: null }]);
  });
});
