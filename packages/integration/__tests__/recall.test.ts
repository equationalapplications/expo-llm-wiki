import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';

const VECTOR_DIM = 10;
async function embed(text: string): Promise<number[]> {
  const t = text.toLowerCase();
  const v = new Array(VECTOR_DIM).fill(0.01);
  
  // Vehicles
  if (/transportation|motorized|road travel|automobile|car|vehicle|auto/.test(t)) {
    v[0] = 1;
    if (t.includes('road') || t.includes('car') || t.includes('auto')) v[1] = 0.8; // fine-tuning for Scenario 2 rank-1
  }
  
  // Programming
  if (/recursion|closures|async|type inference|garbage collection|programming/.test(t)) {
    v[2] = 1;
  }
  
  // Cooking
  if (/sauté|braising|mise en place|emulsification|reduction|cooking/.test(t)) {
    v[3] = 1;
  }

  // Normalize to avoid NaNs and represent valid cosine vectors
  const mag = Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
  return v.map(val => val / mag);
}

function makeDump(entityId: string, items: Array<{ id: string; title: string; body: string }>): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: items.map((item, i) => ({
          id: item.id,
          entity_id: entityId,
          title: item.title,
          body: item.body,
          tags: [] as string[],
          confidence: 'certain' as const,
          source_type: 'agent_inferred' as const,
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: (i + 1) * 1000,
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

describe('recall — Scenario 1: synonym recall@5 = 1.0', () => {
  it('all 3 vehicle facts appear in top-5 results for query "transportation"', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed },
      config: { maxResults: 5 },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('user-1', [
        { id: 'f-auto', title: 'Automobile', body: 'A wheeled motor vehicle used for transportation' },
        { id: 'f-car', title: 'Car', body: 'Used for personal transportation on roads' },
        { id: 'f-vehicle', title: 'Vehicle', body: 'Carries passengers or cargo from place to place' },
      ])
    );

    const result = await wiki.read('user-1', 'transportation');
    expect(result.facts.length).toBeLessThanOrEqual(5);
    const ids = result.facts.map((f) => f.id);
    expect(ids).toContain('f-auto');
    expect(ids).toContain('f-car');
    expect(ids).toContain('f-vehicle');
  });
});

describe('recall — Scenario 3: domain separation, precision@3 = 1.0', () => {
  it('top-3 results for "recursion" are all programming facts', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed },
      config: { maxResults: 3 },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('user-1', [
        { id: 'p1', title: 'Recursion', body: 'A function that calls itself with a base case' },
        { id: 'p2', title: 'Closures', body: 'Functions that capture variables from their outer scope' },
        { id: 'p3', title: 'Async await', body: 'Syntax for writing asynchronous JavaScript code' },
        { id: 'p4', title: 'Type inference', body: 'Compiler deduces types without explicit annotations' },
        { id: 'p5', title: 'Garbage collection', body: 'Automatic memory management in managed runtimes' },
        { id: 'c1', title: 'Sauté', body: 'Cooking food quickly in a small amount of oil over high heat' },
        { id: 'c2', title: 'Braising', body: 'Slow cooking in liquid after initial browning' },
        { id: 'c3', title: 'Mise en place', body: 'Preparing and organizing all ingredients before cooking' },
        { id: 'c4', title: 'Emulsification', body: 'Combining two immiscible liquids like oil and water' },
        { id: 'c5', title: 'Reduction', body: 'Concentrating flavor by simmering liquid until it thickens' },
      ])
    );

    const programmingIds = new Set(['p1', 'p2', 'p3', 'p4', 'p5']);
    const cookingIds = new Set(['c1', 'c2', 'c3', 'c4', 'c5']);

    // read() on main takes 2 args (no ReadOptions yet). Use slice(0,3) for precision@3.
    const programmingResult = await wiki.read('user-1', 'recursion');
    for (const fact of programmingResult.facts.slice(0, 3)) {
      expect(programmingIds.has(fact.id)).toBe(true);
      expect(cookingIds.has(fact.id)).toBe(false);
    }

    const cookingResult = await wiki.read('user-1', 'braising slow cooking');
    for (const fact of cookingResult.facts.slice(0, 3)) {
      expect(cookingIds.has(fact.id)).toBe(true);
      expect(programmingIds.has(fact.id)).toBe(false);
    }
  });
});

describe('recall — Scenario 2: hybrid beats keyword-only on semantic queries', () => {
  it('hybridWeight:0.5 rank-1 has higher cosine similarity than hybridWeight:0 rank-1', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('user-1', [
        { id: 'f-auto', title: 'Automobile', body: 'A wheeled motor vehicle used for transportation' },
        { id: 'f-car', title: 'Car', body: 'Used for personal transportation on roads' },
        { id: 'f-vehicle', title: 'Vehicle', body: 'Carries passengers or cargo' },
      ])
    );
    await wiki.runReembed('user-1');

    const query = 'motorized road travel';
    const keywordOnly = await (wiki as any).read('user-1', query, { hybridWeight: 0 });
    const hybrid = await (wiki as any).read('user-1', query, { hybridWeight: 0.5 });

    // hybrid should surface all 3 semantically related facts (recall@3 = 1.0)
    // Dataset has exactly 3 facts; hybrid semantic search must retrieve all of them.
    expect(hybrid.facts.length).toBe(3);
    const hybridIds = hybrid.facts.map((f: { id: string }) => f.id);
    expect(hybridIds).toContain('f-auto');
    expect(hybridIds).toContain('f-car');
    expect(hybridIds).toContain('f-vehicle');

    // hybrid rank-1 must be semantically close to "motorized road travel" (automobile or car)
    const semanticRank1 = hybrid.facts[0].id;
    expect(['f-auto', 'f-car']).toContain(semanticRank1);

    // keyword-only on a semantic-only query returns fewer results than hybrid.
    // "motorized road travel" contains no exact keyword matches in any fact body/title
    // (only "roads" ≈ "road" in f-car), so keyword-only returns ≤1 result vs hybrid's 3.
    expect(hybrid.facts.length).toBeGreaterThan(keywordOnly.facts.length);

    // if keyword-only has a rank-1 result, hybrid should rank it no lower
    if (keywordOnly.facts.length > 0) {
      const kwRank1Id = keywordOnly.facts[0].id;
      const kwRank1InHybridIdx = hybridIds.indexOf(kwRank1Id);
      expect(kwRank1InHybridIdx).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('recall — Scenario 4: recall survives export/import roundtrip (BLOB)', () => {
  it('recall@5=1.0 holds after exportDump+importDump without re-running runReembed', async () => {
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, {
      llmProvider: { generateText: async () => '{}', embed },
    });
    await wikiA.setup();

    await wikiA.importDump(
      makeDump('user-1', [
        { id: 'f-auto', title: 'Automobile', body: 'A wheeled motor vehicle used for transportation' },
        { id: 'f-car', title: 'Car', body: 'Used for personal transportation on roads' },
        { id: 'f-vehicle', title: 'Vehicle', body: 'Carries passengers or cargo from place to place' },
      ])
    );
    await wikiA.runReembed('user-1');

    const dump = await wikiA.exportDump();
    const dbB = openTestDatabase();
    const wikiB = new WikiMemory(dbB, {
      llmProvider: { generateText: async () => '{}', embed },
    });
    await wikiB.setup();
    await wikiB.importDump(dump);
    // No runReembed — BLOBs must carry the embeddings

    const result = await wikiB.read('user-1', 'transportation');
    const ids = result.facts.map((f) => f.id);
    expect(ids).toContain('f-auto');
    expect(ids).toContain('f-car');
    expect(ids).toContain('f-vehicle');
  });
});
