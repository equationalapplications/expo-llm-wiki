// packages/core/__tests__/searchParity.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { MemoryDump, WikiFact } from '../src/types';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../benchmarks/fixtures/searchParity.json'), 'utf8')) as {
  docs: { id: string; title: string; body: string; tags: string[] }[]; queries: string[];
};
const E = 'parity';
const K = 10;

function dump(): MemoryDump {
  const facts: WikiFact[] = fixture.docs.map((d, i) => ({
    id: d.id, entity_id: E, title: d.title, body: d.body, tags: d.tags, confidence: 'certain',
    source_type: 'user_stated', source_hash: null, source_ref: null, created_at: i + 1, updated_at: i + 1,
    last_accessed_at: null, access_count: 0, deleted_at: null,
  }));
  return { generatedAt: 0, entities: { [E]: { facts, tasks: [], events: [], edges: [] } } };
}

async function wiki(indexStrategy: 'fts5' | 'minisearch') {
  const w = new WikiMemory(openTestDatabase(), { llmProvider: { generateText: async () => '{}' }, config: { indexStrategy } });
  await w.setup();
  await w.importDump(dump(), { merge: true });
  return w;
}

describe('retrieval parity: FTS5 vs MiniSearch (gate for the auto default)', () => {
  it('recall@10 >= 0.85 and mean rank distance <= 3.0 over 250 queries', async () => {
    const mini = await wiki('minisearch');
    const fts = await wiki('fts5');
    let recallSum = 0, rankDistSum = 0, rankDistN = 0, topBelowOne = 0;
    for (const q of fixture.queries) {
      const gold = (await mini.__testAccess.searchService.searchKeyword(q, [E], K)).map((r) => r.id);
      const got = await fts.__testAccess.searchService.searchKeyword(q, [E], K);
      const gotIds = got.map((r) => r.id);
      if (gold.length === 0) { recallSum += 1; continue; }
      const hit = gold.filter((id) => gotIds.includes(id));
      recallSum += hit.length / gold.length;
      for (const id of hit) { rankDistSum += Math.abs(gotIds.indexOf(id) - gold.indexOf(id)); rankDistN++; }
      if ((got[0]?.score ?? 0) < 1) topBelowOne++;
    }
    const recall = recallSum / fixture.queries.length;
    const meanRankDist = rankDistN ? rankDistSum / rankDistN : 0;
    console.log(JSON.stringify({ recallAt10: recall, meanRankDist, topScoreBelowOne: topBelowOne }));
    expect(recall).toBeGreaterThanOrEqual(0.85);
    expect(meanRankDist).toBeLessThanOrEqual(3.0);
    // Hybrid-blend comparability (spec §Fts5IndexStrategy "Score sign"):
    // getKeywordScores divides by max(1, top), so a top bm25 below 1 would
    // shrink keyword weight in rankSemantic. Most queries must clear 1.
    expect(topBelowOne / fixture.queries.length).toBeLessThanOrEqual(0.1);
  }, 120_000);
});
