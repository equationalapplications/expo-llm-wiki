/**
 * Spec import-clamp-created-at: importDump stores a future-dated event's
 * created_at at the current time, keeps the clamped events' order, and
 * reports the count in one `event_created_at_clamped` diagnostic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MemoryDump, WikiDiagnostic, WikiEvent } from '../src/types';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

const ENTITY = 'u';
const NOW = 1_800_000_000_000;
const FUTURE = 4_102_444_800_000; // 2100-01-01

const embed = async (t: string) => [t.length % 7, (t.charCodeAt(0) || 1) % 5, 1, 0.5];

function scriptedProvider() {
  const extractPrompts: string[] = [];
  const generateText = async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
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

function ev(id: string, created_at: number, summary = `summary of ${id}`): WikiEvent {
  return { id, entity_id: ENTITY, event_type: 'observation', summary, related_entry_id: null, created_at, occurred_at: 1_700_000_000_000 };
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

async function rows(db: ReturnType<typeof openTestDatabase>) {
  return db.getAllAsync<{ id: string; created_at: number; occurred_at: number | null }>(
    `SELECT id, created_at, occurred_at FROM llm_wiki_events WHERE entity_id = ? ORDER BY created_at, id`,
    [ENTITY],
  );
}

const clamped = (ds: WikiDiagnostic[]) => ds.filter((d) => d.code === 'event_created_at_clamped');

afterEach(() => vi.restoreAllMocks());

describe('importDump clamps future-dated event created_at', () => {
  it('stores a future event just after now and leaves past events and occurred_at alone', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki } = await mk();
    await wiki.importDump(dump([ev('evt_past', NOW - 5000), ev('evt_future', FUTURE)]));
    expect(await rows(db)).toEqual([
      { id: 'evt_past', created_at: NOW - 5000, occurred_at: 1_700_000_000_000 },
      { id: 'evt_future', created_at: NOW + 1, occurred_at: 1_700_000_000_000 },
    ]);
  });

  it('keeps the clamped events in (created_at, id) order with distinct timestamps', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki } = await mk();
    // Bundle order differs from (created_at, id) order on purpose.
    await wiki.importDump(dump([ev('evt_c', FUTURE + 2), ev('evt_b', FUTURE), ev('evt_a', FUTURE)]));
    expect((await rows(db)).map((r) => [r.id, r.created_at])).toEqual([
      ['evt_a', NOW + 1],
      ['evt_b', NOW + 2],
      ['evt_c', NOW + 3],
    ]);
  });

  it('reports the clamped count in one diagnostic, and none when nothing was clamped', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const a = await mk();
    await a.wiki.importDump(dump([ev('evt_1', FUTURE), ev('evt_2', FUTURE + 1), ev('evt_3', NOW - 1)]));
    const ds = clamped(a.diagnostics);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ severity: 'warn', operation: 'importDump', trigger: 'call', entityId: ENTITY, detail: { count: 2 } });

    const b = await mk();
    await b.wiki.importDump(dump([ev('evt_1', NOW - 1), ev('evt_2', NOW)]));
    expect(clamped(b.diagnostics)).toHaveLength(0);
  });

  it('in merge mode, a clamped event skipped as a duplicate is not counted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { wiki, diagnostics } = await mk();
    await wiki.importDump(dump([ev('evt_1', NOW - 10)]));
    await wiki.importDump(dump([ev('evt_1', FUTURE), ev('evt_2', FUTURE)]), { merge: true });
    const ds = clamped(diagnostics);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.detail).toEqual({ count: 1 });
  });

  it('a clamped event never ties with, or sorts before, an unclamped event at now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki } = await mk();
    await wiki.importDump(dump([ev('evt_z_first', NOW), ev('evt_a_second', NOW + 1)]));
    expect((await rows(db)).map((r) => r.id)).toEqual(['evt_z_first', 'evt_a_second']);
  });

  it('clamps numeric-string and Infinity created_at too', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki, diagnostics } = await mk();
    await wiki.importDump(dump([
      { ...ev('evt_str', 0), created_at: String(FUTURE) as unknown as number },
      ev('evt_inf', Infinity),
    ]));
    expect((await rows(db)).map((r) => [r.id, r.created_at])).toEqual([
      ['evt_str', NOW + 1],
      ['evt_inf', NOW + 2],
    ]);
    expect(clamped(diagnostics)[0]!.detail).toEqual({ count: 2 });
  });

  it('with an ops watermark already in the future, clamped events land after it and are extracted', async () => {
    // A store an older version left with a watermark at 2100: clamping to
    // now would put new imports behind it, never extracted.
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki, extractPrompts } = await mk();
    await wiki.importDump(dump([ev('evt_old', FUTURE)]));
    await db.runAsync(`UPDATE llm_wiki_events SET created_at = ? WHERE id = 'evt_old'`, [FUTURE]);
    await (wiki.__testAccess as any).metadataRepo.setLibrarianWatermark(ENTITY, { at: FUTURE, id: 'evt_old' }, db);
    await wiki.importDump(dump([ev('evt_new', FUTURE + 3_600_000, 'Synced again from the fast clock')]), { merge: true });
    expect((await rows(db)).find((r) => r.id === 'evt_new')!.created_at).toBe(FUTURE + 1);
    await wiki.runLibrarian(ENTITY);
    expect(extractPrompts.join('\n')).toContain('Synced again from the fast clock');
  });

  it('legacy history with no watermark is seeded before the import, so a clamped event is not skipped', async () => {
    // memory_checkpoint 1 covers one event dated 2100. The clamp stores the
    // new event at now + 1, before it; seeding at pass time would anchor on
    // offset 0, the new event, and skip it.
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki, extractPrompts } = await mk();
    await db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_old', ?, 'observation', 'covered by legacy', ?)`,
      [ENTITY, FUTURE],
    );
    await (wiki.__testAccess as any).metadataRepo.updateCheckpoint(ENTITY, { memory: 1 }, db);
    await wiki.importDump(dump([ev('evt_new', FUTURE + 5, 'New import from the fast clock')]), { merge: true });
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark(ENTITY, db)).toEqual({ at: FUTURE, id: 'evt_old' });
    expect((await rows(db)).find((r) => r.id === 'evt_new')!.created_at).toBe(FUTURE + 1);
    await wiki.runLibrarian(ENTITY);
    expect(extractPrompts.join('\n')).toContain('New import from the fast clock');
    expect(extractPrompts.join('\n')).not.toContain('covered by legacy');
  });

  it('under ops, writes after a future-dated import are still extracted', async () => {
    // Without the clamp the watermark lands on 2100 after the first pass, and
    // every later write (stamped with the real clock) sorts behind it.
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { wiki, extractPrompts } = await mk();
    await wiki.importDump(dump([ev('evt_future', FUTURE, 'Imported note from a fast clock')]));
    await wiki.runLibrarian(ENTITY);
    await wiki.write(ENTITY, { event_type: 'observation', summary: 'Written after the import' });
    await wiki.runLibrarian(ENTITY);
    expect(extractPrompts.join('\n')).toContain('Written after the import');
  });
});
