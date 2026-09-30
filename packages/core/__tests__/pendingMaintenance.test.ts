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

  it('resets a heal checkpoint beyond the event count to zero, matching auto-heal', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed: async () => [1, 0] },
      config: { maintenance: 'deferred', autoHealThreshold: 2 },
    });
    await wiki.setup();
    for (const c of ['x', 'y', 'z']) await wiki.write('d', { event_type: 'observation', summary: c.repeat(40) });
    // Simulate heal advancing the checkpoint, then runPrune deleting events:
    // checkpoint (50) now exceeds the surviving event count.
    await wiki.__testAccess.metadataRepo.updateCheckpoint('d', { heal: 50 }, db);
    await db.runAsync(`DELETE FROM llm_wiki_events WHERE id = (SELECT id FROM llm_wiki_events WHERE entity_id = 'd' LIMIT 1)`);
    const p = await wiki.getPendingMaintenance(['d']);
    // WriteService.maybeRunHeal resets the out-of-range checkpoint to ZERO, so
    // 2 - 0 >= 2 means healDue — not the event-count clamp (2 - 2 = 0).
    expect(p).toEqual([
      { entityId: 'd', pendingEvents: 2, pendingTokensEstimate: 20, healDue: true, reembedPending: false },
    ]);
  });

  it('reports reembedPending false for unembedded facts without an embed provider', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { maintenance: 'deferred' },
    });
    await wiki.setup();
    await wiki.write('c', { event_type: 'observation', summary: 'z' });
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('f1','c','t','b',1,1)`);
    const p = await wiki.getPendingMaintenance();
    // The unembedded fact must not surface as reembed work without embed.
    expect(p).toEqual([
      { entityId: 'c', pendingEvents: 1, pendingTokensEstimate: 1, healDue: false, reembedPending: false },
    ]);
  });
});
