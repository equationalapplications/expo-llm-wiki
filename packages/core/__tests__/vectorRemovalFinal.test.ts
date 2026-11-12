import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory, WikiExternalDeletionError } from '../src/index';

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
const marker = async (raw: any) =>
  (await raw.getFirstAsync(`SELECT value FROM ${P}meta WHERE key = 'external_index_in_use'`)) as any;

describe('final review fixes', () => {
  it('runPendingMaintenance bounds the setup-drain await by deadlineMs', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a', 'b']);
    const t = open(raw, () => new Promise<void>(() => {}), { deletionHookTimeoutMs: 5000 });
    await t.wiki.setup();
    await new Promise((r) => setTimeout(r, 20));
    const start = Date.now();
    await t.wiki.runPendingMaintenance({ deadlineMs: 200 });
    expect(Date.now() - start).toBeLessThan(600);
  });

  it('getPendingMaintenance terminates with an always-rejecting hook', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    const t = open(raw, () => { throw new Error('nope'); }, { drainExternalDeletionsOnSetup: false });
    await t.wiki.setup();
    let passes = 0;
    while ((await t.wiki.getPendingMaintenance()).length && passes < 5) {
      await t.wiki.runPendingMaintenance();
      passes++;
    }
    expect(passes).toBe(1);
  });

  it('a forget that joins a resolving setup-drain call does not throw', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = open(raw, () => gate);
    await t.wiki.setup();
    await new Promise((r) => setTimeout(r, 30));
    // 'a' is in flight in the setup drain; soft-deleted already, so forget joins via a fresh live fact
    await raw.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES ('a','e1','t','b',1,1)`).catch(() => {});
    const f = t.wiki.forget('e1', { entryId: 'a' } as any).then(() => 'ok', (e: any) => e);
    await new Promise((r) => setTimeout(r, 30));
    release();
    const res = await f;
    expect(res instanceof Error ? res.message : res).toBe('ok');
  });

  it('setup reads the marker first and does not rewrite it', async () => {
    const raw = openTestDatabase();
    await open(raw, () => {}).wiki.setup();
    expect((await marker(raw)).value).toBe('1');
    let writes = 0;
    const spy: any = { ...raw, runAsync: (sql: string, a?: any) => { if (/external_index_in_use/.test(JSON.stringify(a ?? [])) || /external_index_in_use/.test(sql)) writes++; return raw.runAsync(sql, a); } };
    spy.withTransactionAsync = (fn: any) => raw.withTransactionAsync((tx: any) => fn({ ...tx, runAsync: spy.runAsync }));
    await open(spy, () => {}).wiki.setup();
    expect(writes).toBe(0);
  });

  it('force with zero pending rows clears the marker', async () => {
    const raw = openTestDatabase();
    await open(raw, () => {}).wiki.setup();
    expect((await marker(raw))?.value).toBe('1');
    const t = open(raw, () => {}, { forceDeleteIgnoreRankerHook: true });
    await t.wiki.setup();
    await t.wiki.drain();
    expect(await marker(raw)).toBeFalsy();
  });

  it('forget timeout message names the id that timed out', async () => {
    const raw = openTestDatabase();
    const t = open(raw, (c) => (c.factId === 'a' ? Promise.reject(new Error('nope')) : c.factId === 'b' ? new Promise<void>(() => {}) : undefined), { deletionHookTimeoutMs: 50, drainExternalDeletionsOnSetup: false });
    await t.wiki.setup();
    for (const id of ['a', 'b', 'c']) {
      await raw.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at) VALUES (?, 'e1', 't', 'b', 'doc', 1, 1)`, [id]);
    }
    const err: any = await t.wiki.forget('e1', { clearAll: true } as any).catch((e: any) => e);
    expect(err).toBeInstanceOf(WikiExternalDeletionError);
    expect(err.message).toContain('forget(e1/b)');
  });
});
