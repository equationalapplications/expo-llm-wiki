import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../../../../src/WikiMemory';
import { selectBatch, runExtract } from '../../../../src/services/librarian/ops/extract';
import { UsageMeter, WikiBudgetExhausted } from '../../../../src/utils/usage';
import { openTestDatabase } from '../../../helpers/sqliteAdapter';

type P = { systemPrompt: string; userPrompt: string };
const eventCount = (p: P) => (p.userPrompt.match(/^e\d+(#\d+)? \[/gm) ?? []).length;
const fact = (title: string, source: string) => ({ title, body: 'b', tags: [], confidence: 'certain', source_event: source });

async function mk(generateText: (p: P) => Promise<string>, onDiagnostic?: (d: any) => void, extraConfig: Record<string, unknown> = {}) {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { ...(onDiagnostic ? { onDiagnostic } : {}), llmProvider: { generateText: vi.fn(generateText) }, config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' }, ...extraConfig } } as any);
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
    // >2x the window: needs recursive halving (7500 chars -> 4 segments of ~1875; 6 calls, within MAX_SEGMENT_CALLS)
    await ev('evt_1', 10, 'word '.repeat(1500));
    const sel: any = await selectBatch(deps, 'u', null);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    expect(out.candidates.map((c) => c.sourceLabel)).toEqual([
      'e1#1.1', 'e1#1.2', 'e1#2.1', 'e1#2.2',
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

  it('skips an event only partly extractable (one segment skipped, sibling extracted) and advances past it, never throwing', async () => {
    const diags: any[] = [];
    const { wiki, ev } = await mk(async (p) => {
      if (/\bb b\b/.test(p.userPrompt)) throw tooLong();
      return JSON.stringify({ facts: labelsOf(p).map((l) => fact(`Fact from ${l} here`, l)), tasks: [] });
    }, (d) => diags.push(d));
    await ev('evt_1', 10, 'fine summary');
    // Halves at ~900 chars: the 'a' half extracts, the half carrying 'b's overflows and is below 2x floor.
    await ev('evt_2', 20, 'a '.repeat(600) + 'b '.repeat(300));
    await ev('evt_3', 30, 'later summary');
    const wm = () => (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u');
    // Pass 1: the whole event is skipped with a diagnostic, its extracted segment dropped.
    await wiki.runLibrarian('u');
    const skips = diags.filter((d) => d.code === 'context_overflow_skipped');
    expect(skips).toHaveLength(1);
    expect(skips[0].detail).toEqual({ sourceRef: 'evt_2' });
    expect(await wm()).toEqual({ at: 30, id: 'evt_3' });
    // Pass 2: nothing stalls; the watermark stays past the skipped event.
    await expect(wiki.runLibrarian('u')).resolves.not.toThrow();
    expect(await wm()).toEqual({ at: 30, id: 'evt_3' });
  });

  it('keeps grounding corpus aligned when a lone oversized event is skipped ahead of a normal one', async () => {
    const { deps, ev } = await mk(async (p) => {
      if (p.userPrompt.includes('POISON')) throw tooLong();
      return JSON.stringify({ facts: labelsOf(p).map((l) => fact(`Fact from ${l} here`, l)), tasks: [] });
    }, undefined, { grounding: { mode: 'draft', writers: ['librarian'] } });
    await ev('evt_1', 10, `POISON ${'word '.repeat(100)}`);
    await ev('evt_2', 20, 'normal second summary');
    const sel: any = await selectBatch(deps, 'u', null);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    expect(out.batch.map((l) => l.event.id)).toEqual(['evt_1', 'evt_2']);
    expect(out.candidates).toHaveLength(1);
    const c = out.candidates[0];
    expect(c.sourceEventId).toBe('evt_2');
    expect(out.groundingCorpus).not.toBeNull();
    expect(out.groundingCorpus![c.sourcePartIndex!]).toContain('normal second summary');
  });

  it('throws and holds the watermark when the fixed prompt part alone overflows (every event skipped)', async () => {
    let calls = 0;
    const { wiki, ev } = await mk(async () => { calls++; throw tooLong(); });
    await ev('evt_1', 10, 'word '.repeat(100));
    await ev('evt_2', 20, 'other words');
    await expect(wiki.runLibrarian('u')).rejects.toThrow(/minimal-prompt probe also overflowed/);
    expect(calls).toBe(2); // initial batch call + probe, before any retry tree
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toBeNull();
  });

  it('a lone moderately oversized event (below-floor segments) is skipped via a succeeding probe and the watermark advances', async () => {
    const diags: any[] = [];
    const { wiki, ev } = await mk(async (p) => {
      if (p.userPrompt.includes('POISON')) throw tooLong();
      return JSON.stringify({ facts: [], tasks: [] });
    }, (d) => diags.push(d));
    await ev('evt_1', 10, `POISON ${'word '.repeat(119)}`); // ~600 chars: halves fall below the 500 floor
    const wm = () => (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u');
    await expect(wiki.runLibrarian('u')).resolves.not.toThrow();
    expect(diags.filter((d) => d.code === 'context_overflow_skipped')).toHaveLength(1);
    expect(await wm()).toEqual({ at: 10, id: 'evt_1' });
    await expect(wiki.runLibrarian('u')).resolves.not.toThrow();
    expect(await wm()).toEqual({ at: 10, id: 'evt_1' });
  });

  it('caps segment fan-out: a huge event makes at most MAX_SEGMENT_CALLS segment calls, is skipped with a diagnostic, watermark advances', async () => {
    const diags: any[] = [];
    let poisonCalls = 0;
    const { wiki, ev } = await mk(async (p) => {
      if (p.userPrompt.includes('POISON')) { poisonCalls++; throw tooLong(); }
      return JSON.stringify({ facts: [], tasks: [] });
    }, (d) => diags.push(d));
    await ev('evt_1', 10, 'POISON '.repeat(3000)); // many floor-length segments if uncapped
    const wm = () => (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u');
    await expect(wiki.runLibrarian('u')).resolves.not.toThrow();
    expect(poisonCalls).toBeLessThanOrEqual(1 + 8); // initial whole-event call + capped segment calls
    expect(diags.filter((d) => d.code === 'context_overflow_skipped')).toHaveLength(1);
    expect(await wm()).toEqual({ at: 10, id: 'evt_1' });
  });

  it('the early probe is metered: an exhausted budget surfaces WikiBudgetExhausted at the first overflow, before any retry work', async () => {
    const meter = new UsageMeter(1_000_000);
    let calls = 0;
    const { deps, ev } = await mk(async (p) => {
      calls++;
      if (p.userPrompt.includes('POISON')) { meter.used = 1_000_000; throw tooLong(); }
      return JSON.stringify({ facts: [], tasks: [] });
    });
    await ev('evt_1', 10, `POISON ${'word '.repeat(119)}`);
    const ctx: any = { entityId: 'u', trigger: 'call', meter };
    const sel: any = await selectBatch(deps, 'u', null);
    await expect(runExtract(deps, ctx, sel.batch ?? sel)).rejects.toThrow(WikiBudgetExhausted);
    // calls === 1 only because callLlm's PRE-CALL budget check (llmCall.ts) throws
    // before reaching the provider; if that check ever moved after the provider call,
    // calls would become 2 and this assertion would catch the move.
    expect(calls).toBe(1);
  });

  it('the early probe runs exactly once per run across the whole retry tree', async () => {
    let probeCalls = 0;
    const { deps, ev } = await mk(async (p) => {
      // The probe is the lone event with summary 'x'; every other multi-event call overflows.
      // Line format pinned by PromptService.buildOpsExtractPrompt:
      // `${label} [ISO] (event_type) ${summary}`.
      if (/^e\d+ \[[^\]]*\] \(\w+\) x$/m.test(p.userPrompt)) {
        probeCalls++;
        return JSON.stringify({ facts: [], tasks: [] });
      }
      if (eventCount(p) > 1) throw tooLong();
      return JSON.stringify({ facts: labelsOf(p).map((l) => fact(`Fact from ${l} here`, l)), tasks: [] });
    });
    for (let i = 1; i <= 5; i++) await ev(`evt_${i}`, i * 10, `summary ${i}`);
    const sel: any = await selectBatch(deps, 'u', null);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    expect(probeCalls).toBe(1);
    expect(out.batch.map((l) => l.event.id)).toEqual(['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5']);
    expect(out.skippedEvents).toBe(0);
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
