import { describe, it, expect } from 'vitest';
import { WikiMemory, WikiBusyError } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { stubLLM, scriptedLLM, keywordEmbed } from '../helpers/llm';

function makeFact(
  id: string,
  entityId: string,
  source_type: 'agent_inferred' | 'user_document',
  created_at = 1
) {
  return {
    id,
    entity_id: entityId,
    title: `Title ${id}`,
    body: `Body of ${id}`,
    tags: [] as string[],
    confidence: 'certain' as const,
    source_type,
    source_hash: null,
    source_ref: null,
    created_at,
    updated_at: created_at,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
  };
}

function makeDump(entityId: string, facts: ReturnType<typeof makeFact>[]): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: { [entityId]: { facts, tasks: [], events: [] } },
  };
}

describe('maintenance — Scenario 1: runHeal culls orphaned agent_inferred, spares user_document', () => {
  it('soft-deletes agent_inferred fact; user_document fact remains', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { orphanAfterDays: 0 },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('entity-1', [
        makeFact('agent-fact', 'entity-1', 'agent_inferred', 1),
        makeFact('doc-fact', 'entity-1', 'user_document', 1),
      ])
    );

    await wiki.runHeal('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');
    const ids = bundle.facts.map((f) => f.id);
    expect(ids).not.toContain('agent-fact');
    expect(ids).toContain('doc-fact');
  });
});

describe('maintenance — Scenario 2: runHeal LLM phase deletes agent_inferred, user_document protected', () => {
  it('LLM-requested delete on agent_inferred fact is honoured', async () => {
    const db = openTestDatabase();
    // orphanAfterDays: null disables the orphan auto-pass so only LLM deletion matters
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([
        JSON.stringify({ downgraded: [], deleted: ['fact-a'], newFacts: [] }),
      ]),
      config: { orphanAfterDays: null, staleInferredAfterDays: null },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('entity-1', [
        makeFact('fact-a', 'entity-1', 'agent_inferred', 1),
        makeFact('doc-1', 'entity-1', 'user_document', 1),
      ])
    );

    await wiki.runHeal('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');
    const ids = bundle.facts.map((f) => f.id);
    expect(ids).not.toContain('fact-a');
    expect(ids).toContain('doc-1');
  });

  it('LLM-requested delete on user_document fact is silently ignored', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      // LLM tries to delete both fact-a (valid) and doc-1 (user_document — should be blocked)
      llmProvider: scriptedLLM([
        JSON.stringify({ downgraded: [], deleted: ['fact-a', 'doc-1'], newFacts: [] }),
      ]),
      config: { orphanAfterDays: null, staleInferredAfterDays: null },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('entity-1', [
        makeFact('fact-a', 'entity-1', 'agent_inferred', 1),
        makeFact('doc-1', 'entity-1', 'user_document', 1),
      ])
    );

    await wiki.runHeal('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');
    const ids = bundle.facts.map((f) => f.id);
    expect(ids).not.toContain('fact-a');
    expect(ids).toContain('doc-1');
  });
});

// NOTE: Requires feat/retrieval-tuning (clearVectorCache + embedding_blob).
// Remove .skip after that PR is merged and this branch is rebased.
describe.skip('maintenance — Scenario 3: runReembed writes BLOBs; read() loads from cache, no re-embed', () => {
  it('embed() called N times for facts during runReembed, once for query during read()', async () => {
    const embedCalls: string[] = [];
    const embed = async (text: string): Promise<number[]> => {
      embedCalls.push(text);
      if (text.includes('apple')) return [1, 0, 0];
      return [0, 0, 1];
    };

    const db = openTestDatabase();
    // WikiMemory is from feat/retrieval-tuning which has clearVectorCache
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}', embed } });
    await wiki.setup();

    await wiki.importDump({
      generatedAt: Date.now(),
      entities: {
        'entity-1': {
          facts: [
            {
              id: 'f1', entity_id: 'entity-1', title: 'apple fruit', body: 'red',
              tags: [], confidence: 'certain', source_type: 'agent_inferred',
              source_hash: null, source_ref: null, created_at: 1000, updated_at: 1000,
              last_accessed_at: null, access_count: 0, deleted_at: null,
            },
            {
              id: 'f2', entity_id: 'entity-1', title: 'car vehicle', body: 'fast',
              tags: [], confidence: 'certain', source_type: 'agent_inferred',
              source_hash: null, source_ref: null, created_at: 2000, updated_at: 2000,
              last_accessed_at: null, access_count: 0, deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    });

    await wiki.runReembed('entity-1');
    const factEmbedCallCount = embedCalls.length;
    expect(factEmbedCallCount).toBe(2);

    // Clear cache so read() must reload from BLOBs, not in-memory cache
    (wiki as any).clearVectorCache();
    embedCalls.length = 0;

    await wiki.read('entity-1', 'apple');

    // embed() called once for the query string only; facts loaded from BLOBs
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toBe('apple');
  });
});

describe('maintenance — Scenario 4: prune lock blocks runLibrarian; different entity unaffected', () => {
  it('runLibrarian on same entity throws WikiBusyError while prune lock is held', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: stubLLM() });
    await wiki.setup();

    // Inject prune lock to simulate runPrune in-flight
    (wiki as any).activeMaintenanceJobs.add('llm_wiki_:entity-a:prune');

    const err = await wiki.runLibrarian('entity-a').catch(e => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect((err as WikiBusyError).operation).toBe('prune');

    (wiki as any).activeMaintenanceJobs.delete('llm_wiki_:entity-a:prune');
  });

  it('runLibrarian on entity-b proceeds normally while entity-a prune lock is held', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: stubLLM() });
    await wiki.setup();

    (wiki as any).activeMaintenanceJobs.add('llm_wiki_:entity-a:prune');

    // entity-b has no lock — resolves without error
    await expect(wiki.runLibrarian('entity-b')).resolves.toBeUndefined();

    (wiki as any).activeMaintenanceJobs.delete('llm_wiki_:entity-a:prune');
  });
});

describe('maintenance — Scenario 5: embed throws → onRetrievalFallback fires, MiniSearch results returned', () => {
  it('fallback called once with the thrown error; read() returns MiniSearch results', async () => {
    const db = openTestDatabase();
    let fallbackError: Error | undefined;
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => { throw new Error('model unavailable'); },
      },
      onRetrievalFallback: (err) => { fallbackError = err; },
    });
    await wiki.setup();

    await wiki.importDump(makeDump('entity-1', [
      makeFact('f-apple', 'entity-1', 'agent_inferred', 1000),
    ]));

    const result = await wiki.read('entity-1', 'apple');

    expect(fallbackError).toBeDefined();
    expect(fallbackError!.message).toBe('model unavailable');
    expect(result.facts.length).toBeGreaterThan(0);
  });
});

describe('maintenance — Scenario 6: embed returns NaN vector → fallback fires', () => {
  it('fallback called; read() returns MiniSearch results despite NaN embed', async () => {
    const db = openTestDatabase();
    let fallbackCalled = false;
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => [NaN, 0, 1],
      },
      onRetrievalFallback: () => { fallbackCalled = true; },
    });
    await wiki.setup();

    await wiki.importDump(makeDump('entity-1', [
      makeFact('f-title', 'entity-1', 'agent_inferred', 1000),
    ]));

    const result = await wiki.read('entity-1', 'title');

    expect(fallbackCalled).toBe(true);
    expect(result.facts.length).toBeGreaterThan(0);
  });
});

describe('maintenance — Scenario 7: dimension mismatch → fallback fires, results returned', () => {
  it('stored dim-3 embeddings with dim-384 query embed triggers fallback; MiniSearch results returned', async () => {
    // Phase 1: store facts with dim-3 embeddings using keywordEmbed
    const db = openTestDatabase();
    const wikiDim3 = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async (text) => keywordEmbed(text),
      },
    });
    await wikiDim3.setup();
    await wikiDim3.importDump(makeDump('entity-1', [
      makeFact('f-car', 'entity-1', 'agent_inferred', 1000),
    ]));
    await wikiDim3.runReembed('entity-1'); // writes dim-3 embeddings

    // Phase 2: open same db with dim-384 embed — dimension mismatch on read()
    let fallbackCalled = false;
    const wikiDim384 = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => new Array(384).fill(0.1) as number[],
      },
      onRetrievalFallback: () => { fallbackCalled = true; },
    });
    await wikiDim384.setup();

    const result = await wikiDim384.read('entity-1', 'car');

    expect(fallbackCalled).toBe(true);
    expect(result.facts.length).toBeGreaterThan(0);
  });
});
