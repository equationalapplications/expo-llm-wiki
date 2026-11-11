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
  it('stores a future event at now and leaves past events and occurred_at alone', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki } = await mk();
    await wiki.importDump(dump([ev('evt_past', NOW - 5000), ev('evt_future', FUTURE)]));
    expect(await rows(db)).toEqual([
      { id: 'evt_past', created_at: NOW - 5000, occurred_at: 1_700_000_000_000 },
      { id: 'evt_future', created_at: NOW, occurred_at: 1_700_000_000_000 },
    ]);
  });

  it('keeps the clamped events in (created_at, id) order with distinct timestamps', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, wiki } = await mk();
    // Bundle order differs from (created_at, id) order on purpose.
    await wiki.importDump(dump([ev('evt_c', FUTURE + 2), ev('evt_b', FUTURE), ev('evt_a', FUTURE)]));
    expect((await rows(db)).map((r) => [r.id, r.created_at])).toEqual([
      ['evt_a', NOW],
      ['evt_b', NOW + 1],
      ['evt_c', NOW + 2],
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
