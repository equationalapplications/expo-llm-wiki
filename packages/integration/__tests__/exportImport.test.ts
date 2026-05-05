import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { stubLLM, keywordEmbed } from '../helpers/llm';

function seedDump(
  entityId: string,
  facts: Array<{
    id: string;
    title: string;
    body: string;
    source_type?: 'agent_inferred' | 'user_document' | 'user_stated' | 'user_confirmed';
    updated_at?: number;
  }>
): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: facts.map((f, i) => ({
          id: f.id,
          entity_id: entityId,
          title: f.title,
          body: f.body,
          tags: [],
          confidence: 'certain' as const,
          source_type: f.source_type ?? 'agent_inferred',
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: f.updated_at ?? (i + 1) * 1000,
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

describe('exportImport — Scenario 1: full roundtrip preserves facts and ranking', () => {
  it('read() returns same rank-1 fact after export → import into fresh wiki', async () => {
    const llm = stubLLM();
    const embed = async (text: string) => keywordEmbed(text);

    // Original wiki
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: { ...llm, embed } });
    await wikiA.setup();
    await wikiA.importDump(
      seedDump('user-1', [
        { id: 'fact-apple', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-car', title: 'car vehicle', body: 'fast engine' },
      ])
    );

    const beforeExport = await wikiA.read('user-1', 'apple');
    expect(beforeExport.facts[0].id).toBe('fact-apple');

    // Export and import into fresh wiki
    const dump = await wikiA.exportDump();
    const dbB = openTestDatabase();
    const wikiB = new WikiMemory(dbB, { llmProvider: { ...llm, embed } });
    await wikiB.setup();
    await wikiB.importDump(dump);

    const afterImport = await wikiB.read('user-1', 'apple');
    expect(afterImport.facts[0].id).toBe('fact-apple');
  });

  it('fact count and source_type are preserved after roundtrip', async () => {
    const llm = stubLLM();
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: llm });
    await wikiA.setup();
    await wikiA.importDump(
      seedDump('user-1', [
        { id: 'f1', title: 'Alpha', body: 'body', source_type: 'user_document' },
        { id: 'f2', title: 'Beta', body: 'body', source_type: 'agent_inferred' },
      ])
    );

    const dump = await wikiA.exportDump();
    const dbB = openTestDatabase();
    const wikiB = new WikiMemory(dbB, { llmProvider: llm });
    await wikiB.setup();
    await wikiB.importDump(dump);

    const bundle = await wikiB.getMemoryBundle('user-1');
    expect(bundle.facts).toHaveLength(2);
    const sourceTypes = bundle.facts.map((f) => f.source_type).sort();
    expect(sourceTypes).toEqual(['agent_inferred', 'user_document']);
  });
});

describe('exportImport — Scenario 2: merge collision, newer updated_at wins', () => {
  it('f1 body from dump B wins when updated_at is newer; f2 and f3 both survive', async () => {
    const llm = stubLLM();
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: llm });
    await wikiA.setup();

    const dumpA: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f1',
              entity_id: 'user-1',
              title: 'Shared fact',
              body: 'body from A',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
            {
              id: 'f2',
              entity_id: 'user-1',
              title: 'Unique to A',
              body: 'only in A',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    };

    await wikiA.importDump(dumpA);

    const dumpB: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f1',
              entity_id: 'user-1',
              title: 'Shared fact',
              body: 'body from B — newer',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 2000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
            {
              id: 'f3',
              entity_id: 'user-1',
              title: 'Unique to B',
              body: 'only in B',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    };

    await wikiA.importDump(dumpB, { merge: true });

    const bundle = await wikiA.getMemoryBundle('user-1');
    const byId = Object.fromEntries(bundle.facts.map((f) => [f.id, f]));

    expect(byId['f1'].body).toBe('body from B — newer');
    expect(byId['f2']).toBeDefined();
    expect(byId['f3']).toBeDefined();
  });

  it('older dump B updated_at does not overwrite newer fact already in wiki', async () => {
    const llm = stubLLM();
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: llm });
    await wikiA.setup();

    const base: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f1',
              entity_id: 'user-1',
              title: 'Fact',
              body: 'current body',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 2000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    };
    await wikiA.importDump(base);

    const stale: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f1',
              entity_id: 'user-1',
              title: 'Fact',
              body: 'stale body — should lose',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    };
    await wikiA.importDump(stale, { merge: true });

    const bundle = await wikiA.getMemoryBundle('user-1');
    expect(bundle.facts[0].body).toBe('current body');
  });
});

describe('exportImport — Scenario 3: embedding BLOB survives roundtrip', () => {
  it('runReembed after import skips facts whose BLOBs were preserved through exportDump/importDump', async () => {
    const embed = async (text: string) => keywordEmbed(text);
    const llm = stubLLM();
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: { ...llm, embed } });
    await wikiA.setup();
    await wikiA.importDump(
      seedDump('user-1', [
        { id: 'f1', title: 'apple fruit', body: 'red' },
        { id: 'f2', title: 'car vehicle', body: 'fast' },
      ])
    );
    // runReembed writes BLOBs for f1 and f2. We use { force: true } here to
    // explicitly overwrite the blobs that importDump already wrote via embedFact(),
    // demonstrating that runReembed can always regenerate vectors (model-switch path).
    const resA = await wikiA.runReembed('user-1', { force: true });
    expect(resA.embedded).toBe(2);
    expect(resA.skipped).toBe(0);

    // exportDump now includes embedding_blob in each fact, so the dump carries vectors.
    const dump = await wikiA.exportDump();
    const dbB = openTestDatabase();
    const wikiB = new WikiMemory(dbB, { llmProvider: { ...llm, embed } });
    await wikiB.setup();
    // importDump detects the BLOBs in the dump and preserves them directly,
    // skipping embedFact() for those facts.
    await wikiB.importDump(dump);

    // runReembed sees that f1 and f2 already have valid BLOBs and skips them —
    // no embed provider call required.
    const result = await wikiB.runReembed('user-1');
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(2);
  });
});
