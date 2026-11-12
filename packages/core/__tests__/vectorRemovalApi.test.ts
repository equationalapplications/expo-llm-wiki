import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';

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
const pendingRows = async (raw: any) =>
  (await raw.getAllAsync(`SELECT fact_id FROM ${P}vector_removals WHERE confirmed_at IS NULL ORDER BY fact_id`)) as any[];
const pend = (diags: any[]) => diags.filter((d) => d.code === 'external_deletion_pending');

describe('public API and setup drain', () => {
  it('crash recovery: rows committed in one instance are delivered by runExternalDeletions in a second instance on the same file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-'));
    try {
      const file = path.join(dir, 'w.db');
      const raw1 = openTestDatabase(file);
      await open(raw1).wiki.setup();
      await seed(raw1, ['a', 'b']);
      const raw2 = openTestDatabase(file);
      const t = open(raw2, () => {}, { drainExternalDeletionsOnSetup: false });
      await t.wiki.setup();
      expect(t.calls).toEqual([]);
      const r = await t.wiki.runExternalDeletions();
      expect(r).toEqual({ confirmed: 2, pending: 0, failedIds: [], timedOut: false });
      expect(t.calls.map((c) => c.factId).sort()).toEqual(['a', 'b']);
      expect(await pendingRows(raw2)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setup drains owed removals; wiki.drain() awaits it', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = open(raw, () => gate);
    await t.wiki.setup();
    let drained = false;
    const d = t.wiki.drain().then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.calls.map((c) => c.factId)).toEqual(['a']);
    expect(drained).toBe(false);
    release();
    await d;
    expect(await pendingRows(raw)).toEqual([]);
  });

  it('drainExternalDeletionsOnSetup: false makes no call and emits external_deletion_pending', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a'], 'e1');
    await seed(raw, ['b'], 'e2');
    const t = open(raw, () => {}, { drainExternalDeletionsOnSetup: false });
    await t.wiki.setup();
    await t.wiki.drain();
    expect(t.calls).toEqual([]);
    expect(pend(t.diags).map((d) => d.entityId).sort()).toEqual(['e1', 'e2']);
  });

  it('the setup drain stops within its deadline when the hook hangs', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a', 'b']);
    const t = open(raw, () => new Promise<void>(() => {}), { deletionHookTimeoutMs: 50 });
    await t.wiki.setup();
    const start = Date.now();
    await t.wiki.drain();
    expect(Date.now() - start).toBeLessThan(5000);
    expect(t.calls).toHaveLength(1);
    expect(pend(t.diags)).toHaveLength(1);
  });

  it('runPendingMaintenance runs externalDeletions first, for wiped entities too, honors jobs and deadlineMs, and reports the counts', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    await raw.runAsync(`INSERT INTO ${P}vector_removals (entity_id, fact_id, enqueued_at) VALUES ('wiped', 'w1', 1)`);
    const t = open(raw, () => {}, { drainExternalDeletionsOnSetup: false });
    await t.wiki.setup();
    const skipped = await t.wiki.runPendingMaintenance({ jobs: ['heal'] });
    expect(skipped.externalDeletions).toEqual({ confirmed: 0, pending: 2 });
    expect(t.calls).toEqual([]);
    const only = await t.wiki.runPendingMaintenance({ entityIds: ['wiped'], jobs: ['externalDeletions'] });
    expect(only.externalDeletions).toEqual({ confirmed: 1, pending: 0 });
    expect(t.calls.map((c) => c.factId)).toEqual(['w1']);
    const all = await t.wiki.runPendingMaintenance();
    expect(all.externalDeletions).toEqual({ confirmed: 1, pending: 0 });
    expect(await pendingRows(raw)).toEqual([]);
  });

  it('runPendingMaintenance honors deadlineMs for removals', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a', 'b', 'c']);
    const t = open(raw, () => new Promise((r) => setTimeout(r, 40)), { drainExternalDeletionsOnSetup: false });
    await t.wiki.setup();
    const r = await t.wiki.runPendingMaintenance({ deadlineMs: 50 });
    expect(r.externalDeletions.confirmed).toBeLessThan(3);
    expect(r.externalDeletions.pending).toBeGreaterThan(0);
  });

  it('getPendingMaintenance lists an entity whose only work is removals', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a', 'b']);
    const t = open(raw, () => {}, { drainExternalDeletionsOnSetup: false });
    await t.wiki.setup();
    const p = await t.wiki.getPendingMaintenance();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ entityId: 'e1', pendingEvents: 0, healDue: false, pendingExternalDeletions: 2 });
    expect(await t.wiki.getPendingExternalDeletions('e1')).toMatchObject({ count: 2 });
    expect(await t.wiki.getPendingExternalDeletions('zz')).toMatchObject({ count: 0 });
  });

  it("setup({ migrations: 'refuse' }) does not throw for the new schema objects", async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await expect(open(raw, () => {}).wiki.setup({ migrations: 'refuse' })).resolves.toBeUndefined();
  });

  it('a hookless runPendingMaintenance leaves the ledger unchanged', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    const before = await raw.getAllAsync(`SELECT * FROM ${P}vector_removals`);
    const t = open(raw);
    await t.wiki.setup();
    const r = await t.wiki.runPendingMaintenance();
    expect(r.externalDeletions).toEqual({ confirmed: 0, pending: 1 });
    expect(await raw.getAllAsync(`SELECT * FROM ${P}vector_removals`)).toEqual(before);
  });

  it('hookless store: getPendingMaintenance is empty after runPendingMaintenance', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    const t = open(raw);
    await t.wiki.setup();
    const r = await t.wiki.runPendingMaintenance();
    expect(r.perEntity).toEqual([]);
    expect(await t.wiki.getPendingMaintenance()).toEqual([]);
  });

  it('runPendingMaintenance awaits the in-flight setup drain; a second setup reuses it', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    const t = open(raw, () => new Promise<void>((r) => setTimeout(r, 80)));
    const svc = (t.wiki as any).vectorRemovalService;
    const orig = svc.drain.bind(svc);
    let allDrains = 0;
    svc.drain = (scope: any, o: any) => { if ('all' in scope) allDrains++; return orig(scope, o); };
    await t.wiki.setup();
    await t.wiki.setup();
    await t.wiki.runPendingMaintenance({ jobs: ['librarian'] });
    expect(allDrains).toBe(1);
    expect(await pendingRows(raw)).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it('force: the setup drain discards pending rows and emits external_deletion_discarded', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    const t = open(raw, () => {}, { forceDeleteIgnoreRankerHook: true });
    await t.wiki.setup();
    await t.wiki.drain();
    expect(t.calls).toEqual([]);
    expect(await pendingRows(raw)).toEqual([]);
    expect(t.diags.filter((d) => d.code === 'external_deletion_discarded')).toHaveLength(1);
  });

  it('the setup drain starts with a 10 s deadline and backoff', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    const t = open(raw, () => {});
    const svc = (t.wiki as any).vectorRemovalService;
    const orig = svc.drain.bind(svc);
    const seen: any[] = [];
    svc.drain = (scope: any, o: any) => { seen.push({ scope, o, now: Date.now() }); return orig(scope, o); };
    await t.wiki.setup();
    await t.wiki.drain();
    expect(seen[0].scope).toEqual({ all: true });
    expect(seen[0].o.backoff).toBe(true);
    expect(Math.abs(seen[0].o.deadlineAt - seen[0].now - 10_000)).toBeLessThan(1000);
  });

  it('externalDeletions runs before the librarian', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    const order: string[] = [];
    const t = open(raw, () => { order.push('hook'); }, {
      drainExternalDeletionsOnSetup: false,
      llmProvider: { generateText: async () => { order.push('llm'); return JSON.stringify({ facts: [] }); } },
      config: { maintenance: 'deferred' },
    });
    await t.wiki.setup();
    await t.wiki.write('e1', { type: 'note', summary: 'hello world' } as any);
    await t.wiki.runPendingMaintenance();
    expect(order[0]).toBe('hook');
    expect(order).toContain('llm');
  });

  it('force: getPendingMaintenance lists the owed entity until runPendingMaintenance discards it', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a']);
    const t = open(raw, () => {}, { forceDeleteIgnoreRankerHook: true, drainExternalDeletionsOnSetup: false });
    await t.wiki.setup();
    expect((await t.wiki.getPendingMaintenance()).map((p) => p.entityId)).toEqual(['e1']);
    await t.wiki.runPendingMaintenance();
    expect(await t.wiki.getPendingMaintenance()).toEqual([]);
  });

  it('concurrent setup() calls start one drain and call each id once', async () => {
    const raw = openTestDatabase();
    await open(raw).wiki.setup();
    await seed(raw, ['a', 'b']);
    const t = open(raw, () => new Promise<void>((r) => setTimeout(r, 20)));
    const svc = (t.wiki as any).vectorRemovalService;
    const orig = svc.drain.bind(svc);
    let allDrains = 0;
    svc.drain = (scope: any, o: any) => { if ('all' in scope) allDrains++; return orig(scope, o); };
    await Promise.all([t.wiki.setup(), t.wiki.setup()]);
    await t.wiki.drain();
    expect(allDrains).toBe(1);
    expect(t.calls.map((c) => c.factId).sort()).toEqual(['a', 'b']);
  });
});
