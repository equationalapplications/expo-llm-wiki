/**
 * Spec import-past-dated-events: a merge import re-dates events that would
 * sort behind the librarian position, and events with an unusable
 * created_at, reporting them in `event_created_at_restamped`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MemoryDump, WikiDiagnostic, WikiEvent } from '../src/types';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

const ENTITY = 'u';
const NOW = 1_800_000_000_000;
const FUTURE = 4_102_444_800_000; // 2100-01-01
const PAST = 1_680_000_000_000; // 2023

const embed = async (t: string) => [t.length % 7, (t.charCodeAt(0) || 1) % 5, 1, 0.5];

function scriptedProvider() {
  const extractPrompts: string[] = [];
  const generateText = async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
    if (/knowledge extraction agent/.test(systemPrompt)) {
      extractPrompts.push(userPrompt);
      return JSON.stringify({ facts: [], tasks: [] });
    }
    if (/memory extraction agent/.test(systemPrompt)) {
      extractPrompts.push(userPrompt);
      const facts = [...userPrompt.matchAll(/^(e\d+) \[[^\]]+\] \([^)]+\) (.*)$/gm)].map((m) => ({
        title: m[2]!.slice(0, 60), body: m[2]!, tags: [], confidence: 'certain', source_event: m[1],
      }));
      return JSON.stringify({ facts, tasks: [] });
    }
    if (/reconciliation agent/.test(systemPrompt)) {
      const items = (JSON.parse(userPrompt.slice(userPrompt.indexOf('{'))) as { items: Array<{ item: number }> }).items;
      return JSON.stringify({ ops: items.map((i) => ({ item: i.item, op: 'ADD' })) });
    }
    return '{}';
  };
  return { extractPrompts, generateText };
}

function ev(id: string, created_at: unknown, summary = `summary of ${id}`): WikiEvent {
  return { id, entity_id: ENTITY, event_type: 'observation', summary, related_entry_id: null, created_at: created_at as number, occurred_at: 1_700_000_000_000 };
}

function dump(events: WikiEvent[]): MemoryDump {
  return { generatedAt: NOW, entities: { [ENTITY]: { facts: [], tasks: [], events, edges: [] } } };
}

async function mk(config: Record<string, unknown> = {}) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const s = scriptedProvider();
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: s.generateText, embed },
    config: { librarian: { strategy: 'ops' }, maintenance: 'deferred', ...config },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  await wiki.setup();
  return { db, wiki, diagnostics, ...s };
}

type Db = ReturnType<typeof openTestDatabase>;
const rows = (db: Db) =>
  db.getAllAsync<{ id: string; created_at: number; occurred_at: number | null }>(
    `SELECT id, created_at, occurred_at FROM llm_wiki_events WHERE entity_id = ? ORDER BY created_at, id`,
    [ENTITY],
  );
const restamped = (ds: WikiDiagnostic[]) => ds.filter((d) => d.code === 'event_created_at_restamped');

async function writeMany(wiki: WikiMemory, n: number) {
  for (let i = 0; i < n; i++) await wiki.write(ENTITY, { event_type: 'observation', summary: `Local note number ${i}` });
}

afterEach(() => vi.restoreAllMocks());

describe('importDump re-dates events behind the librarian position', () => {
  it('ops + deferred: a past-dated merge import is extracted next pass and not pruned', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { wiki, extractPrompts, diagnostics } = await mk();
    await writeMany(wiki, 60);
    await wiki.runLibrarian(ENTITY);
    await wiki.runLibrarian(ENTITY);
    await wiki.importDump(dump([ev('evt_past', PAST, 'Imported note from 2023')]), { merge: true });
    expect(restamped(diagnostics)).toHaveLength(1);
    await wiki.runLibrarian(ENTITY);
    expect(extractPrompts.join('\n')).toContain('Imported note from 2023');
    const pruned = await wiki.runPrune(ENTITY, { retainEventsFor: 30 });
    expect(pruned.events).toBe(0);
  });

  it('legacy + deferred: the legacy prompt contains the import', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { wiki, extractPrompts } = await mk({ librarian: { strategy: 'legacy' } });
    await writeMany(wiki, 20);
    await wiki.runLibrarian(ENTITY);
    await wiki.importDump(dump([ev('evt_past', PAST, 'Legacy import from 2023')]), { merge: true });
    await wiki.runLibrarian(ENTITY);
    expect(extractPrompts.join('\n')).toContain('Legacy import from 2023');
  });

  it('past, future and invalid events are stored consecutively from floor + 1 in run order', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    const local = (await rows(db))[0]!;
    const floor = Math.max(NOW, local.created_at);
    await wiki.importDump(dump([
      ev('f1', FUTURE), ev('p2', PAST + 1), ev('p1', PAST), ev('i2', 'x'), ev('i1', null),
    ]), { merge: true });
    const stored = (await rows(db)).filter((r) => r.id !== local.id);
    expect(stored.map((r) => [r.id, r.created_at])).toEqual([
      ['i1', floor + 1], ['i2', floor + 2], ['p1', floor + 3], ['p2', floor + 4], ['f1', floor + 5],
    ]);
  });

  it('merge: false re-dates only future and invalid events', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki, diagnostics } = await mk();
    await wiki.importDump(dump([ev('past', PAST), ev('future', FUTURE), ev('bad', 'x')]));
    const byId = Object.fromEntries((await rows(db)).map((r) => [r.id, r.created_at]));
    expect(byId.past).toBe(PAST);
    expect(byId.future).toBeGreaterThan(NOW);
    expect(byId.bad).toBeGreaterThan(NOW);
    expect(restamped(diagnostics).map((d) => d.detail)).toEqual([{ count: 1, reason: 'invalid' }]);
  });

  it('an event after the local watermark and before now is unchanged', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { db, wiki, diagnostics } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    const at = NOW + 5; // after the librarian position, before the mocked clock
    t = NOW + 1000;
    await wiki.importDump(dump([ev('evt_mid', at + 100)]), { merge: true });
    expect((await rows(db)).find((r) => r.id === 'evt_mid')!.created_at).toBe(at + 100);
    expect(restamped(diagnostics)).toHaveLength(0);
  });

  it('stores invalid values as real numbers, and runLibrarian does not throw', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki } = await mk();
    await wiki.importDump(dump([ev('a', 'abc'), ev('b', NaN), ev('c', null), ev('d', {})]));
    for (const r of await rows(db)) expect(Number.isFinite(r.created_at)).toBe(true);
    await wiki.runLibrarian(ENTITY);
  });

  it('emits one restamped per non-zero reason with the right count', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { wiki, diagnostics } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    await wiki.importDump(dump([ev('p1', PAST), ev('p2', PAST + 1), ev('p3', PAST + 2), ev('i1', 'x'), ev('f1', FUTURE)]), { merge: true });
    const ds = restamped(diagnostics);
    expect(ds.map((d) => d.detail)).toEqual([
      { count: 3, reason: 'behind_watermark' },
      { count: 1, reason: 'invalid' },
    ]);
    expect(ds[0]).toMatchObject({ severity: 'info', operation: 'importDump', trigger: 'call', entityId: ENTITY });
  });

  it('a repeated identical merge import emits no restamped', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { wiki, diagnostics } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    const d = dump([ev('p1', PAST)]);
    await wiki.importDump(d, { merge: true });
    expect(restamped(diagnostics)).toHaveLength(1);
    await wiki.importDump(d, { merge: true });
    expect(restamped(diagnostics)).toHaveLength(1);
  });

  it('the same id twice in a bundle is counted once', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { wiki, diagnostics } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    await wiki.importDump(dump([ev('dup', PAST), ev('dup', PAST)]), { merge: true });
    expect(restamped(diagnostics).map((d) => d.detail)).toEqual([{ count: 1, reason: 'behind_watermark' }]);
  });

  it('a decimal-string created_at behind the watermark is re-stamped and occurred_at holds the number', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { db, wiki } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    const e = { ...ev('str', String(PAST)), occurred_at: null } as unknown as WikiEvent;
    await wiki.importDump(dump([e]), { merge: true });
    const r = (await rows(db)).find((x) => x.id === 'str')!;
    expect(r.created_at).toBeGreaterThan(NOW);
    expect(r.occurred_at).toBe(PAST);
  });

  it('a combined run that throws RangeError stores nothing and emits nothing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki, diagnostics } = await mk();
    await (wiki.__testAccess as any).metadataRepo.setLibrarianWatermark(ENTITY, { at: Number.MAX_SAFE_INTEGER, id: 'evt_old' }, db);
    await expect(wiki.importDump(dump([ev('a', PAST), ev('b', 'x')]), { merge: true })).rejects.toThrow(RangeError);
    expect(await rows(db)).toEqual([]);
    expect(diagnostics.filter((d) => /created_at/.test(d.code))).toEqual([]);
  });
});
