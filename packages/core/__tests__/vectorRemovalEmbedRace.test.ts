import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';

const P = 'llm_wiki_';
type Call = { entityId: string; factId: string; vector: unknown };

async function make() {
  const raw = openTestDatabase();
  const calls: Call[] = [];
  let release!: (v: number[]) => void;
  let markStarted!: () => void;
  const embedStarted = new Promise<void>((started) => {
    markStarted = started;
  });
  const gate = new Promise<number[]>((r) => (release = r));
  const wiki = new WikiMemory(raw, {
    llmProvider: {
      generateText: async () => '{}',
      embed: async () => {
        markStarted();
        return gate;
      },
    },
    vectorRanker: {
      rankBySimilarity: async () => [],
      onEmbeddingPersisted: async (c: Call) => {
        calls.push(c);
      },
    },
  } as any);
  await wiki.setup();
  return { raw, wiki, calls, release, embedStarted };
}

describe('embed after delete (G10)', () => {
  it('embed() held open (guard path), forget during it: the last hook call for the id is null', async () => {
    const t = await make();
    const p = t.wiki.remember('e1', { title: 'a', body: 'b' });
    await t.embedStarted;
    const [{ id }] = await t.raw.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries`);
    await t.wiki.forget('e1', { entryId: id });
    t.release([0.1, 0.2]);
    await p;
    const mine = t.calls.filter((c) => c.factId === id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[mine.length - 1].vector).toBeNull();
  });

  it('embed() held open (guard path), forget then runPrune({ retainSoftDeletedFor: 0 }) during it: the last hook call is null', async () => {
    const t = await make();
    const p = t.wiki.remember('e1', { title: 'a', body: 'b' });
    await t.embedStarted;
    const [{ id }] = await t.raw.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries`);
    await t.wiki.forget('e1', { entryId: id });
    await t.wiki.runPrune('e1', { retainSoftDeletedFor: 0 });
    t.release([0.1, 0.2]);
    await p;
    const mine = t.calls.filter((c) => c.factId === id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[mine.length - 1].vector).toBeNull();
  });

  it('embedding a deleted fact stores no blob and makes no vector call', async () => {
    const raw = openTestDatabase();
    const calls: Call[] = [];
    const wiki = new WikiMemory(raw, {
      llmProvider: { generateText: async () => '{}', embed: async () => [0.1, 0.2] },
      vectorRanker: {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted: async (c: Call) => {
          calls.push(c);
        },
      },
    } as any);
    await wiki.setup();
    await raw.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at, deleted_at) VALUES ('x', 'e1', 't', 'b', 1, 1, 2)`,
    );
    const svc = (wiki as any).embeddingService;
    const r = await svc.tryEmbedFact({ id: 'x', entity_id: 'e1', title: 't', body: 'b', tags: '[]' });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('fact_deleted');
    const row = await raw.getFirstAsync<any>(`SELECT embedding_blob, embedding_failed_at FROM ${P}entries WHERE id='x'`);
    expect(row.embedding_blob).toBeNull();
    expect(row.embedding_failed_at).toBeNull();
    expect(calls.filter((c) => c.vector !== null)).toEqual([]);
  });

  async function makeBlockedVector() {
    const raw = openTestDatabase();
    const calls: string[] = [];
    let blocked!: () => void;
    const vectorBlocked = new Promise<void>((r) => (blocked = r));
    let unblock!: () => void;
    const hold = new Promise<void>((r) => (unblock = r));
    const wiki = new WikiMemory(raw, {
      llmProvider: { generateText: async () => '{}', embed: async () => [0.1, 0.2] },
      vectorRanker: {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted: async (c: Call) => {
          if (c.vector !== null) {
            blocked();
            await hold;
          }
          calls.push(c.vector === null ? 'null' : 'vec');
        },
      },
    } as any);
    await wiki.setup();
    return { raw, wiki, calls, vectorBlocked, unblock };
  }

  it('vector call in flight, forget during it: the order ends with null', async () => {
    const t = await makeBlockedVector();
    const p = t.wiki.remember('e1', { title: 'a', body: 'b' });
    await t.vectorBlocked;
    const [{ id }] = await t.raw.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries`);
    await t.wiki.forget('e1', { entryId: id });
    t.unblock();
    await p;
    expect(t.calls).toEqual(['null', 'vec', 'null']);
  });

  it('vector call in flight, forget then runPrune({ retainSoftDeletedFor: 0 }): the order ends with null', async () => {
    const t = await makeBlockedVector();
    const p = t.wiki.remember('e1', { title: 'a', body: 'b' });
    await t.vectorBlocked;
    const [{ id }] = await t.raw.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries`);
    await t.wiki.forget('e1', { entryId: id });
    await t.wiki.runPrune('e1', { retainSoftDeletedFor: 0 });
    t.unblock();
    await p;
    expect(t.calls[t.calls.length - 1]).toBe('null');
    expect(t.calls).toContain('vec');
  });

  it('a store without the ledger table: a live remember sends only the vector', async () => {
    const raw = openTestDatabase();
    const calls: string[] = [];
    const wiki = new WikiMemory(raw, {
      llmProvider: { generateText: async () => '{}', embed: async () => [0.1, 0.2] },
      vectorRanker: {
        rankBySimilarity: async () => [],
        onEmbeddingPersisted: async (c: Call) => {
          calls.push(c.vector === null ? 'null' : 'vec');
        },
      },
    } as any);
    await wiki.setup();
    const trg = await raw.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%vector_removals%'`,
    );
    for (const { name } of trg) await raw.runAsync(`DROP TRIGGER ${name}`);
    await raw.runAsync(`DROP TABLE ${P}vector_removals`);
    await wiki.remember('e1', { title: 'a', body: 'b' });
    expect(calls).toEqual(['vec']);
  });
});
