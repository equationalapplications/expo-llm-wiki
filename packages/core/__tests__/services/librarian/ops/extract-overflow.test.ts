import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../../../../src/WikiMemory';
import { selectBatch, runExtract } from '../../../../src/services/librarian/ops/extract';
import { openTestDatabase } from '../../../helpers/sqliteAdapter';

type P = { systemPrompt: string; userPrompt: string };
const eventCount = (p: P) => (p.userPrompt.match(/^e\d+(#\d+)? \[/gm) ?? []).length;
const fact = (title: string, source: string) => ({ title, body: 'b', tags: [], confidence: 'certain', source_event: source });

async function mk(generateText: (p: P) => Promise<string>, onDiagnostic?: (d: any) => void) {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { ...(onDiagnostic ? { onDiagnostic } : {}), llmProvider: { generateText: vi.fn(generateText) }, config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } } });
  await wiki.setup();
  const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();
  const ev = (id: string, at: number, summary: string) =>
    db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, 'u', 'observation', ?, ?)`, [id, summary, at]);
  return { db, wiki, deps, ev };
}

const tooLong = () => new Error('prompt is too long: 250000 tokens > 200000 maximum');
const labelsOf = (p: P) => [...p.userPrompt.matchAll(/^(e\d+) \[/gm)].map((m) => m[1]);

describe('ops extract overflow retry', () => {
  it('halves a multi-event batch on overflow and extracts all five events', async () => {
    const { deps, ev } = await mk(async (p) => {
      if (eventCount(p) > 2) throw tooLong();
      return JSON.stringify({ facts: labelsOf(p).map((l, i) => fact(`Fact from ${l} number ${p.userPrompt.length}${i}`, l)), tasks: [] });
    });
    for (let i = 1; i <= 5; i++) await ev(`evt_${i}`, i * 10, `summary ${i}`);
    const sel: any = await selectBatch(deps, 'u', null);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    expect(out.batch.map((l) => l.event.id)).toEqual(['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5']);
    expect(new Set(out.candidates.map((c) => c.sourceEventId))).toEqual(new Set(['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5']));
  });

  it('segments a lone oversized event into #1/#2 resolving to the same event id', async () => {
    const { deps, ev } = await mk(async (p) => {
      if (p.userPrompt.length > 3000) throw tooLong();
      const label = /^(e\d+(?:#[\d.]+)?) \[/m.exec(p.userPrompt)![1];
      return JSON.stringify({ facts: [fact(`Fact from ${label} here`, label)], tasks: [] });
    });
    // >2x the window: needs recursive halving (16000 chars -> 8 segments of ~2000)
    await ev('evt_1', 10, 'word '.repeat(3200));
    const sel: any = await selectBatch(deps, 'u', null);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    expect(out.candidates.map((c) => c.sourceLabel)).toEqual([
      'e1#1.1.1', 'e1#1.1.2', 'e1#1.2.1', 'e1#1.2.2', 'e1#2.1.1', 'e1#2.1.2', 'e1#2.2.1', 'e1#2.2.2',
    ]);
    expect(new Set(out.candidates.map((c) => c.sourceEventId))).toEqual(new Set(['evt_1']));
    expect(out.batch.map((l) => l.event.id)).toEqual(['evt_1']);
  });

  it('skips below the segment floor with a diagnostic, and the watermark still advances when other events were extracted', async () => {
    const diags: any[] = [];
    const { wiki, ev } = await mk(async (p) => {
      if (p.userPrompt.includes('POISON')) throw tooLong();
      return JSON.stringify({ facts: labelsOf(p).map((l) => fact(`Fact from ${l} here`, l)), tasks: [] });
    }, (d) => diags.push(d));
    await ev('evt_1', 10, 'fine summary');
    await ev('evt_2', 20, `POISON ${'word '.repeat(100)}`);
    await wiki.runLibrarian('u');
    expect(diags.filter((d) => d.code === 'context_overflow_skipped')).toHaveLength(1);
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toEqual({ at: 20, id: 'evt_2' });
  });

  it('throws and holds the watermark when the fixed prompt part alone overflows (every event skipped)', async () => {
    const { wiki, ev } = await mk(async () => { throw tooLong(); });
    await ev('evt_1', 10, 'word '.repeat(100));
    await ev('evt_2', 20, 'other words');
    await expect(wiki.runLibrarian('u')).rejects.toThrow(/skipped for context overflow/);
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toBeNull();
  });

  it('pass watermark follows the batch actually extracted', async () => {
    const { db, wiki, ev } = await mk(async (p) => {
      if (eventCount(p) > 2) throw tooLong();
      return JSON.stringify({ facts: labelsOf(p).map((l, i) => fact(`Distinct ${l} number ${p.userPrompt.length}${i}`, l)), tasks: [] });
    });
    for (let i = 1; i <= 5; i++) await ev(`evt_${i}`, i * 10, `summary ${i}`);
    await wiki.runLibrarian('u');
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toEqual({ at: 50, id: 'evt_5' });
    expect((await db.getAllAsync(`SELECT 1 FROM llm_wiki_entries`)).length).toBeGreaterThan(0);
  });
});
