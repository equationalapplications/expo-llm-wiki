import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';

// Spec durable-vector-removal revision 4 (§8 tests 26-32).

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };
type Call = { entityId: string; factId: string; vector: unknown };

async function seed(raw: any, ids: string[], entity = 'e1') {
  for (const id of ids) {
    await raw.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES (?, ?, 't', 'b', 1, 1)`,
      [id, entity],
    );
    await raw.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = ?`, [id]);
  }
}
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
const ledger = (raw: any) =>
  raw.getAllAsync(`SELECT fact_id, confirmed_at, attempts FROM ${P}vector_removals ORDER BY fact_id`) as Promise<any[]>;
const factExists = async (raw: any, id: string) =>
  !!(await raw.getFirstAsync(`SELECT id FROM ${P}entries WHERE id = ?`, [id]));

/** A store whose marker is set, so its pending rows are owed (spec §5.3). */
async function markedStore() {
  const raw = openTestDatabase();
  await open(raw, () => {}).wiki.setup();
  return raw;
}

describe('revision 4', () => {
  it('26: a removal re-owed while prune reads statuses keeps the fact and its pending row', async () => {
    const raw = await markedStore();
    const t = open(raw, () => {});
    await t.wiki.setup();
    await seed(raw, ['a']);
    await t.wiki.runExternalDeletions('e1');
    expect((await ledger(raw))[0].confirmed_at).not.toBeNull();

    // The embed-race check lands right after prune's status read returns.
    const orig = raw.getAllAsync.bind(raw);
    let fired = false;
    raw.getAllAsync = async (sql: string, ...args: any[]) => {
      const out = await orig(sql, ...args);
      if (!fired && /SELECT fact_id, confirmed_at FROM \S*vector_removals/.test(sql)) {
        fired = true;
        await raw.runAsync(
          `INSERT OR REPLACE INTO ${P}vector_removals (entity_id, fact_id, enqueued_at) VALUES ('e1', 'a', 5)`,
        );
      }
      return out;
    };
    await t.wiki.runPrune('e1', { retainSoftDeletedFor: 0 }).catch(() => {});
    raw.getAllAsync = orig;
    expect(fired).toBe(true);
    expect(await factExists(raw, 'a')).toBe(true);
    const rows = await ledger(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed_at).toBeNull();
  });

  it('27: by default setup() makes no removal call and emits external_deletion_pending', async () => {
    const raw = await markedStore();
    await seed(raw, ['a', 'b']);
    const t = open(raw, () => {});
    await t.wiki.setup();
    await t.wiki.drain();
    expect(t.calls).toEqual([]);
    expect(t.diags.some((d) => d.code === 'external_deletion_pending' && d.detail.count === 2)).toBe(true);
    expect((await ledger(raw)).every((r) => r.confirmed_at === null)).toBe(true);
  });

  it('27b: drainExternalDeletionsOnSetup: true delivers owed removals after setup()', async () => {
    const raw = await markedStore();
    await seed(raw, ['a', 'b']);
    const t = open(raw, () => {}, { drainExternalDeletionsOnSetup: true });
    await t.wiki.setup();
    await t.wiki.drain();
    expect(t.calls.map((c) => c.factId).sort()).toEqual(['a', 'b']);
    expect((await ledger(raw)).every((r) => r.confirmed_at !== null)).toBe(true);
  });

  it('28: a drain of every entity reads its pages one entity at a time', async () => {
    const raw = await markedStore();
    await seed(raw, ['a1', 'a2'], 'ea');
    await seed(raw, ['b1'], 'eb');
    const t = open(raw, () => {});
    await t.wiki.setup();
    const reads: string[] = [];
    const orig = raw.getAllAsync.bind(raw);
    raw.getAllAsync = (sql: string, ...args: any[]) => {
      if (/LEFT JOIN \S*entries e ON e\.id = v\.fact_id/.test(sql)) reads.push(sql);
      return orig(sql, ...args);
    };
    const r = await t.wiki.runExternalDeletions();
    raw.getAllAsync = orig;
    expect(r.pending).toBe(0);
    expect(t.calls.map((c) => c.factId).sort()).toEqual(['a1', 'a2', 'b1']);
    expect(reads.length).toBeGreaterThan(0);
    for (const sql of reads) expect(sql).toMatch(/v\.entity_id = \?/);
  });

  it('29: a hookless prune of a marked store deletes confirmed ledger rows with their facts', async () => {
    const raw = await markedStore();
    await seed(raw, ['ok1', 'ok2', 'bad']);
    const h = open(raw, (c) => { if (c.factId === 'bad') throw new Error('nope'); });
    await h.wiki.setup();
    await h.wiki.runExternalDeletions('e1');
    const hookless = open(raw);
    await hookless.wiki.setup();
    await hookless.wiki.runPrune('e1', { retainSoftDeletedFor: 0 });
    expect(await factExists(raw, 'ok1')).toBe(false);
    const rows = await ledger(raw);
    expect(rows.map((r) => r.fact_id)).toEqual(['bad']);
    expect(rows[0].confirmed_at).toBeNull();
  });

  it('30: forget during a slow embed, before any vector call: one null call, row stays confirmed', async () => {
    const raw = openTestDatabase();
    const calls: Call[] = [];
    let release!: (v: number[]) => void;
    let started!: () => void;
    const embedStarted = new Promise<void>((s) => (started = s));
    const gate = new Promise<number[]>((r) => (release = r));
    let failNext = false;
    const wiki = new WikiMemory(raw, {
      llmProvider: { generateText: async () => '{}', embed: async () => { started(); return gate; } },
      vectorRanker: {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted: async (c: Call) => {
          calls.push(c);
          if (failNext) throw new Error('second null fails');
        },
      },
    } as any);
    await wiki.setup();
    const p = wiki.remember('e1', { title: 'a', body: 'b' });
    await embedStarted;
    const [{ id }] = await raw.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries`);
    await wiki.forget('e1', { entryId: id });
    failNext = true;
    release([0.1, 0.2]);
    await p;
    expect(calls.filter((c) => c.factId === id).map((c) => c.vector)).toEqual([null]);
    const rows = await ledger(raw);
    expect(rows[0].confirmed_at).not.toBeNull();
  });

  it('31: every embed path ends with null when its fact is deleted during the vector call', async () => {
    const raw = openTestDatabase();
    const calls: Call[] = [];
    const wiki = new WikiMemory(raw, {
      llmProvider: { generateText: async () => '{}', embed: async () => [0.1, 0.2] },
      vectorRanker: {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted: async (c: Call) => {
          calls.push(c);
          // A delete commits while the vector call is in flight.
          if (c.vector !== null) await raw.runAsync(`UPDATE ${P}entries SET deleted_at = 9 WHERE id = ?`, [c.factId]);
        },
      },
    } as any);
    await wiki.setup();
    await raw.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES ('x', 'e1', 't', 'b', 1, 1)`,
    );
    // The shared storage half used by ingest, librarian, heal, reembed and import.
    const svc = (wiki as any).embeddingService;
    await svc.storeFactVector({ id: 'x', entity_id: 'e1' }, new Float32Array([0.1, 0.2]), { operation: 'ingest', trigger: 'call' });
    const mine = calls.filter((c) => c.factId === 'x');
    expect(mine.length).toBe(2);
    expect(mine[1].vector).toBeNull();
    expect((await ledger(raw))[0].confirmed_at).not.toBeNull();
  });

  it('32: runExternalDeletions returns transient when a transaction cannot begin', async () => {
    const raw = await markedStore();
    await seed(raw, ['a']);
    const t = open(raw, () => {});
    await t.wiki.setup();
    const orig = raw.withTransactionAsync.bind(raw);
    raw.withTransactionAsync = () => Promise.reject(new Error('cannot start a transaction within a transaction'));
    const r = await t.wiki.runExternalDeletions('e1');
    raw.withTransactionAsync = orig;
    expect(r.transient).toBe(true);
    expect(r.pending).toBe(1);
    expect(t.calls).toEqual([]);
  });
});
