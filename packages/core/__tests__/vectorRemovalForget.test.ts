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
    expect(err.message).toMatch(/^forget\(e1\/a\) failed: onEmbeddingPersisted timed out after 20ms/);
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
