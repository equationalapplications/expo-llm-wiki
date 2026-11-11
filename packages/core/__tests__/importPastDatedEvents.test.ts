/**
 * Spec import-past-dated-events: a merge import re-dates events that would
 * sort behind the librarian position, and events with an unusable
 * created_at, reporting them in `event_created_at_restamped`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MemoryDump, WikiDiagnostic, WikiEvent } from '../src/types';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';
import { START_OF_LOG_WATERMARK } from '../src/repositories/MetadataRepository';

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

  it('stores hex text, -Infinity and huge negatives as finite numbers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki } = await mk();
    const bad: unknown[] = ['0x10', -Infinity, -9e15, -1e300, true];
    await wiki.importDump(dump(bad.map((v, i) => ev(`b${i}`, v))));
    const stored = await rows(db);
    expect(stored).toHaveLength(bad.length);
    for (const r of stored) expect(Number.isFinite(r.created_at)).toBe(true);
    await wiki.runLibrarian(ENTITY);
  });

  it('legacy history: the seed lands before insert, the import is read next pass, old events are not re-read', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { db, wiki, extractPrompts } = await mk();
    await writeMany(wiki, 5);
    await wiki.runLibrarian(ENTITY);
    // Legacy history: a checkpoint from before watermarks, no watermark.
    await db.runAsync(
      `UPDATE llm_wiki_checkpoints SET memory_checkpoint = 5, librarian_watermark_at = NULL, librarian_watermark_id = NULL WHERE entity_id = ?`,
      [ENTITY],
    );
    expect(await wmOf(wiki, db)).toBeNull();
    const before = extractPrompts.length;
    await wiki.importDump(dump([ev('evt_past', PAST, 'Legacy seeded import')]), { merge: true });
    const wm = await wmOf(wiki, db);
    expect(wm).not.toBeNull();
    const row = (await rows(db)).find((r) => r.id === 'evt_past')!;
    expect(row.created_at).toBeGreaterThan(wm.at);
    await wiki.runLibrarian(ENTITY);
    const fresh = extractPrompts.slice(before).join('\n');
    const lines = fresh.split('\n').filter((l) => /^e\d+ \[/.test(l));
    expect(lines.some((l) => l.includes('Legacy seeded import'))).toBe(true);
    expect(lines.some((l) => l.includes('Local note number'))).toBe(false);
  });

  it('an invalid occurred_at is stored NULL and counted once as invalid', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { db, wiki, diagnostics } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    const at = NOW + 5;
    t = NOW + 1000;
    const e = { ...ev('badocc', at + 100), occurred_at: 'abc' as unknown as number };
    await wiki.importDump(dump([e]), { merge: true });
    const r = (await rows(db)).find((x) => x.id === 'badocc')!;
    expect(r.created_at).toBe(at + 100);
    expect(r.occurred_at).toBeNull();
    expect(restamped(diagnostics).map((d) => d.detail)).toEqual([{ count: 1, reason: 'invalid' }]);
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

const wmOf = (wiki: WikiMemory, db: Db) => (wiki as any).metadataRepo.getLibrarianWatermark(ENTITY, db);
function withWm(d: MemoryDump, wm: unknown): MemoryDump {
  return { generatedAt: NOW, entities: { [ENTITY]: { ...d.entities[ENTITY]!, librarian_watermark: wm as { at: number; id: string } } } };
}
const clock = () => {
  let t = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
};

describe('bundles carry the source librarian watermark', () => {
  it('exportDump and getMemoryBundle carry it when set, omit it when not, and it survives JSON', async () => {
    clock();
    const { db, wiki } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'one' });
    expect((await wiki.exportDump()).entities[ENTITY]).not.toHaveProperty('librarian_watermark');
    expect(await wiki.getMemoryBundle(ENTITY)).not.toHaveProperty('librarian_watermark');
    await wiki.runLibrarian(ENTITY);
    const wm = await wmOf(wiki, db);
    expect(wm).not.toBeNull();
    const d = await wiki.exportDump();
    expect(d.entities[ENTITY]!.librarian_watermark).toEqual(wm);
    expect((await wiki.getMemoryBundle(ENTITY)).librarian_watermark).toEqual(wm);
    expect(JSON.parse(JSON.stringify(d)).entities[ENTITY].librarian_watermark).toEqual(wm);
  });

  it('a start-of-log marker survives export and a JSON round trip', async () => {
    clock();
    const { db, wiki } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'one' });
    await (wiki as any).metadataRepo.setLibrarianWatermark(ENTITY, START_OF_LOG_WATERMARK, db);
    const d = JSON.parse(JSON.stringify(await wiki.exportDump()));
    expect(d.entities[ENTITY].librarian_watermark).toEqual({ at: START_OF_LOG_WATERMARK.at, id: '' });
  });

  it('getFullBundle reads the watermark before the facts', async () => {
    clock();
    const { wiki } = await mk();
    const order: string[] = [];
    const m = (wiki as any).metadataRepo;
    const e = (wiki as any).entryRepo;
    const origWm = m.getLibrarianWatermark.bind(m);
    const origFacts = e.findAllByEntityId.bind(e);
    // The watermark read resolves only after a macrotask; the facts read
    // must not start before it has resolved (awaited, not just issued first).
    vi.spyOn(m, 'getLibrarianWatermark').mockImplementation(async (...a: unknown[]) => {
      order.push('wm-start');
      const r = await origWm(...a);
      await new Promise((res) => setTimeout(res, 0));
      order.push('wm-done');
      return r;
    });
    vi.spyOn(e, 'findAllByEntityId').mockImplementation(async (...a: unknown[]) => { order.push('facts'); return origFacts(...a); });
    await wiki.getMemoryBundle(ENTITY);
    expect(order.indexOf('wm-done')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('facts')).toBeGreaterThan(order.indexOf('wm-done'));
  });

  it.each([
    ['at as a string', { at: '5', id: 'x' }],
    ['at NaN', { at: NaN, id: 'x' }],
    ['at null', { at: null, id: 'x' }],
    ['id as a number', { at: 5, id: 7 }],
    ['the field null', null],
    ['an array', []],
  ])('a malformed watermark (%s) takes the fallback', async (_n, bad) => {
    clock();
    const { wiki, diagnostics } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    await wiki.importDump(withWm(dump([ev('p1', PAST)]), bad), { merge: true });
    expect(restamped(diagnostics).map((d) => d.detail)).toEqual([{ count: 1, reason: 'behind_watermark' }]);
  });

  it('device sync: events the source consolidated are neither re-stamped nor re-extracted', async () => {
    clock();
    const a = await mk();
    for (let i = 0; i < 5; i++) await a.wiki.write(ENTITY, { event_type: 'observation', summary: `Alpha device note ${i}` });
    await a.wiki.runLibrarian(ENTITY);
    const bundle = JSON.parse(JSON.stringify(await a.wiki.exportDump())) as MemoryDump;
    const aEvents = bundle.entities[ENTITY]!.events;
    expect(aEvents).toHaveLength(5);
    const b = await mk();
    await writeMany(b.wiki, 3);
    await b.wiki.runLibrarian(ENTITY);
    const bwm = await wmOf(b.wiki, b.db);
    expect(bwm.at).toBeGreaterThan(Math.max(...aEvents.map((e) => e.created_at)));
    await b.wiki.importDump(bundle, { merge: true });
    expect(restamped(b.diagnostics)).toHaveLength(0);
    const stored = await rows(b.db);
    for (const e of aEvents) expect(stored.find((r) => r.id === e.id)!.created_at).toBe(e.created_at);
    b.extractPrompts.length = 0;
    await b.wiki.runLibrarian(ENTITY);
    expect(b.extractPrompts.join('\n')).not.toContain('Alpha device note');
  });

  it('bounce: an event pruned on A comes back from B unchanged and is not re-extracted', async () => {
    clock();
    const a = await mk();
    await a.wiki.write(ENTITY, { event_type: 'observation', summary: 'Bounce event E' });
    await a.wiki.runLibrarian(ENTITY);
    const e = (await a.wiki.exportDump()).entities[ENTITY]!.events[0]!;
    const b = await mk();
    await b.wiki.importDump(JSON.parse(JSON.stringify(await a.wiki.exportDump())));
    await writeMany(b.wiki, 2);
    await b.wiki.runLibrarian(ENTITY);
    expect((await wmOf(b.wiki, b.db)).at).toBeGreaterThan(e.created_at);
    await a.db.runAsync(`DELETE FROM llm_wiki_events WHERE id = ?`, [e.id]);
    expect((await wmOf(a.wiki, a.db)).at).toBeGreaterThanOrEqual(e.created_at);
    expect((await rows(a.db)).find((r) => r.id === e.id)).toBeUndefined();
    await a.wiki.importDump(JSON.parse(JSON.stringify(await b.wiki.exportDump())), { merge: true });
    expect(restamped(a.diagnostics)).toHaveLength(0);
    expect((await rows(a.db)).find((r) => r.id === e.id)!.created_at).toBe(e.created_at);
    a.extractPrompts.length = 0;
    await a.wiki.runLibrarian(ENTITY);
    expect(a.extractPrompts.join('\n')).not.toContain('Bounce event E');
  });

  it('a source-consolidated event behind the local watermark keeps created_at and occurred_at', async () => {
    clock();
    const { db, wiki, diagnostics } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    const e = { ...ev('old', PAST), occurred_at: 99 };
    await wiki.importDump(withWm(dump([e]), { at: PAST + 100, id: '' }), { merge: true });
    const r = (await rows(db)).find((x) => x.id === 'old')!;
    expect([r.created_at, r.occurred_at]).toEqual([PAST, 99]);
    expect(restamped(diagnostics)).toHaveLength(0);
  });

  it('a source watermark with no local watermark re-stamps nothing', async () => {
    clock();
    const { db, wiki, diagnostics } = await mk();
    await wiki.importDump(withWm(dump([ev('old', PAST)]), { at: PAST + 100, id: '' }), { merge: true });
    expect((await rows(db))[0]!.created_at).toBe(PAST);
    expect(restamped(diagnostics)).toHaveLength(0);
  });

  it('a self round trip re-stamps nothing', async () => {
    clock();
    const { db, wiki, diagnostics } = await mk();
    await writeMany(wiki, 4);
    await wiki.runLibrarian(ENTITY);
    const before = await rows(db);
    await wiki.importDump(JSON.parse(JSON.stringify(await wiki.exportDump())), { merge: true });
    expect(restamped(diagnostics)).toHaveLength(0);
    expect(await rows(db)).toEqual(before);
  });

  it('a getMemoryBundle bundle classifies each of its 10 events correctly in a peer', async () => {
    clock();
    const a = await mk();
    await writeMany(a.wiki, 12);
    await a.wiki.runLibrarian(ENTITY);
    for (let i = 0; i < 3; i++) await a.wiki.write(ENTITY, { event_type: 'observation', summary: `Unread ${i}` });
    const bundle = JSON.parse(JSON.stringify(await a.wiki.getMemoryBundle(ENTITY))) as MemoryDump['entities'][string];
    expect(bundle.events).toHaveLength(10);
    const b = await mk();
    await writeMany(b.wiki, 2);
    await b.wiki.runLibrarian(ENTITY);
    await b.wiki.importDump({ generatedAt: NOW, entities: { [ENTITY]: bundle } }, { merge: true });
    // 3 events written after the source pass sort behind the peer's position; 7 were consolidated.
    expect(restamped(b.diagnostics).map((d) => d.detail)).toEqual([{ count: 3, reason: 'behind_watermark' }]);
  });

  it('a start-of-log source watermark makes every event behind the local watermark eligible', async () => {
    clock();
    const { wiki, diagnostics } = await mk();
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'local' });
    await wiki.runLibrarian(ENTITY);
    await wiki.importDump(withWm(dump([ev('p1', PAST), ev('p2', PAST + 1)]), { at: START_OF_LOG_WATERMARK.at, id: '' }), { merge: true });
    expect(restamped(diagnostics).map((d) => d.detail)).toEqual([{ count: 2, reason: 'behind_watermark' }]);
  });

  it('legacy: only the first 50 re-stamped events are read next pass (documented limit)', async () => {
    clock();
    const { wiki, extractPrompts } = await mk({ librarian: { strategy: 'legacy' } });
    await writeMany(wiki, 5);
    await wiki.runLibrarian(ENTITY);
    const events = Array.from({ length: 60 }, (_, i) => ev(`p${String(i).padStart(2, '0')}`, PAST + i, `Legacy bulk ${i}`));
    await wiki.importDump(dump(events), { merge: true });
    extractPrompts.length = 0;
    await wiki.runLibrarian(ENTITY);
    const prompt = extractPrompts.join('\n');
    const seen = events.filter((e) => new RegExp(`${e.summary}(?!\\d)`).test(prompt)).length;
    // Documented limit (spec §4): one legacy pass reads 50 events; the rest wait for the next.
    expect(seen).toBe(50);
  });
});

describe('OKF log entries are dated by real-world time', () => {
  const DAY = Math.floor(NOW / 86_400_000) * 86_400_000;

  it('formatOkfBundle dates an event by occurred_at when set', () => {
    const created = Date.UTC(2026, 10, 11, 9);
    const occurred = Date.UTC(2023, 0, 5, 9);
    const d = dump([{ ...ev('e1', created), occurred_at: occurred }]);
    const { files } = formatOkfBundle(d);
    const log = files.find((f) => /log\.md$/.test(f.path))!.content;
    expect(log).toContain('## 2023-01-05');
    expect(log).not.toContain('## 2026-11-11');
  });

  it('formatOkfBundle falls back to created_at for an unusable occurred_at', () => {
    const created = Date.UTC(2026, 10, 11, 9);
    const d = dump([
      { ...ev('e1', created), occurred_at: 'abc' as unknown as number },
      { ...ev('e2', created), occurred_at: 1e16 },
    ]);
    let log = '';
    expect(() => { log = formatOkfBundle(d).files.find((f) => /log\.md$/.test(f.path))!.content; }).not.toThrow();
    expect(log).toContain('## 2026-11-11');
  });

  it('formatOkfBundle dates a future occurred_at by created_at, so a re-import is not clamped as future', () => {
    const created = Date.UTC(2026, 10, 11, 9);
    const d = dump([{ ...ev('e1', created), occurred_at: created + 21 * 86_400_000 }]);
    const log = formatOkfBundle(d).files.find((f) => /log\.md$/.test(f.path))!.content;
    expect(log).toContain('## 2026-11-11');
    expect(log).not.toContain('## 2026-12-02');
  });

  it('formatOkfBundle falls back to created_at for an occurred_at outside years 0000-9999, so the entry parses back', () => {
    const created = Date.UTC(2026, 10, 11, 9);
    const micro = 1_700_000_000_000_000; // a microsecond epoch: a usable Date, but year ~55800
    const d = dump([{ ...ev('e1', created), occurred_at: micro }, { ...ev('e2', created), occurred_at: -8.64e15 }]);
    const log = formatOkfBundle(d).files.find((f) => /log\.md$/.test(f.path))!.content;
    expect(log).toContain('## 2026-11-11');
    expect(log).not.toMatch(/^## [+-]/m);
  });

  it('an OKF-parsed merge bundle behind the watermark is re-stamped and keeps its midnight date', async () => {
    let t = DAY + 5 * 3_600_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { db, wiki, extractPrompts, diagnostics } = await mk();
    await writeMany(wiki, 3);
    await wiki.runLibrarian(ENTITY);
    const source = dump([{ ...ev('okf_old', DAY, 'Okf imported note'), occurred_at: null }]);
    const parsed = parseOkfBundle(ENTITY, formatOkfBundle(source).files);
    const evt = parsed.entities[ENTITY]!.events[0]!;
    expect(evt.created_at).toBe(DAY);
    expect(evt.occurred_at ?? null).toBeNull();
    await wiki.importDump(parsed, { merge: true });
    expect(restamped(diagnostics)).toHaveLength(1);
    const row = (await rows(db)).find((r) => r.id === evt.id)!;
    expect(row.created_at).toBeGreaterThan(DAY + 5 * 3_600_000);
    expect(row.occurred_at).toBe(DAY);
    await wiki.runLibrarian(ENTITY);
    expect(extractPrompts.join('\n')).toContain('Okf imported note');
  });
});
