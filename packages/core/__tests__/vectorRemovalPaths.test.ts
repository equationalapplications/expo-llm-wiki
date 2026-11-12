import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';

const P = 'llm_wiki_';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
type Call = { entityId: string; factId: string; vector: unknown };
const llmFacts = async () =>
  JSON.stringify({ facts: [{ title: 'New Fact', body: 'some body text', tags: [], confidence: 'certain' }] });

async function make(hook?: (c: Call) => Promise<void> | void, extra: any = {}, generateText: any = llmFacts) {
  const raw = openTestDatabase();
  const calls: Call[] = [];
  const diags: any[] = [];
  const wiki = new WikiMemory(raw, {
    llmProvider: { generateText },
    onDiagnostic: (d: any) => diags.push(d),
    ...(hook
      ? {
          vectorRanker: {
            rankBySimilarity: async () => [],
            onEmbeddingPersisted: async (c: Call) => {
              calls.push(c);
              await hook(c);
            },
          },
        }
      : {}),
    ...extra,
  } as any);
  await wiki.setup();
  return { raw, wiki, calls, diags };
}
async function ins(raw: any, id: string, type = 'librarian_inferred', ref: string | null = null) {
  await raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, source_type, source_ref, created_at, updated_at) VALUES (?, 'e1', ?, 'body text', ?, ?, 1, 1)`,
    [id, `title ${id}`, type, ref],
  );
}
const rows = async (raw: any) =>
  (await raw.getAllAsync(`SELECT fact_id, confirmed_at FROM ${P}vector_removals ORDER BY fact_id`)) as any[];
const failed = (diags: any[]) => diags.filter((d) => d.code === 'hook_failed').map((d) => d.detail.factId).sort();
const drainAll = (wiki: any) => (wiki as any).vectorRemovalService.drain({ all: true });

const allConfirmed = async (raw: any) => {
  const r = await rows(raw);
  return r.length > 0 && r.every((x) => x.confirmed_at !== null);
};

describe('healthy-hook settlement', () => {
  it('heal orphan and heal delete settle their rows; a later drain makes no call', async () => {
    const gen = async () => JSON.stringify({ downgraded: [], deleted: ['d1'], newFacts: [] });
    const t = await make(() => {}, { config: { orphanAfterDays: null, staleInferredAfterDays: null } }, gen);
    await ins(t.raw, 'd1');
    await t.wiki.runHeal('e1');
    expect(await allConfirmed(t.raw)).toBe(true);
    t.calls.length = 0;
    await drainAll(t.wiki);
    expect(t.calls).toEqual([]);
    const o = await make(() => {}, { config: { orphanAfterDays: 0, staleInferredAfterDays: null } });
    await ins(o.raw, 'o1');
    await o.wiki.runHeal('e1');
    expect(await allConfirmed(o.raw)).toBe(true);
    o.calls.length = 0;
    await drainAll(o.wiki);
    expect(o.calls).toEqual([]);
  });

  it('full re-ingest settles superseded rows; a later drain makes no call', async () => {
    const t = await make(() => {});
    await t.wiki.ingestDocument('e1', { sourceRef: 'doc', sourceHash: H1, documentChunk: 'hello world' });
    await t.wiki.ingestDocument('e1', { sourceRef: 'doc', sourceHash: H2, documentChunk: 'hello again' });
    expect(await allConfirmed(t.raw)).toBe(true);
    t.calls.length = 0;
    await drainAll(t.wiki);
    expect(t.calls).toEqual([]);
  });

  it('replace import settles removed rows; a later drain makes no call', async () => {
    const t = await make(() => {});
    await ins(t.raw, 'old1');
    await t.wiki.importDump(dump([{ id: 'new1' }]));
    expect(await allConfirmed(t.raw)).toBe(true);
    t.calls.length = 0;
    await drainAll(t.wiki);
    expect(t.calls).toEqual([]);
  });
});

describe('heal on the ledger', () => {
  it('orphan with a rejecting hook: pending, hook_failed, delivered by a later drain', async () => {
    let fail = true;
    const t = await make(() => { if (fail) throw new Error('nope'); }, { config: { orphanAfterDays: 0, staleInferredAfterDays: null } });
    await ins(t.raw, 'o1');
    await t.wiki.runHeal('e1');
    expect(failed(t.diags)).toEqual(['o1']);
    expect((await rows(t.raw)).filter((r) => r.confirmed_at === null)).toHaveLength(1);
    fail = false;
    t.calls.length = 0;
    await t.wiki.runPendingMaintenance();
    expect(t.calls.map((c) => c.factId)).toEqual(['o1']);
    expect((await rows(t.raw)).filter((r) => r.confirmed_at === null)).toHaveLength(0);
  });

  it('heal delete with a rejecting hook is pending and reports hook_failed', async () => {
    const gen = async () => JSON.stringify({ downgraded: [], deleted: ['d1'], newFacts: [] });
    const t = await make(() => { throw new Error('nope'); }, { config: { orphanAfterDays: null, staleInferredAfterDays: null } }, gen);
    await ins(t.raw, 'd1');
    await t.wiki.runHeal('e1');
    expect(failed(t.diags)).toEqual(['d1']);
    expect((await rows(t.raw)).filter((r) => r.confirmed_at === null).map((r) => r.fact_id)).toEqual(['d1']);
  });

  it('heal with a hanging hook resolves within the timeout', async () => {
    const t = await make(() => new Promise(() => {}), { deletionHookTimeoutMs: 30, config: { orphanAfterDays: 0, staleInferredAfterDays: null } });
    await ins(t.raw, 'o1');
    const started = Date.now();
    await t.wiki.runHeal('e1');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(failed(t.diags)).toEqual(['o1']);
  });

  it('invalid timeout: heal does not throw, hook_failed fires', async () => {
    const t = await make(() => {}, { deletionHookTimeoutMs: -1, config: { orphanAfterDays: 0, staleInferredAfterDays: null } });
    await ins(t.raw, 'o1');
    await t.wiki.runHeal('e1');
    expect(failed(t.diags)).toEqual(['o1']);
  });

  it('force: heal makes no removal call', async () => {
    const t = await make(() => {}, { forceDeleteIgnoreRankerHook: true, config: { orphanAfterDays: 0, staleInferredAfterDays: null } });
    await ins(t.raw, 'o1');
    await t.wiki.runHeal('e1');
    expect(t.calls).toEqual([]);
  });
});

describe('ingest on the ledger', () => {
  it('full re-ingest with a rejecting hook leaves superseded ids pending', async () => {
    const t = await make(() => { throw new Error('nope'); });
    await t.wiki.ingestDocument('e1', { sourceRef: 'doc', sourceHash: H1, documentChunk: 'hello world' });
    const first = (await t.raw.getAllAsync(`SELECT id FROM ${P}entries WHERE source_ref = 'doc'`)) as any[];
    expect(first.length).toBeGreaterThan(0);
    t.diags.length = 0;
    await t.wiki.ingestDocument('e1', { sourceRef: 'doc', sourceHash: H2, documentChunk: 'hello again' });
    const ids = first.map((r) => r.id).sort();
    expect(failed(t.diags)).toEqual(ids);
    expect((await rows(t.raw)).filter((r) => r.confirmed_at === null).map((r) => r.fact_id).sort()).toEqual(ids);
  });

  it('superseded ids left pending by a rejecting hook are delivered by a later drain', async () => {
    let fail = true;
    const t = await make(() => { if (fail) throw new Error('nope'); });
    await t.wiki.ingestDocument('e1', { sourceRef: 'doc', sourceHash: H1, documentChunk: 'hello world' });
    const first = ((await t.raw.getAllAsync(`SELECT id FROM ${P}entries`)) as any[]).map((r) => r.id).sort();
    await t.wiki.ingestDocument('e1', { sourceRef: 'doc', sourceHash: H2, documentChunk: 'hello again' });
    fail = false;
    t.calls.length = 0;
    await drainAll(t.wiki);
    expect(t.calls.map((c) => c.factId).sort()).toEqual(first);
    expect(await allConfirmed(t.raw)).toBe(true);
  });

  it('force: ingest makes no removal call', async () => {
    const t = await make(() => {}, { forceDeleteIgnoreRankerHook: true });
    await t.wiki.ingestDocument('e1', { sourceRef: 'doc', sourceHash: H1, documentChunk: 'hello world' });
    await t.wiki.ingestDocument('e1', { sourceRef: 'doc', sourceHash: H2, documentChunk: 'hello again' });
    expect(t.calls.filter((c) => c.vector === null)).toEqual([]);
  });
});

const BLOB = new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer);
function dump(facts: Array<{ id: string; deleted_at?: number | null }>) {
  return {
    generatedAt: Date.now(),
    entities: {
      e1: {
        facts: facts.map((f) => ({
          id: f.id, entity_id: 'e1', title: 'T ' + f.id, body: 'body content', tags: [],
          confidence: 'certain', source_type: 'immutable_document', source_hash: null, source_ref: 'x.pdf',
          created_at: 1000, updated_at: 1000, last_accessed_at: null, access_count: 0, deleted_at: f.deleted_at ?? null,
          embedding_blob: BLOB,
        })),
        tasks: [], events: [], edges: [],
      },
    },
  } as any;
}

describe('importDump on the ledger', () => {
  it('replace with a rejecting hook leaves removals pending', async () => {
    const t = await make(() => { throw new Error('nope'); });
    await ins(t.raw, 'old1');
    await t.wiki.importDump(dump([{ id: 'new1' }]));
    expect(failed(t.diags)).toContain('old1');
    expect((await rows(t.raw)).filter((r) => r.confirmed_at === null).map((r) => r.fact_id)).toEqual(['old1']);
  });

  it('a merge tombstone over a live fact delivers null', async () => {
    const t = await make(() => {});
    await ins(t.raw, 'live1');
    await t.wiki.importDump(dump([{ id: 'live1', deleted_at: 5000 }]), { merge: true } as any);
    expect(t.calls.filter((c) => c.factId === 'live1' && c.vector === null)).toHaveLength(1);
  });

  it('a replace import of the same ids leaves no ledger rows and no null calls', async () => {
    const t = await make(() => {});
    await t.wiki.importDump(dump([{ id: 'same' }]));
    t.calls.length = 0;
    await t.wiki.importDump(dump([{ id: 'same' }]));
    expect(t.calls.filter((c) => c.vector === null)).toEqual([]);
    expect(await rows(t.raw)).toEqual([]);
  });

  it('force: replace import makes no removal call', async () => {
    const t = await make(() => {}, { forceDeleteIgnoreRankerHook: true });
    await ins(t.raw, 'old1');
    await t.wiki.importDump(dump([{ id: 'new1' }]));
    expect(t.calls.filter((c) => c.factId === 'old1')).toEqual([]);
  });
});

describe('upsertGraph on the ledger', () => {
  const graph = (id: string, hash: string) => ({
    sourceRef: 'src/a.ts', sourceHash: hash, nodes: [{ id, type: '', title: 'sym ' + id }], edges: [],
  });

  it('no call inside the tx, rollback leaves no rows, syncSearchIndex delivers', async () => {
    const t = await make(() => {});
    await t.raw.withTransactionAsync(async (tx: any) => {
      await t.wiki.upsertGraph('e1', graph('n1', H1), tx);
    });
    await expect(
      t.raw.withTransactionAsync(async (tx: any) => {
        await t.wiki.upsertGraph('e1', graph('n2', H2), tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await rows(t.raw)).toEqual([]);
    await t.raw.withTransactionAsync(async (tx: any) => {
      await t.wiki.upsertGraph('e1', graph('n3', H2), tx);
      expect(t.calls).toEqual([]);
    });
    expect((await rows(t.raw)).map((r) => r.fact_id)).toEqual(['n1']);
    await t.wiki.syncSearchIndex('e1');
    expect(t.calls.map((c) => c.factId)).toEqual(['n1']);
    expect(t.calls[0].vector).toBeNull();
    expect((await rows(t.raw)).every((r) => r.confirmed_at !== null)).toBe(true);
  });

  it('syncSearchIndex() with no entity drains all and reports failures', async () => {
    const t = await make(() => { throw new Error('nope'); });
    await t.raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph('n1', H1), tx); });
    await t.raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph('n2', H2), tx); });
    await t.wiki.syncSearchIndex();
    expect(failed(t.diags)).toEqual(['n1']);
  });

  it('a stable-id re-upsert of a live fact leaves no ledger row', async () => {
    const t = await make(() => {});
    await t.raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph('n1', H1), tx); });
    await t.raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph('n1', H2), tx); });
    await t.wiki.syncSearchIndex('e1');
    expect(await rows(t.raw)).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('syncSearchIndex calls the hook only for the superseded id, not the entity backlog', async () => {
    const t = await make(() => {});
    for (const id of ['b1', 'b2', 'b3']) {
      await ins(t.raw, id);
      await t.raw.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = ?`, [id]);
    }
    await t.raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph('n1', H1), tx); });
    await t.raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph('n2', H2), tx); });
    await t.wiki.syncSearchIndex('e1');
    expect(t.calls.map((c) => c.factId)).toEqual(['n1']);
    expect((await rows(t.raw)).filter((r) => r.confirmed_at === null).map((r) => r.fact_id)).toEqual(['b1', 'b2', 'b3']);
  });
});

describe('upsertGraph removals independent of the search strategy', () => {
  const graph = (id: string, hash: string) => ({
    sourceRef: 'src/a.ts', sourceHash: hash, nodes: [{ id, type: '', title: 'sym ' + id }], edges: [],
  });

  it('MiniSearch: syncSearchIndex delivers null for the superseded id only', async () => {
    const t = await make(() => {}, { config: { indexStrategy: 'minisearch' } });
    await t.raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph('n1', H1), tx); });
    await t.raw.withTransactionAsync(async (tx: any) => { await t.wiki.upsertGraph('e1', graph('n2', H2), tx); });
    expect(t.calls).toEqual([]);
    await t.wiki.syncSearchIndex('e1');
    expect(t.calls.map((c) => c.factId)).toEqual(['n1']);
    expect(t.calls[0].vector).toBeNull();
  });
});

describe('deliverRemovals pending diagnostic gate (§5.3)', () => {
  const gen = async () => JSON.stringify({ downgraded: [], deleted: ['d1'], newFacts: [] });
  const pending = (diags: any[]) => diags.filter((d) => d.code === 'external_deletion_pending');

  it('hookless store without the marker: heal delete emits no external_deletion_pending', async () => {
    const t = await make(undefined, { config: { orphanAfterDays: null, staleInferredAfterDays: null } }, gen);
    await ins(t.raw, 'd1');
    await t.wiki.runHeal('e1');
    expect(pending(t.diags)).toEqual([]);
  });

  it('hookless store with the marker: heal delete emits exactly one external_deletion_pending', async () => {
    const t = await make(undefined, { config: { orphanAfterDays: null, staleInferredAfterDays: null } }, gen);
    await t.raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES ('external_index_in_use', '1')`);
    await ins(t.raw, 'd1');
    await t.wiki.runHeal('e1');
    expect(pending(t.diags)).toHaveLength(1);
  });
});
