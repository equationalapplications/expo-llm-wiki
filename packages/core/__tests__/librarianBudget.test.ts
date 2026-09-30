import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { UsageMeter } from '../src/utils/usage';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

/**
 * Budget pre-flight for the legacy librarian pass (spec 2026-09-29 §10 item 5).
 *
 * Proves the `WikiBudgetExhausted` catch in `services/librarian/legacy.ts`
 * does its job: when the prompt estimate exceeds the meter, `runLibrarianPass`
 * returns a `budgetStop` result WITHOUT calling the LLM provider. Mirrors
 * the parallel guarantee in `healBudget.test.ts` for the heal pass.
 *
 * The mirror test ("runs and reports an EventCursor for the newest event
 * when it fits") locks in the shape of the success result so future refactors
 * cannot silently change `processedThrough` semantics.
 */
describe('librarian budget pre-flight (legacy strategy)', () => {
  it('declines without calling the LLM when the prompt does not fit, and reports the estimate', async () => {
    const db: SQLiteAdapter = openTestDatabase();
    const generateText = vi.fn();
    const wiki = new WikiMemory(db, { llmProvider: { generateText } });
    await wiki.setup();

    // One long event summary pushes the prompt estimate well past 10 tokens.
    // ceil(2000/4) = 500 minimum for the summary alone, plus system prompt
    // scaffolding puts the total estimate comfortably above 500.
    await wiki.write('e1', { event_type: 'observation', summary: 'x'.repeat(2000) });

    const ms = wiki.__testAccess.maintenanceService;
    const result = await ms.runLibrarianPass({ entityId: 'e1', trigger: 'call', meter: new UsageMeter(10) });

    expect(generateText).not.toHaveBeenCalled();
    expect(result.factsWritten).toBe(0);
    expect(result.processedThrough).toBeNull();
    expect(result.budgetStop).toBeDefined();
    expect(result.budgetStop!.requiredEstimate).toBeGreaterThan(500);
  });

  it('runs and reports an EventCursor for the newest event when it fits', async () => {
    const db: SQLiteAdapter = openTestDatabase();
    const generateText = vi.fn().mockResolvedValue(JSON.stringify({ facts: [], tasks: [] }));
    const wiki = new WikiMemory(db, { llmProvider: { generateText } });
    await wiki.setup();

    // Two events so the "newest" event is unambiguous: with DESC ordering the
    // first write is the newest at read time, so `events.reverse()` flips the
    // list and `events[events.length - 1]` is the newest event id.
    await wiki.write('e1', { event_type: 'observation', summary: 'first' });
    await wiki.write('e1', { event_type: 'observation', summary: 'second' });

    const events = await db.getAllAsync<{ id: string; created_at: number }>(
      `SELECT id, created_at FROM llm_wiki_events WHERE entity_id = 'e1' ORDER BY created_at DESC`,
    );
    const newestEventId = events[0].id;
    expect(events).toHaveLength(2);
    expect(newestEventId).toBeTruthy();

    const ms = wiki.__testAccess.maintenanceService;
    const result = await ms.runLibrarianPass({ entityId: 'e1', trigger: 'call', meter: new UsageMeter(100_000) });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.budgetStop).toBeUndefined();
    expect(result.factsWritten).toBe(0);
    expect(result.processedThrough).toEqual({ at: events[0].created_at, id: newestEventId });
  });
});
