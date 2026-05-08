import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { stubLLM, scriptedLLM } from '../helpers/llm';

function makeDump(
  entityId: string,
  facts: Array<{ id: string; source_type: 'librarian_inferred' | 'immutable_document'; confidence?: 'certain' | 'inferred' | 'tentative' }>
): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: facts.map(({ id, source_type, confidence = 'certain' }) => ({
          id,
          entity_id: entityId,
          title: `Title ${id}`,
          body: `Body of ${id}`,
          tags: [] as string[],
          confidence,
          source_type,
          source_hash: null,
          source_ref: null,
          created_at: 1,
          updated_at: 1,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        })),
        tasks: [],
        events: [],
      },
    },
  };
}

function makeEventsDump(entityId: string, eventIds: string[], createdAt: number): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: [],
        tasks: [],
        events: eventIds.map((id) => ({
          id,
          entity_id: entityId,
          event_type: 'observation' as const,
          summary: `Summary of ${id}`,
          related_entry_id: null,
          created_at: createdAt,
        })),
      },
    },
  };
}

describe('config — pruneEventsAfter', () => {
  it('events older than the configured day threshold are deleted by runPrune', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { pruneEventsAfter: 1 },
    });
    await wiki.setup();

    await wiki.importDump(makeEventsDump('entity-1', ['evt-old-1', 'evt-old-2'], 1));
    await wiki.write('entity-1', { event_type: 'observation', summary: 'Recent event' });

    await wiki.runPrune('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');
    expect(bundle.events.every((e) => !['evt-old-1', 'evt-old-2'].includes(e.id))).toBe(true);
    expect(bundle.events.some((e) => e.summary === 'Recent event')).toBe(true);
  });
});

describe('config — pruneRetainSoftDeletedFor: 0 hard-deletes immediately', () => {
  it('soft-deleted fact is hard-deleted from DB after runPrune with retentionDays=0', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { pruneRetainSoftDeletedFor: 0 },
    });
    await wiki.setup();
    await wiki.importDump(makeDump('entity-1', [{ id: 'fact-x', source_type: 'librarian_inferred' }]));

    await wiki.forget('entity-1', { entryId: 'fact-x' });
    await wiki.runPrune('entity-1');

    const rows = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM llm_wiki_entries WHERE id = ?',
      ['fact-x']
    );
    expect(rows).toHaveLength(0);
  });
});

describe('config — pruneRetainSoftDeletedFor: 99999 keeps soft-deleted rows', () => {
  it('soft-deleted fact remains in DB (as deleted row) after runPrune with long retention', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { pruneRetainSoftDeletedFor: 99999 },
    });
    await wiki.setup();
    await wiki.importDump(makeDump('entity-1', [{ id: 'fact-y', source_type: 'librarian_inferred' }]));

    await wiki.forget('entity-1', { entryId: 'fact-y' });
    await wiki.runPrune('entity-1');

    const row = await db.getFirstAsync<{ id: string; deleted_at: number | null }>(
      'SELECT id, deleted_at FROM llm_wiki_entries WHERE id = ?',
      ['fact-y']
    );
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    const bundle = await wiki.getMemoryBundle('entity-1');
    expect(bundle.facts.every((f) => f.id !== 'fact-y')).toBe(true);
  });
});

describe('config — autoLibrarianThreshold', () => {
  it('librarian fires automatically after N events; not before', async () => {
    const libResp = JSON.stringify({
      facts: [{ title: 'Auto fact', body: 'Created by auto-librarian', tags: [], confidence: 'certain' }],
      tasks: [],
    });
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([libResp]),
      config: { autoLibrarianThreshold: 3 },
    });
    await wiki.setup();

    await wiki.write('entity-1', { event_type: 'observation', summary: 'Event 1' });
    await wiki.write('entity-1', { event_type: 'observation', summary: 'Event 2' });

    await new Promise((r) => setTimeout(r, 50));
    const beforeBundle = await wiki.getMemoryBundle('entity-1');
    expect(beforeBundle.facts).toHaveLength(0);

    await wiki.write('entity-1', { event_type: 'observation', summary: 'Event 3' });

    await vi.waitFor(
      async () => {
        const bundle = await wiki.getMemoryBundle('entity-1');
        expect(bundle.facts).toHaveLength(1);
      },
      { timeout: 5000, interval: 100 }
    );

    const afterBundle = await wiki.getMemoryBundle('entity-1');
    expect(afterBundle.facts[0].title).toBe('Auto fact');
  });
});

describe('config — autoHealThreshold', () => {
  it('heal fires automatically inside librarian run when heal threshold is met', async () => {
    const libResp = JSON.stringify({
      facts: [{ title: 'Librarian fact', body: 'From librarian', tags: [], confidence: 'certain' }],
      tasks: [],
    });
    const healResp = JSON.stringify({ downgraded: [], deleted: [], newFacts: [] });
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([libResp, healResp]),
      config: { autoLibrarianThreshold: 1, autoHealThreshold: 1 },
    });
    await wiki.setup();

    await wiki.write('entity-1', { event_type: 'observation', summary: 'Trigger event' });

    await vi.waitFor(
      async () => {
        const bundle = await wiki.getMemoryBundle('entity-1');
        expect(bundle.facts).toHaveLength(1);
      },
      { timeout: 5000, interval: 100 }
    );

    const bundle = await wiki.getMemoryBundle('entity-1');
    expect(bundle.facts[0].title).toBe('Librarian fact');
  });
});

describe('config — staleInferredAfterDays', () => {
  it('librarian_inferred facts with confidence=inferred are downgraded to tentative; immutable_document untouched', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([
        JSON.stringify({ downgraded: [], deleted: [], newFacts: [] }),
      ]),
      config: { staleInferredAfterDays: 0, orphanAfterDays: null },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('entity-1', [
        { id: 'stale-ai', source_type: 'librarian_inferred', confidence: 'inferred' },
        { id: 'fresh-doc', source_type: 'immutable_document', confidence: 'certain' },
      ])
    );

    await wiki.runHeal('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');

    const staleFact = bundle.facts.find((f) => f.id === 'stale-ai');
    expect(staleFact).toBeDefined();
    expect(staleFact!.confidence).toBe('tentative');

    const docFact = bundle.facts.find((f) => f.id === 'fresh-doc');
    expect(docFact).toBeDefined();
    expect(docFact!.confidence).toBe('certain');
  });
});

describe('config — tablePrefix isolates two wikis on the same DB', () => {
  it('wikiA and wikiB each see only their own entity data', async () => {
    const db = openTestDatabase();

    const wikiA = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { tablePrefix: 'a_' },
    });
    const wikiB = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { tablePrefix: 'b_' },
    });
    await wikiA.setup();
    await wikiB.setup();

    await wikiA.importDump(makeDump('user-1', [{ id: 'fact-a1', source_type: 'librarian_inferred' }]));
    await wikiB.importDump(makeDump('user-1', [{ id: 'fact-b1', source_type: 'librarian_inferred' }]));

    const bundleA = await wikiA.getMemoryBundle('user-1');
    const bundleB = await wikiB.getMemoryBundle('user-1');

    expect(bundleA.facts.map((f) => f.id)).toContain('fact-a1');
    expect(bundleA.facts.map((f) => f.id)).not.toContain('fact-b1');
    expect(bundleB.facts.map((f) => f.id)).toContain('fact-b1');
    expect(bundleB.facts.map((f) => f.id)).not.toContain('fact-a1');
  });
});

const HASH_64 = 'c'.repeat(64);

describe('config — chunkConcurrency', () => {
  it('all chunks ingested correctly with chunkConcurrency:4', async () => {
    const db = openTestDatabase();

    const sentences = Array.from({ length: 20 }, (_, i) =>
      `Sentence number ${i + 1} provides unique factual content for chunk testing purposes.`
    );
    const longDoc = sentences.join(' ');

    const responses = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        facts: [{ title: `Chunk ${i + 1} fact`, body: `Body ${i + 1}`, tags: [], confidence: 'certain' }],
      })
    );

    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM(responses),
      config: { chunkConcurrency: 4, maxChunkLength: 200, chunkOverlap: 0 },
    });
    await wiki.setup();

    const result = await wiki.ingestDocument('entity-1', {
      sourceRef: 'concurrency-doc',
      sourceHash: HASH_64,
      documentChunk: longDoc,
    });

    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.truncated).toBe(false);

    const bundle = await wiki.getMemoryBundle('entity-1');
    expect(bundle.facts.length).toBe(result.chunks);
    expect(bundle.facts.every((f) => f.source_ref === 'concurrency-doc')).toBe(true);
  });
});
