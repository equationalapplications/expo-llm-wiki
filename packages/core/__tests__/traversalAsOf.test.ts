import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

let db: any;
let wiki: WikiMemory;
async function fact(id: string, extra: { valid_from?: number; valid_to?: number } = {}) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, created_at, updated_at, valid_from, valid_to)
     VALUES (?, 'u', ?, 'b', 'certain', 100, 100, ?, ?)`,
    [id, id, extra.valid_from ?? null, extra.valid_to ?? null],
  );
}
async function edge(s: string, t: string) {
  await db.runAsync(`INSERT INTO llm_wiki_edges (id, entity_id, source_id, target_id, edge_type, created_at) VALUES (?, 'u', ?, ?, 'rel', 1)`, [`e_${s}_${t}`, s, t]);
}

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
  await fact('anchor');
  await fact('old', { valid_to: 500 });
  await fact('new', { valid_from: 500 });
  await edge('anchor', 'old');
  await edge('anchor', 'new');
});

const nodeIds = (g: { nodes: { id: string }[] }) => g.nodes.map((n) => n.id).sort();

describe('traverseGraph asOf', () => {
  it('default (now) walks only to live neighbours', async () => {
    expect(nodeIds(await wiki.traverseGraph('u', { sourceId: 'anchor' }))).toEqual(['anchor', 'new']);
  });
  it('asOf in the past walks to the then-live neighbour', async () => {
    const g = await wiki.traverseGraph('u', { sourceId: 'anchor', asOf: 300 });
    expect(nodeIds(g)).toEqual(['anchor', 'old']);
    expect(g.edges.map((e) => e.target_id)).toEqual(['old']);
  });
  it('a non-live anchor returns itself with no edges', async () => {
    const g = await wiki.traverseGraph('u', { sourceId: 'old' });
    expect(g).toEqual({ nodes: [expect.objectContaining({ id: 'old' })], edges: [] });
  });
  it('rejects a non-finite or negative asOf', async () => {
    await expect(wiki.traverseGraph('u', { sourceId: 'anchor', asOf: NaN })).rejects.toThrow(
      'Invalid ReadOptions.asOf: must be a finite epoch-ms number >= 0',
    );
    await expect(wiki.traverseGraph('u', { sourceId: 'anchor', asOf: -1 })).rejects.toThrow(
      'Invalid ReadOptions.asOf: must be a finite epoch-ms number >= 0',
    );
    await expect(wiki.traverseGraph('u', { sourceId: 'anchor', asOf: '300' as unknown as number })).rejects.toThrow(
      'Invalid ReadOptions.asOf: must be a finite epoch-ms number >= 0',
    );
  });
});
