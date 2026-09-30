import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { UsageMeter } from '../src/utils/usage';
import { openTestDatabase } from './helpers/sqliteAdapter';

describe('heal under a budget', () => {
  it('stamps only attempted candidates and reports budgetStop', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => JSON.stringify({ downgraded: [], deleted: [], newFacts: [] }) } });
    await wiki.setup();
    // created_at must be recent enough to survive the orphan pass
    // (orphanAfterDays=30, threshold = now - 30d). The brief used `i + 1`
    // which collides with the orphan predicate and silently soft-deletes every
    // candidate before runBatched runs.
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
         VALUES (?, 'u', ?, ?, 'librarian_inferred', 'inferred', ?, ?)`,
        [`f${i}`, `title ${i}`, 'x'.repeat(4000), now - i * 1000, now - i * 1000],
      );
    }
    const ms = wiki.__testAccess.maintenanceService;
    const result = await ms.doRunHeal('u', { meter: new UsageMeter(12_000) });
    expect(result.budgetStop).toBeDefined();
    const stamped = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE heal_checked_at IS NOT NULL`);
    expect(stamped.length).toBeGreaterThan(0);
    expect(stamped.length).toBeLessThan(12);
    expect(result.remaining).toBeGreaterThan(0);
  });
});
