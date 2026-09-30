import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { UsageMeter, estimateTokens } from '../src/utils/usage';

const noFacts = JSON.stringify({ facts: [], tasks: [] });

async function mk(opts: { generateText?: any; config?: Record<string, unknown> } = {}) {
  const db = openTestDatabase();
  const generateText = opts.generateText ?? vi.fn(async () => noFacts);
  const wiki = new WikiMemory(db, { llmProvider: { generateText }, config: { maintenance: 'deferred', librarian: { strategy: 'ops' }, ...opts.config } });
  await wiki.setup();
  return { db, wiki, generateText };
}

describe('runPendingMaintenance', () => {
  it('processes every pending entity and reports complete', async () => {
    const { wiki } = await mk();
    await wiki.write('a', { event_type: 'observation', summary: 'hello' });
    await wiki.write('b', { event_type: 'observation', summary: 'hi' });
    const r = await wiki.runPendingMaintenance();
    expect(r.stoppedReason).toEqual({ reason: 'complete' });
    expect(r.perEntity.map((e) => [e.entityId, e.librarianPasses])).toEqual([['a', 1], ['b', 1]]);
    expect(await wiki.getPendingMaintenance()).toEqual([]);
    expect(r.remaining).toBeNull();
  });

  it('fair share: one unit per entity per round', async () => {
    const order: string[] = [];
    const generateText = vi.fn(async ({ userPrompt }: { userPrompt: string }) => { order.push(userPrompt.includes('AAA') ? 'a' : 'b'); return noFacts; });
    const { wiki } = await mk({ generateText });
    // 120 events for a ⇒ 3 ops batches of ≤50; 1 event for b.
    for (let i = 0; i < 120; i++) await wiki.write('a', { event_type: 'observation', summary: `AAA ${i}` });
    await wiki.write('b', { event_type: 'observation', summary: 'BBB' });
    await wiki.runPendingMaintenance();
    expect(order.slice(0, 2)).toEqual(['a', 'b']);
    expect(order.filter((x) => x === 'a')).toHaveLength(3);
  });

  it('budget_too_small names the job and entity and does not loop', async () => {
    const { wiki, generateText } = await mk();
    await wiki.write('a', { event_type: 'observation', summary: 'x'.repeat(8000) });
    const r = await wiki.runPendingMaintenance({ tokenBudget: 50 });
    expect(r.stoppedReason).toMatchObject({ reason: 'budget_too_small', job: 'librarian', entityId: 'a' });
    expect((r.stoppedReason as any).requiredEstimate).toBeGreaterThan(50);
    expect(generateText).not.toHaveBeenCalled();
    expect(r.remaining).toBe(50);
  });

  it('budget_exhausted stops the run after spending', async () => {
    // The brief's fixed 3_600 depends on prompt length and cannot produce
    // `librarianPasses === 1` with a 50-event first batch (after any full
    // batch the remainder still fits a smaller follow-up batch). Per the
    // brief's fallback clause, size the budget from the measured estimate:
    // probe with ONE event of the same shape to learn the single-unit prompt
    // estimate, then budget = 2 × est + 10. That makes selectBatch for two
    // pending events halve to one (need₂ = 2·(est+δ) > budget), pass 1
    // completes, and the second unit's smallest unit (one event, need
    // 2·est ≤ budget) no longer fits what REMAINS ⇒ budget_exhausted, not
    // budget_too_small.
    const { wiki } = await mk();
    await wiki.write('probe', { event_type: 'observation', summary: 'x'.repeat(100) });
    const probeMeter = new UsageMeter();
    await wiki.__testAccess.maintenanceService.runLibrarianPass({ entityId: 'probe', trigger: 'call', meter: probeMeter });
    const estOneUnit = probeMeter.used - estimateTokens(noFacts);
    expect(estOneUnit).toBeGreaterThan(0);

    for (let i = 0; i < 2; i++) await wiki.write('a', { event_type: 'observation', summary: 'x'.repeat(100) });
    const r = await wiki.runPendingMaintenance({ tokenBudget: 2 * estOneUnit + 10 });
    expect(r.stoppedReason).toEqual({ reason: 'budget_exhausted' });
    expect(r.perEntity[0].librarianPasses).toBe(1);
    expect(r.tokensUsed).toBeGreaterThan(0);
    expect(r.estimated).toBe(true);
  });

  it('deadline is checked between units', async () => {
    const generateText = vi.fn(async () => { await new Promise((r) => setTimeout(r, 30)); return noFacts; });
    const { wiki } = await mk({ generateText });
    for (let i = 0; i < 120; i++) await wiki.write('a', { event_type: 'observation', summary: `e${i}` });
    const r = await wiki.runPendingMaintenance({ deadlineMs: 10 });
    expect(r.stoppedReason).toEqual({ reason: 'deadline' });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('a throw mid-batch leaves the watermark unchanged and propagates', async () => {
    const generateText = vi.fn(async () => { throw new Error('provider down'); });
    const { wiki } = await mk({ generateText });
    await wiki.write('a', { event_type: 'observation', summary: 'x' });
    await expect(wiki.runPendingMaintenance()).rejects.toThrow('provider down');
    expect((await wiki.getPendingMaintenance())[0].pendingEvents).toBe(1);
  });

  it('a busy entity is skipped and reported', async () => {
    const { wiki } = await mk();
    await wiki.write('a', { event_type: 'observation', summary: 'x' });
    (wiki.__testAccess.jobManager as any).acquireLock('librarian', 'a');
    const r = await wiki.runPendingMaintenance({ jobs: ['librarian'] });
    expect(r.perEntity[0].busy).toEqual(['librarian']);
  });

  it('jobs filter and entityIds filter', async () => {
    const { wiki, generateText } = await mk();
    await wiki.write('a', { event_type: 'observation', summary: 'x' });
    await wiki.write('b', { event_type: 'observation', summary: 'y' });
    await wiki.runPendingMaintenance({ entityIds: ['b'] });
    expect(generateText).toHaveBeenCalledTimes(1);
    const r = await wiki.runPendingMaintenance({ jobs: ['heal'] });
    expect(r.perEntity.every((e) => e.librarianPasses === 0)).toBe(true);
  });
});
