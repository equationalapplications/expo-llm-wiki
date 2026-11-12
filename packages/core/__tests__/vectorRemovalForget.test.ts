import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory, WikiExternalDeletionError } from '../src/index';

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };
type Call = { entityId: string; factId: string; vector: unknown };

async function make(hook?: (c: Call) => Promise<void> | void, extra: any = {}) {
  const raw = openTestDatabase();
  const calls: Call[] = [];
  const wiki = new WikiMemory(raw, {
    llmProvider: llm,
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
  return { raw, wiki, calls };
}
async function ins(raw: any, id: string, ref = 'doc') {
  await raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at) VALUES (?, 'e1', 't', 'b', ?, 1, 1)`,
    [id, ref],
  );
}

describe('forget on the ledger', () => {
  it('continues past a rejecting id and lists only the unconfirmed ones', async () => {
    const t = await make((c) => {
      if (c.factId === 'a') throw new Error('nope');
    });
    for (const id of ['a', 'b', 'c']) await ins(t.raw, id);
    let err: any;
    try {
      await t.wiki.forget('e1', { sourceRef: 'doc' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WikiExternalDeletionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.unconfirmedIds).toEqual(['a']);
    expect(err.unconfirmedCount).toBe(1);
    expect(err.timedOut).toBe(false);
    expect(err.message).toBe('forget(e1/a) failed: ANN cleanup hook rejected');
    expect(t.calls.map((c) => c.factId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('a forget retry sends only the unconfirmed ids, then nothing', async () => {
    let fail = true;
    const t = await make((c) => {
      if (fail && c.factId === 'a') throw new Error('nope');
    });
    for (const id of ['a', 'b']) await ins(t.raw, id);
    await expect(t.wiki.forget('e1', { sourceRef: 'doc' })).rejects.toBeInstanceOf(WikiExternalDeletionError);
    t.calls.length = 0;
    fail = false;
    await t.wiki.forget('e1', { sourceRef: 'doc' });
    expect(t.calls.map((c) => c.factId)).toEqual(['a']);
    t.calls.length = 0;
    await t.wiki.forget('e1', { sourceRef: 'doc' });
    expect(t.calls).toEqual([]);
  });

  it('a legacy soft-deleted id without a ledger row is sent exactly once', async () => {
    const t = await make(() => {});
    await ins(t.raw, 'old');
    await t.raw.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = 'old'`);
    await t.raw.runAsync(`DELETE FROM ${P}vector_removals`);
    await t.wiki.forget('e1', { sourceRef: 'doc' });
    expect(t.calls.map((c) => c.factId)).toEqual(['old']);
    await t.wiki.forget('e1', { sourceRef: 'doc' });
    expect(t.calls).toHaveLength(1);
  });

  it('sends only its own ids when the entity has a backlog', async () => {
    const t = await make(() => {});
    for (let i = 0; i < 50; i++) {
      await ins(t.raw, `x${i}`, 'other');
      await t.raw.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = 'x${i}'`);
    }
    await ins(t.raw, 'mine');
    await t.wiki.forget('e1', { entryId: 'mine' });
    expect(t.calls.map((c) => c.factId)).toEqual(['mine']);
  });

  it('the timeout message wins over a rejection', async () => {
    const t = await make(
      async (c) => {
        if (c.factId === 'a') throw new Error('nope');
        await new Promise((r) => setTimeout(r, 200));
      },
      { deletionHookTimeoutMs: 20 },
    );
    for (const id of ['a', 'b']) await ins(t.raw, id);
    let err: any;
    try {
      await t.wiki.forget('e1', { sourceRef: 'doc' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WikiExternalDeletionError);
    expect(err.timedOut).toBe(true);
    expect(err.message).toMatch(/^forget\(e1\/b\) failed: onEmbeddingPersisted timed out after 20ms/);
  });

  it('forceDeleteIgnoreRankerHook: forget makes no call and resolves', async () => {
    const t = await make(() => {}, { forceDeleteIgnoreRankerHook: true });
    await ins(t.raw, 'a');
    await t.wiki.forget('e1', { entryId: 'a' });
    expect(t.calls).toEqual([]);
  });

  it('an invalid deletionHookTimeoutMs keeps its message shape', async () => {
    const t = await make(() => {}, { deletionHookTimeoutMs: -1 });
    await ins(t.raw, 'a');
    await expect(t.wiki.forget('e1', { entryId: 'a' })).rejects.toThrow(
      /^forget\(e1\/a\) failed: Invalid deletionHookTimeoutMs/,
    );
  });
});

describe('forget on the ledger (review fixes)', () => {
  it('never-set-up store with a hook: one null call per id', async () => {
    const { openV8Database, insertV8Entry } = await import('./helpers/v8Schema');
    const db = await openV8Database();
    await insertV8Entry(db, { id: 'a1', entityId: 'ent', sourceRef: 'a.md', sourceHash: 'd'.repeat(64), updatedAt: 1 });
    const calls: Call[] = [];
    const wiki = new WikiMemory(db, {
      llmProvider: llm,
      vectorRanker: { rankBySimilarity: async () => [], onEmbeddingPersisted: async (c: Call) => { calls.push(c); } },
    } as any);
    await wiki.forget('ent', { sourceRef: 'a.md' });
    expect(calls.map((c) => [c.factId, c.vector])).toEqual([['a1', null]]);
  });

  it('never-set-up store with a rejecting hook: WikiExternalDeletionError', async () => {
    const { openV8Database, insertV8Entry } = await import('./helpers/v8Schema');
    const db = await openV8Database();
    for (const id of ['a1', 'a2']) await insertV8Entry(db, { id, entityId: 'ent', sourceRef: 'a.md', sourceHash: 'd'.repeat(64), updatedAt: 1 });
    const calls: Call[] = [];
    const wiki = new WikiMemory(db, {
      llmProvider: llm,
      vectorRanker: { rankBySimilarity: async () => [], onEmbeddingPersisted: async (c: Call) => { calls.push(c); throw new Error('nope'); } },
    } as any);
    let err: any;
    try { await wiki.forget('ent', { sourceRef: 'a.md' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WikiExternalDeletionError);
    expect(err.unconfirmedCount).toBe(2);
    expect(calls).toHaveLength(2);
    expect(err.message).toMatch(/failed: ANN cleanup hook rejected$/);
  });

  it('hookless store without the marker emits nothing; with the marker it emits', async () => {
    const diags: any[] = [];
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm, onDiagnostic: (d: any) => diags.push(d) } as any);
    await wiki.setup();
    await ins(raw, 'a');
    await wiki.forget('e1', { entryId: 'a' });
    expect(diags.filter((d) => d.code === 'external_deletion_pending')).toEqual([]);
    await raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES ('external_index_in_use', '1')`);
    await ins(raw, 'b');
    await wiki.forget('e1', { entryId: 'b' });
    expect(diags.filter((d) => d.code === 'external_deletion_pending').length).toBeGreaterThan(0);
  });

  it('no hook: forget resolves and the ledger rows stay', async () => {
    const t = await make();
    await ins(t.raw, 'a');
    await t.wiki.forget('e1', { entryId: 'a' });
    const rows = await t.raw.getAllAsync<any>(`SELECT fact_id FROM ${P}vector_removals`);
    expect(rows.map((r) => r.fact_id)).toEqual(['a']);
  });

  it('error code, sanitized cause, and the 100-id cap', async () => {
    const t = await make(() => { throw new Error('secret-detail'); });
    for (let i = 0; i < 120; i++) await ins(t.raw, `f${String(i).padStart(3, '0')}`);
    let err: any;
    try { await t.wiki.forget('e1', { sourceRef: 'doc' }); } catch (e) { err = e; }
    expect(err.code).toBe('WIKI_EXTERNAL_DELETION');
    expect(err.unconfirmedIds).toHaveLength(100);
    expect(err.unconfirmedCount).toBe(120);
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause.message).not.toContain('secret-detail');
  });
});
