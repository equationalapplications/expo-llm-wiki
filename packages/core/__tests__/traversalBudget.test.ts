import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

describe('traverseGraph({ tokenBudget })', () => {
  it('keeps the anchor, packs neighbours in BFS order, and drops edges to cut nodes', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
    const ins = (id: string, chars: number) => db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, created_at, updated_at) VALUES (?, 'u', ?, ?, 'certain', 1, 1)`,
      [id, id, 'x'.repeat(chars)]);
    await ins('a', 40); await ins('b', 40); await ins('c', 4000);
    for (const t of ['b', 'c']) {
      await db.runAsync(`INSERT INTO llm_wiki_edges (id, entity_id, source_id, target_id, edge_type, created_at) VALUES (?, 'u', 'a', ?, 'rel', 1)`, [`e_${t}`, t]);
    }
    const g = await wiki.traverseGraph('u', { sourceId: 'a', tokenBudget: 40 });
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(g.edges.map((e) => e.target_id)).toEqual(['b']);
    const full = await wiki.traverseGraph('u', { sourceId: 'a' });
    expect(full.nodes).toHaveLength(3);
  });
});
