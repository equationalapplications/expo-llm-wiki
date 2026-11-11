/**
 * Spec import-followups §3 (#365): importing the same id-less OKF log again
 * is a no-op while the earlier events are stored.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OkfFile } from '@equationalapplications/core-okf';
import type { MemoryDump, WikiDiagnostic } from '../src/types';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';

const NOW = 1_800_000_000_000; // 2027
const LOG = '## 2023-03-01\n\n- (observation) Bought a bike\n- (decision) Ride to work\n- (observation) Bought a bike\n';
const files = (entityId: string, log = LOG): OkfFile[] => [{ path: `entities/${entityId}/log.md`, content: log }];

const embed = async (t: string) => [t.length % 7, (t.charCodeAt(0) || 1) % 5, 1, 0.5];

async function mk() {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
    if (/memory extraction agent/.test(systemPrompt)) {
      const facts = [...userPrompt.matchAll(/^(e\d+) \[[^\]]+\] \([^)]+\) (.*)$/gm)].map((m) => ({
        title: m[2]!.slice(0, 60), body: m[2]!, tags: [], confidence: 'certain', source_event: m[1],
      }));
      return JSON.stringify({ facts, tasks: [] });
    }
    if (/reconciliation agent/.test(systemPrompt)) {
      const items = (JSON.parse(userPrompt.slice(userPrompt.indexOf('{'))) as { items: Array<{ item: number }> }).items;
      return JSON.stringify({ ops: items.map((i) => ({ item: i.item, op: 'ADD' })) });
    }
    return JSON.stringify({ facts: [], tasks: [] });
  });
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText, embed },
    config: { librarian: { strategy: 'ops' }, maintenance: 'deferred', autoLibrarianThreshold: 1000 },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  await wiki.setup();
  const events = (entityId = 'u') =>
    db.getAllAsync<{ id: string; summary: string }>(`SELECT id, summary FROM llm_wiki_events WHERE entity_id = ? ORDER BY id`, [entityId]);
  const importLog = (entityId = 'u', log = LOG) => wiki.importDump(parseOkfBundle(entityId, files(entityId, log)), { merge: true });
  return { db, wiki, diagnostics, generateText, events, importLog };
}

const restamped = (ds: WikiDiagnostic[]) => ds.filter((d) => d.code === 'event_created_at_restamped');

afterEach(() => vi.restoreAllMocks());

describe('re-importing an id-less OKF log', () => {
  it('a second merge import adds no events (fails on main)', async () => {
    const { events, importLog } = await mk();
    await importLog();
    const first = await events();
    expect(first).toHaveLength(3);
    await importLog();
    expect(await events()).toEqual(first);
  });

  it('behind a librarian watermark, the second import re-dates nothing and the next pass makes no model call', async () => {
    let t = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    const { wiki, diagnostics, generateText, importLog } = await mk();
    await wiki.write('u', { event_type: 'observation', summary: 'Local note' });
    await wiki.runLibrarian('u');
    await importLog();
    expect(restamped(diagnostics)).toHaveLength(1);
    await wiki.runLibrarian('u');
    diagnostics.length = 0;
    generateText.mockClear();
    await importLog();
    expect(restamped(diagnostics)).toHaveLength(0);
    await wiki.runLibrarian('u');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('the same log imported into two entities gives each its own events', async () => {
    const { events, importLog } = await mk();
    await importLog('A');
    await importLog('B');
    const a = await events('A');
    const b = await events('B');
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(a.map((e) => e.id).filter((id) => b.some((x) => x.id === id))).toEqual([]);
  });

  it('an export carries every derived id as an id comment, and parsing it returns the same ids', async () => {
    const { wiki, events, importLog } = await mk();
    await importLog();
    const ids = (await events()).map((e) => e.id).sort();
    const exported = formatOkfBundle(await wiki.exportDump(['u'])).files;
    const log = exported.find((f) => f.path.endsWith('/log.md'))!.content;
    const lines = log.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/<!-- id: evt_okf1_[0-9a-f]{32} -->$/);
    expect(parseOkfBundle('u', exported).entities.u.events.map((e) => e.id).sort()).toEqual(ids);
  });

  it('a line hand-added to an exported log, identical to an exported line, is stored (rev 2)', async () => {
    const { wiki, events, importLog } = await mk();
    await importLog();
    const exported = formatOkfBundle(await wiki.exportDump(['u'])).files.find((f) => f.path.endsWith('/log.md'))!.content;
    const edited = exported.replace(/(## 2023-03-01\n\n)/, '$1- (decision) Ride to work\n');
    expect(edited).not.toBe(exported);
    await importLog('u', edited);
    expect(await events()).toHaveLength(4);
    await importLog('u', edited);
    expect(await events()).toHaveLength(4);
  });

  it('accepted (§3.5 case 1): a row stored under a random id gets one duplicate, then no more', async () => {
    const { wiki, events, importLog } = await mk();
    const legacy: MemoryDump = {
      generatedAt: NOW,
      entities: { u: { facts: [], tasks: [], edges: [], events: [
        { id: 'evt_randomlegacy', entity_id: 'u', event_type: 'decision', summary: 'Ride to work', related_entry_id: null, created_at: Date.parse('2023-03-01') },
      ] } },
    };
    await wiki.importDump(legacy, { merge: true });
    await importLog();
    expect(await events()).toHaveLength(4);
    await importLog();
    expect(await events()).toHaveLength(4);
  });

  it('accepted (limit): after the consolidated events are pruned, importing again stores them again', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { wiki, events, importLog } = await mk();
    await importLog();
    await wiki.runLibrarian('u');
    const pruned = await wiki.runPrune('u', { retainEventsFor: 30 });
    expect(pruned.events).toBe(3);
    expect(await events()).toHaveLength(0);
    await importLog();
    expect(await events()).toHaveLength(3);
  });
});
