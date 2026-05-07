import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type {
  WikiOptions,
  VectorRanker,
  VectorRankerRankArgs,
  VectorRankerSemanticResult,
  VectorRankerFallback,
} from '../src/types';

function makeWiki(embedFn?: (text: string) => Promise<number[]>) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    config: { maxResults: 5 },
    llmProvider: { generateText: async () => '{}', embed: embedFn },
  };
  return { wiki: new WikiMemory(db, options), db };
}

async function insertFactWithBlob(db: ReturnType<typeof openTestDatabase>, id: string, entityId: string, updatedAt = 1000) {
  const blob = new Uint8Array(new Float32Array([Math.random(), Math.random(), Math.random()]).buffer);
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, `title-${id}`, `body-${id}`, '[]', 'certain', 'user_stated', updatedAt, updatedAt, blob]
  );
}

describe('ReadOptions per-call overrides', () => {
  it('per-call maxResults overrides WikiConfig.maxResults', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    // Insert 4 facts
    for (let i = 0; i < 4; i++) {
      await insertFactWithBlob(db, `f${i}`, 'user-1', 1000 + i);
    }

    const result = await wiki.read('user-1', 'query', { maxResults: 2 });
    expect(result.facts).toHaveLength(2);
  });

  it('per-call maxResults: 0 returns empty facts array', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1');
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    const result = await wiki.read('user-1', 'query', { maxResults: 0 });
    expect(result.facts).toHaveLength(0);
  });

  it('per-call maxResults: 0 skips embed() entirely', async () => {
    let embedCallCount = 0;
    const { wiki, db } = makeWiki(async () => { embedCallCount++; return [1, 0, 0]; });
    await wiki.setup();
    await insertFactWithBlob(db, 'f1', 'user-1');
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);

    await wiki.read('user-1', 'query', { maxResults: 0 });
    expect(embedCallCount).toBe(0);
  });

  it('omitting ReadOptions falls back to WikiConfig defaults', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    for (let i = 0; i < 7; i++) {
      await insertFactWithBlob(db, `f${i}`, 'user-1', 1000 + i);
    }

    const result = await wiki.read('user-1', 'query');
    expect(result.facts).toHaveLength(5); // WikiConfig.maxResults = 5
  });

  it('ReadOptions: {} (empty object) falls back to WikiConfig defaults', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    for (let i = 0; i < 7; i++) {
      await insertFactWithBlob(db, `f${i}`, 'user-1', 1000 + i);
    }

    const result = await wiki.read('user-1', 'query', {});
    expect(result.facts).toHaveLength(5);
  });

  it('all three options overridden simultaneously', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
    for (let i = 0; i < 10; i++) {
      await insertFactWithBlob(db, `f${i}`, 'user-1', 1000 + i);
    }

    // maxResults: 3, hybridWeight: 1.0 (pure semantic), preFilterLimit: null (disable)
    const result = await wiki.read('user-1', 'query', { maxResults: 3, hybridWeight: 1.0, preFilterLimit: null });
    expect(result.facts).toHaveLength(3);
  });
});

describe('VectorRanker type exports and WikiOptions integration', () => {
  it('VectorRankerSemanticResult type is properly exported', () => {
    const result: VectorRankerSemanticResult = {
      id: 'fact-1',
      semanticScore: 0.95,
    };
    expect(result.id).toBe('fact-1');
    expect(result.semanticScore).toBe(0.95);
  });

  it('VectorRankerRankArgs type accepts required and optional fields', () => {
    // With candidateIds
    const argsWithCandidates: VectorRankerRankArgs = {
      entityId: 'entity-1',
      queryVec: new Float32Array([1, 0, 0]),
      candidateIds: ['f1', 'f2', 'f3'],
      limit: 10,
    };
    expect(argsWithCandidates.candidateIds).toHaveLength(3);

    // Without candidateIds (full scan)
    const argsFullScan: VectorRankerRankArgs = {
      entityId: 'entity-1',
      queryVec: [1, 0, 0],
      limit: 10,
    };
    expect(argsFullScan.candidateIds).toBeUndefined();
  });

  it('VectorRankerFallback type accepts all valid values', () => {
    const fallbackPolicies: VectorRankerFallback[] = ['js-cosine', 'keyword', 'empty', 'throw'];
    fallbackPolicies.forEach((policy) => {
      expect(['js-cosine', 'keyword', 'empty', 'throw']).toContain(policy);
    });
  });

  it('WikiOptions accepts vectorRanker field', () => {
    const mockRanker: VectorRanker = {
      rankBySimilarity: async () => [],
    };

    const options: WikiOptions = {
      llmProvider: { generateText: async () => '{}' },
      vectorRanker: mockRanker,
    };

    expect(options.vectorRanker).toBe(mockRanker);
  });

  it('WikiOptions accepts vectorRankerFallback field with valid values', () => {
    const optionsJsCosine: WikiOptions = {
      llmProvider: { generateText: async () => '{}' },
      vectorRankerFallback: 'js-cosine',
    };
    expect(optionsJsCosine.vectorRankerFallback).toBe('js-cosine');

    const optionsKeyword: WikiOptions = {
      llmProvider: { generateText: async () => '{}' },
      vectorRankerFallback: 'keyword',
    };
    expect(optionsKeyword.vectorRankerFallback).toBe('keyword');

    const optionsEmpty: WikiOptions = {
      llmProvider: { generateText: async () => '{}' },
      vectorRankerFallback: 'empty',
    };
    expect(optionsEmpty.vectorRankerFallback).toBe('empty');

    const optionsThrow: WikiOptions = {
      llmProvider: { generateText: async () => '{}' },
      vectorRankerFallback: 'throw',
    };
    expect(optionsThrow.vectorRankerFallback).toBe('throw');
  });

  it('WikiOptions accepts onVectorRankerFallback hook', () => {
    let hookCalled = false;
    const options: WikiOptions = {
      llmProvider: { generateText: async () => '{}' },
      onVectorRankerFallback: ({ error, policy }) => {
        hookCalled = true;
        expect(error).toBeInstanceOf(Error);
        expect(['js-cosine', 'keyword', 'empty', 'throw']).toContain(policy);
      },
    };

    // Verify the hook is stored
    expect(options.onVectorRankerFallback).toBeDefined();
    options.onVectorRankerFallback?.(
      {
        error: new Error('test'),
        policy: 'js-cosine',
      }
    );
    expect(hookCalled).toBe(true);
  });

  it('WikiOptions accepts propagateRankerFailureToRetrievalFallback flag', () => {
    const optionsTrue: WikiOptions = {
      llmProvider: { generateText: async () => '{}' },
      propagateRankerFailureToRetrievalFallback: true,
    };
    expect(optionsTrue.propagateRankerFailureToRetrievalFallback).toBe(true);

    const optionsFalse: WikiOptions = {
      llmProvider: { generateText: async () => '{}' },
      propagateRankerFailureToRetrievalFallback: false,
    };
    expect(optionsFalse.propagateRankerFailureToRetrievalFallback).toBe(false);
  });

  it('VectorRanker interface supports optional onEmbeddingPersisted hook', async () => {
    let hookCalled = false;
    const ranker: VectorRanker = {
      rankBySimilarity: async () => [],
      onEmbeddingPersisted: async ({ entityId, factId, vector }) => {
        hookCalled = true;
        expect(entityId).toBe('entity-1');
        expect(factId).toBe('fact-1');
        expect(vector).toBeNull();
      },
    };

    // Call the hook
    if (ranker.onEmbeddingPersisted) {
      await ranker.onEmbeddingPersisted({ entityId: 'entity-1', factId: 'fact-1', vector: null });
    }
    expect(hookCalled).toBe(true);
  });

  it('VectorRanker rankBySimilarity returns properly typed results', async () => {
    const ranker: VectorRanker = {
      rankBySimilarity: async (args: VectorRankerRankArgs) => {
        return [
          { id: 'f1', semanticScore: 0.9 },
          { id: 'f2', semanticScore: 0.8 },
          { id: 'f3', semanticScore: 0.7 },
        ];
      },
    };

    const results = await ranker.rankBySimilarity({
      entityId: 'entity-1',
      queryVec: [1, 0, 0],
      limit: 3,
    });

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe('f1');
    expect(results[0].semanticScore).toBe(0.9);
    expect(results[1].id).toBe('f2');
    expect(results[1].semanticScore).toBe(0.8);
  });
});

