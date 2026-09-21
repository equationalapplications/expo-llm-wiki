import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiConfig, WikiEdge, WikiFact } from '../src/types';

function fact(id: string, status: 'draft' | 'stable', t: number): WikiFact {
  return {
    id, entity_id: 'e1', title: `t-${id}`, body: 'b', tags: [], confidence: 'certain',
    source_type: 'user_stated', source_hash: null, source_ref: null,
    created_at: t, updated_at: t, last_accessed_at: null, access_count: 0, deleted_at: null,
    lifecycle_status: status,
  };
}
const edge = (id: string, s: string, t: string): WikiEdge => ({ id, entity_id: 'e1', source_id: s, target_id: t, edge_type: 'rel', created_at: 1 });

// n1 (stable) → n2 (draft) → n3 (stable)
async function makeWiki(config?: WikiConfig) {
  const wiki = new WikiMemory(openTestDatabase(), { llmProvider: { generateText: async () => '{}' }, ...(config ? { config } : {}) });
  await wiki.setup();
  await wiki.importDump({
    generatedAt: 1,
    entities: { e1: { facts: [fact('n1', 'stable', 3), fact('n2', 'draft', 2), fact('n3', 'stable', 1)], tasks: [], events: [], edges: [edge('x', 'n1', 'n2'), edge('y', 'n2', 'n3')] } },
  });
  return wiki;
}

describe('traverseGraph excludeDrafts', () => {
  it('default: drafts are traversed', async () => {
    const wiki = await makeWiki();
    const r = await wiki.traverseGraph('e1', { sourceId: 'n1', maxDepth: 2 });
    expect(r.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('excludeDrafts: a draft interior node blocks discovery beyond it', async () => {
    const wiki = await makeWiki();
    const r = await wiki.traverseGraph('e1', { sourceId: 'n1', maxDepth: 2, excludeDrafts: true });
    expect(r.nodes.map((n) => n.id)).toEqual(['n1']);
    expect(r.edges).toEqual([]);
  });

  it('a draft root is retained and traversed from', async () => {
    const wiki = await makeWiki();
    const r = await wiki.traverseGraph('e1', { sourceId: 'n2', excludeDrafts: true });
    expect(r.nodes[0].id).toBe('n2');
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('config default applies and a call can override it', async () => {
    const wiki = await makeWiki({ excludeDrafts: true });
    expect((await wiki.traverseGraph('e1', { sourceId: 'n1', maxDepth: 2 })).nodes.map((n) => n.id)).toEqual(['n1']);
    expect((await wiki.traverseGraph('e1', { sourceId: 'n1', maxDepth: 2, excludeDrafts: false })).nodes).toHaveLength(3);
  });
});
