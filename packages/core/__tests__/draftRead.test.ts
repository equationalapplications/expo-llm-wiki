import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { MemoryBundle, VectorRanker, WikiConfig, WikiFact, WikiOptions } from '../src/types';

function fact(id: string, title: string, status: 'draft' | 'stable', t: number, entity = 'e1'): WikiFact {
  return {
    id, entity_id: entity, title, body: `${title} body`, tags: [], confidence: 'certain',
    source_type: 'user_stated', source_hash: null, source_ref: null,
    created_at: t, updated_at: t, last_accessed_at: null, access_count: 0, deleted_at: null,
    lifecycle_status: status,
  };
}

// Drafts match "apple" more strongly than stable facts, so without filtering they win every cut.
const FACTS = [
  fact('d1', 'DRAFT apple apple apple one', 'draft', 5),
  fact('d2', 'DRAFT apple apple apple two', 'draft', 4),
  fact('d3', 'DRAFT apple apple apple three', 'draft', 3),
  fact('s1', 'STABLE apple one', 'stable', 2),
  fact('s2', 'STABLE apple two', 'stable', 1),
];
const STABLE = ['s1', 's2'];

async function makeWiki(opts: { embed?: (t: string) => Promise<number[]>; config?: WikiConfig; vectorRanker?: VectorRanker; facts?: WikiFact[] } = {}) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: { generateText: async () => '{}', ...(opts.embed ? { embed: opts.embed } : {}) },
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.vectorRanker ? { vectorRanker: opts.vectorRanker } : {}),
  };
  const wiki = new WikiMemory(db, options);
  await wiki.setup();
  const entities: Record<string, MemoryBundle> = {};
  for (const f of opts.facts ?? FACTS) {
    (entities[f.entity_id] ??= { facts: [], tasks: [], events: [], edges: [] }).facts.push(f);
  }
  await wiki.importDump({ generatedAt: 1, entities });
  return wiki;
}

const semanticEmbed = async (t: string) => (t.includes('STABLE') ? [0.6, 0.8, 0] : [1, 0, 0]);
const ids = (b: MemoryBundle) => b.facts.map((f) => f.id).sort();

describe('read() excludeDrafts', () => {
  it('keyword path: drafts win by default; excluded when asked, without shrinking below available stable matches', async () => {
    const wiki = await makeWiki();
    const dflt = await wiki.read('e1', 'apple', { maxResults: 3 });
    expect(dflt.facts.some((f) => f.lifecycle_status === 'draft')).toBe(true);
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 3, excludeDrafts: true }))).toEqual(STABLE);
  });

  it('semantic JS-cosine path', async () => {
    const wiki = await makeWiki({ embed: semanticEmbed });
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 2 }))).not.toEqual(STABLE);
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 2, excludeDrafts: true }))).toEqual(STABLE);
  });

  it('MiniSearch pre-filter path: drafts do not occupy pre-filter slots', async () => {
    const wiki = await makeWiki({ embed: semanticEmbed });
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 5, preFilterLimit: 3, excludeDrafts: true }))).toEqual(STABLE);
  });

  it('hybrid path', async () => {
    const wiki = await makeWiki({ embed: semanticEmbed });
    expect(ids(await wiki.read('e1', 'apple', { maxResults: 2, hybridWeight: 0.5, excludeDrafts: true }))).toEqual(STABLE);
  });

  it('vector ranker path: limit padded by draft count; drafts never returned', async () => {
    const limits: number[] = [];
    const ranker: VectorRanker = {
      rankBySimilarity: async (args) => {
        limits.push(args.limit);
        return ['d1', 'd2', 'd3', 's1', 's2'].map((id, i) => ({ id, semanticScore: 1 - i / 10 }));
      },
    };
    const wiki = await makeWiki({ embed: semanticEmbed, vectorRanker: ranker });
    await wiki.read('e1', 'apple', { maxResults: 10 });
    const r = await wiki.read('e1', 'apple', { maxResults: 10, excludeDrafts: true });
    expect(limits).toEqual([60, 63]);
    expect(ids(r)).toEqual(STABLE);
    // The padded ranker limit is an oversample: the final cut still honours maxResults.
    const one = await wiki.read('e1', 'apple', { maxResults: 1, excludeDrafts: true });
    expect(limits[2]).toBe(Math.max(1 * 2, 1 + 50) + 3);
    expect(one.facts).toHaveLength(1);
    expect(STABLE).toContain(one.facts[0].id);
  });

  it('empty-query recency path filters in SQL', async () => {
    const wiki = await makeWiki();
    expect(ids(await wiki.read('e1', '', { excludeDrafts: true }))).toEqual(STABLE);
    expect((await wiki.read('e1', '')).facts).toHaveLength(5);
  });

  it('resolves call → config → false', async () => {
    const wiki = await makeWiki({ config: { excludeDrafts: true } });
    expect(ids(await wiki.read('e1', 'apple'))).toEqual(STABLE);
    expect((await wiki.read('e1', 'apple', { excludeDrafts: false })).facts.length).toBe(5);
  });

  it('tierFloors on an entity whose only matches are drafts does not throw and yields nothing for it', async () => {
    const wiki = await makeWiki({
      facts: [fact('a1', 'STABLE apple', 'stable', 2, 'A'), fact('b1', 'DRAFT apple', 'draft', 1, 'B')],
    });
    const r = await wiki.read(['A', 'B'], 'apple', { maxResults: 5, tierFloors: { B: 1 }, excludeDrafts: true });
    expect(r.facts.map((f) => f.id)).toEqual(['a1']);
  });
});