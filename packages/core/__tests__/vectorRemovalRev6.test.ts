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

  it('46: a restore after a confirmed removal clears embedding failure markers', async () => {
    const raw = openTestDatabase();
    const t = open(raw, () => {});
    await t.wiki.setup();
    await ins(raw, 'x');
    await raw.runAsync(
      `UPDATE ${P}entries SET embedding_blob = X'00000000', embedding_failed_at = 5, embedding_failure_kind = 'provider_error', embedding_attempts = 9 WHERE id = 'x'`,
    );
    await softDel(raw, 'x');
    await raw.runAsync(`UPDATE ${P}vector_removals SET confirmed_at = 7 WHERE fact_id = 'x'`);
    await restore(raw, 'x');
    const row = await raw.getFirstAsync(
      `SELECT embedding_blob, embedding_failed_at, embedding_failure_kind, embedding_attempts FROM ${P}entries WHERE id = 'x'`,
    );
    expect(row).toEqual({ embedding_blob: null, embedding_failed_at: null, embedding_failure_kind: null, embedding_attempts: 0 });
  });

  it('46b: a restore before confirmation keeps the vector and the markers', async () => {
    const raw = openTestDatabase();
    const t = open(raw, () => {});
    await t.wiki.setup();
    await ins(raw, 'x');
    await raw.runAsync(`UPDATE ${P}entries SET embedding_failed_at = 5, embedding_attempts = 2 WHERE id = 'x'`);
    await softDel(raw, 'x');
    await restore(raw, 'x');
    const row: any = await raw.getFirstAsync(`SELECT embedding_failed_at, embedding_attempts FROM ${P}entries WHERE id = 'x'`);
    expect(row).toEqual({ embedding_failed_at: 5, embedding_attempts: 2 });
  });

  // A store an older engine set up (no ledger), opened without setup().
  const preLedgerStore = async () => {
    const raw = openTestDatabase();
    await open(raw, () => {}).wiki.setup();
    await raw.execAsync(`
      DROP TRIGGER ${P}vector_removals_enqueue; DROP TRIGGER ${P}vector_removals_resurrect;
      DROP TRIGGER ${P}vector_removals_hard_delete; DROP TABLE ${P}vector_removals;`);
    await ins(raw, 'a1', 'ent');
    return raw;
  };

  it('47: on a store without the ledger, a fact deleted during its vector call ends with a null call', async () => {
    const raw = await preLedgerStore();
    const t = open(raw, async (c) => {
      if (c.vector !== null) await softDel(raw, c.factId);
    });
    const svc = (t.wiki as any).embeddingService;
    await svc.storeFactVector({ id: 'a1', entity_id: 'ent' }, new Float32Array([0.1, 0.2]), { operation: 'reembed', trigger: 'call' });
    expect(t.calls.map((c) => c.vector === null)).toEqual([false, true]);
  });

  it('47b: on a store without the ledger, a live fact gets no null after its vector call', async () => {
    const raw = await preLedgerStore();
    const t = open(raw, () => {});
    const svc = (t.wiki as any).embeddingService;
    await svc.storeFactVector({ id: 'a1', entity_id: 'ent' }, new Float32Array([0.1, 0.2]), { operation: 'reembed', trigger: 'call' });
    expect(t.calls.map((c) => c.vector === null)).toEqual([false]);
  });

  it('46c: a store set up before migration 11 gets the marker clear once the columns exist', async () => {
    const { openV8Database } = await import('./helpers/v8Schema');
    const db = await openV8Database();
    await open(db, () => {}).wiki.setup();
    const trig: any = await db.getFirstAsync(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = '${P}vector_removals_resurrect'`,
    );
    expect(trig.sql).toContain('embedding_failed_at');
  });

  it('46d: a rev 6 resurrect trigger is replaced on the next setup', async () => {
    const raw = openTestDatabase();
    await open(raw, () => {}).wiki.setup();
    await raw.execAsync(`DROP TRIGGER ${P}vector_removals_resurrect;
      CREATE TRIGGER ${P}vector_removals_resurrect AFTER UPDATE OF deleted_at ON ${P}entries
      WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
      BEGIN UPDATE ${P}entries SET embedding_blob = NULL, embedding = NULL WHERE id = NEW.id; END;`);
    await open(raw, () => {}).wiki.setup();
    const trig: any = await raw.getFirstAsync(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = '${P}vector_removals_resurrect'`,
    );
    expect(trig.sql).toContain('embedding_failed_at');
  });
});

