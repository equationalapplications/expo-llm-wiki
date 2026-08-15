import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiFact, MemoryDump } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;

async function makeWiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, stubOptions);
  await wiki.setup();
  return { wiki, db };
}

describe('migration v10 round-trip on WikiFact', () => {
  it('persists and reads back OKF v0.2 fields via importDump/exportDump', async () => {
    const { wiki } = await makeWiki();
    const fact: WikiFact = {
      id: 'f_v2',
      entity_id: 'e1',
      title: 'OKF v0.2 fact',
      body: 'Body',
      tags: [],
      confidence: 'certain',
      source_type: 'user_stated',
      source_hash: null,
      source_ref: null,
      created_at: 1700000000000,
      updated_at: 1700000000000,
      last_accessed_at: null,
      access_count: 0,
      deleted_at: null,
      okf_type: 'fact',
      lifecycle_status: 'draft',
      stale_after: new Date('2026-01-01T00:00:00Z').getTime(),
      generated_by: 'reference_agent/gemini-2.5-pro',
      okf_sources: [{ resource: 'https://example.com', id: 'a' }],
      okf_verified: [{ by: 'human:ahormati', at: '2026-01-01T00:00:00Z' }],
      okf_usage_window: { from: '2026-01-01', to: '2026-12-31' },
      last_verified_at: new Date('2026-01-01T00:00:00Z').getTime(),
      last_verified_by: 'human:ahormati',
    };
    const dump: MemoryDump = {
      generatedAt: Date.now(),
      entities: { e1: { facts: [fact], tasks: [], events: [], edges: [], summary: '' } },
    };
    await wiki.importDump(dump);
    const exported = await wiki.exportDump(['e1']);
    const read = exported.entities.e1.facts.find((f) => f.id === 'f_v2');
    expect(read?.lifecycle_status).toBe('draft');
    expect(read?.stale_after).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(read?.last_verified_at).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(read?.okf_usage_window).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(read?.generated_by).toBe('reference_agent/gemini-2.5-pro');
    expect(read?.okf_sources).toEqual([{ resource: 'https://example.com', id: 'a' }]);
    expect(read?.okf_verified).toEqual([{ by: 'human:ahormati', at: '2026-01-01T00:00:00Z' }]);
    expect(read?.last_verified_by).toBe('human:ahormati');
  });
});
