import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

describe('getPendingMaintenance', () => {
  it('reports events after the watermark, token estimate, heal and reembed flags', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed: async () => [1, 0] },
      config: { maintenance: 'deferred', autoHealThreshold: 2 },
    });
    await wiki.setup();
    await wiki.write('a', { event_type: 'observation', summary: 'x'.repeat(40) });
    await wiki.write('a', { event_type: 'observation', summary: 'y'.repeat(40) });
    await wiki.write('b', { event_type: 'observation', summary: 'z' });
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('f1','c','t','b',1,1)`);
    const p = await wiki.getPendingMaintenance();
    expect(p).toEqual([
      { entityId: 'a', pendingEvents: 2, pendingTokensEstimate: 20, healDue: true, reembedPending: false },
      { entityId: 'b', pendingEvents: 1, pendingTokensEstimate: 1, healDue: false, reembedPending: false },
      { entityId: 'c', pendingEvents: 0, pendingTokensEstimate: 0, healDue: false, reembedPending: true },
    ]);
    expect(await wiki.getPendingMaintenance(['b'])).toHaveLength(1);
  });
});
