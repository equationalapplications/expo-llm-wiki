import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { selectBatch, runExtract, OPS_MAX_EXTRACT_CHARS } from '../src/services/librarian/ops/extract';
import { UsageMeter } from '../src/utils/usage';
import { openTestDatabase } from './helpers/sqliteAdapter';

async function mk(generateText = vi.fn(async () => '{}')) {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText }, config: { autoLibrarianThreshold: 1000 } });
  await wiki.setup();
  const ms = wiki.__testAccess.maintenanceService as any;
  const deps = ms.librarianDeps();
  const ev = (id: string, at: number, summary = 's', occurred?: number) =>
    db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES (?, 'u', 'observation', ?, ?, ?)`, [id, summary, at, occurred ?? null]);
  return { db, deps, ev, generateText };
}

describe('selectBatch', () => {
  it('returns events after the watermark, oldest first, capped by chars', async () => {
    const { deps, ev } = await mk();
    await ev('evt_a', 10, 'x'.repeat(OPS_MAX_EXTRACT_CHARS - 5));
    await ev('evt_b', 20, 'y'.repeat(100));
    const r: any = await selectBatch(deps, 'u', null);
    expect(r.batch.map((l: any) => l.event.id)).toEqual(['evt_a']);
    const r2: any = await selectBatch(deps, 'u', { at: 10, id: 'evt_a' });
    expect(r2.batch.map((l: any) => l.event.id)).toEqual(['evt_b']);
  });
  it('shrinks to the budget and reports budget_too_small for one event', async () => {
    const { deps, ev } = await mk();
    await ev('evt_a', 10, 'x'.repeat(4000));
    const r: any = await selectBatch(deps, 'u', null, new UsageMeter(100));
    expect(r.budgetStop.requiredEstimate).toBeGreaterThan(2000);
  });
});

describe('runExtract', () => {
  it('validates facts, maps source_event, and defaults valid_from', async () => {
    const generateText = vi.fn(async () => JSON.stringify({
      facts: [
        { title: 'User moved to San Francisco', body: 'b', tags: [], confidence: 'certain', source_event: 'e2' },
        { title: 'User owns a cat named Mo', body: 'b', tags: [], confidence: 'certain', source_event: 'e9' },
        { title: 'User started a new job', body: 'b', tags: [], confidence: 'certain', source_event: 'e1', valid_from: '2026-02-01' },
        { title: '', body: 'invalid', tags: [], confidence: 'certain' },
      ],
      tasks: [{ description: 'Pack boxes', priority: 2 }],
    }));
    const { deps, ev } = await mk(generateText);
    await ev('evt_a', 10, 'job news', 7);
    await ev('evt_b', 20, 'moving news');
    const { batch }: any = await selectBatch(deps, 'u', null);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, batch);
    expect(out.candidates.map((c) => [c.fact.title, c.sourceLabel, c.validFrom])).toEqual([
      ['User moved to San Francisco', 'e2', 20],
      ['User owns a cat named Mo', null, 20],
      ['User started a new job', 'e1', Date.parse('2026-02-01')],
    ]);
    expect(out.tasks).toHaveLength(1);
    expect(out.diagnostics.map((d) => d.code)).toEqual(['fact_rejected']);
    expect(generateText.mock.calls[0][0].userPrompt).not.toContain('Current Facts');
  });
});
