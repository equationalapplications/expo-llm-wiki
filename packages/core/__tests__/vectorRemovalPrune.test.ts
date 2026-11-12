import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { LEGACY_AUTO } from './helpers/legacyAutoConfig';
import { WikiMemory, PrunePartialFailureError } from '../src/index';

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
async function ins(raw: any, id: string) {
  await raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at) VALUES (?, 'e1', 't', 'b', 'doc', 1, 1)`,
    [id],
  );
}
async function old(raw: any, id: string) {
  await ins(raw, id);
  await raw.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = ?`, [id]);
}
const count = async (raw: any, t: string) =>
  (await raw.getFirstAsync(`SELECT COUNT(*) AS n FROM ${P}${t}`)).n as number;

describe('prune on the ledger', () => {
  it('a failing id is kept, the others are hard-deleted, and events and vacuum still run', async () => {
    const t = await make((c) => {
      if (c.factId === 'a') throw new Error('nope');
    }, { config: LEGACY_AUTO });
    for (const id of ['a', 'b', 'c']) await old(t.raw, id);
    await t.raw.runAsync(
      `INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES ('ev', 'e1', 'observation', 's', 1000)`,
    );
    let err: any;
    try {
      await t.wiki.runPrune('e1', { retainEventsFor: 30, vacuum: true } as any);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PrunePartialFailureError);
    expect(err.deleted).toBe(2);
    expect(err.failedAt).toBe('a');
    expect(err.remaining).toBe(1);
    expect(err.deletedEvents).toBe(1);
    const ids = (await t.raw.getAllAsync(`SELECT id FROM ${P}entries`)).map((r: any) => r.id);
    expect(ids).toEqual(['a']);
    expect(await count(t.raw, 'events')).toBe(0);
  });

  it('ids confirmed at forget time are not sent again by prune', async () => {
    const t = await make(() => {});
    await ins(t.raw, 'a');
    await t.wiki.forget('e1', { sourceRef: 'doc' });
    await t.raw.runAsync(`UPDATE ${P}entries SET deleted_at = 1`);
    t.calls.length = 0;
    await t.wiki.runPrune('e1', {} as any);
    expect(t.calls).toEqual([]);
    expect(await count(t.raw, 'entries')).toBe(0);
    expect(await count(t.raw, 'vector_removals')).toBe(0);
  });

  it('pruneSupersededAfter sends null at soft-delete time', async () => {
    const t = await make(() => {}, { config: { pruneSupersededAfter: 0 } });
    await ins(t.raw, 'x');
    await t.raw.runAsync(`UPDATE ${P}entries SET valid_to = 1 WHERE id = 'x'`);
    await t.wiki.runPrune('e1', { retainSoftDeletedFor: null, retainEventsFor: null } as any);
    expect(t.calls.map((c) => c.factId)).toEqual(['x']);
    expect(t.calls[0].vector).toBeNull();
    expect(await count(t.raw, 'entries')).toBe(1);
  });

  it('without a hook and with the marker set, prune keeps ledger rows', async () => {
    const t = await make();
    await t.raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES ('external_index_in_use', '1')`);
    await old(t.raw, 'a');
    await t.wiki.runPrune('e1', {} as any);
    expect(await count(t.raw, 'entries')).toBe(0);
    expect(await count(t.raw, 'vector_removals')).toBe(1);
  });

  it('without a hook and never marked, prune removes ledger rows with their facts', async () => {
    const t = await make();
    await old(t.raw, 'a');
    expect(await count(t.raw, 'vector_removals')).toBe(1);
    await t.wiki.runPrune('e1', {} as any);
    expect(await count(t.raw, 'entries')).toBe(0);
    expect(await count(t.raw, 'vector_removals')).toBe(0);
  });

  it('force: prune hard-deletes and removes ledger rows with no call', async () => {
    const t = await make(() => {}, { forceDeleteIgnoreRankerHook: true });
    await old(t.raw, 'a');
    await t.wiki.runPrune('e1', {} as any);
    expect(t.calls).toEqual([]);
    expect(await count(t.raw, 'entries')).toBe(0);
    expect(await count(t.raw, 'vector_removals')).toBe(0);
  });

  it('a legacy prunable row without a ledger row is sent before its hard delete', async () => {
    const t = await make(() => {});
    await old(t.raw, 'a');
    await t.raw.runAsync(`DELETE FROM ${P}vector_removals`);
    await t.wiki.runPrune('e1', {} as any);
    expect(t.calls.map((c) => c.factId)).toEqual(['a']);
    expect(await count(t.raw, 'entries')).toBe(0);
  });
});
