import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchService } from '../src/services/SearchService';
import type { EntryRepository } from '../src/repositories/EntryRepository';
import { cosineSimilarity } from '../src/utils/cosine';
import { parseEmbedding } from '../src/utils/embedding';
import * as embeddingModule from '../src/utils/embedding';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(
  rows: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [],
) {
  return {
    findMiniSearchRows: vi.fn().mockResolvedValue(rows),
  } as unknown as EntryRepository;
}

function makeVecRow(
  id: string,
  entityId: string,
  vec: number[] | null,
  opts: { updated_at?: number; access_count?: number } = {},
) {
  const blob = vec ? new Uint8Array(new Float32Array(vec).buffer) : null;
  return {
    id,
    entity_id: entityId,
    embedding_blob: blob,
    embedding: null as string | null,
    updated_at: opts.updated_at ?? 1000,
    access_count: opts.access_count ?? 0,
  };
}

function makeMiniSearchRow(
  id: string,
  entityId: string,
  title = 'title',
  body = 'body',
  tags = '[]',
) {
  return { id, entity_id: entityId, title, body, tags };
}

// ---------------------------------------------------------------------------
// 1. FIFO eviction at entity cap (16)
// ---------------------------------------------------------------------------

describe('vector cache — FIFO eviction at entity cap (16)', () => {
  it('evicts entity-0 when 17th entity is cached; entity-16 remains cached', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const queryVec = new Float32Array([1, 0, 0]);

    // Populate cache for 17 entities.
    for (let i = 0; i < 17; i++) {
      parseSpy.mockClear();
      await service.rankSemantic({
        entityId: `entity-${i}`,
        queryVec,
        candidateRows: [makeVecRow(`f-e${i}`, `entity-${i}`, [1, 0, 0])],
        weight: undefined,
        miniSearchScores: undefined,
        populateCache: true,
        limit: 10,
      });
    }

    // entity-0 should have been evicted — parseEmbedding must be called again.
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'entity-0',
      queryVec,
      candidateRows: [makeVecRow('f-e0', 'entity-0', [1, 0, 0])],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0); // evicted — re-parsed

    // entity-16 was most recently cached — should still be a cache hit.
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'entity-16',
      queryVec,
      candidateRows: [makeVecRow('f-e16', 'entity-16', [1, 0, 0])],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBe(0); // cache hit

    parseSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. Per-entity fact cap (500)
// ---------------------------------------------------------------------------

describe('vector cache — per-entity fact cap (500)', () => {
  it('skips cache for entities with > 500 rows; parseEmbedding called on second read', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const queryVec = new Float32Array([1, 0, 0]);
    const largeRows = Array.from({ length: 501 }, (_, i) =>
      makeVecRow(`f-large-${i}`, 'large-entity', [1, 0, 0]),
    );

    // First call — should not populate cache (> 500)
    await service.rankSemantic({
      entityId: 'large-entity',
      queryVec,
      candidateRows: largeRows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });

    // Second call — if cache was skipped, parseEmbedding must be called again.
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'large-entity',
      queryVec,
      candidateRows: largeRows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0); // not cached — re-parses

    parseSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. Cache population
// ---------------------------------------------------------------------------

describe('vector cache — population', () => {
  it('first rankSemantic with populateCache=true populates; second call skips parseEmbedding', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const queryVec = new Float32Array([1, 0, 0]);
    const rows = [
      makeVecRow('f1', 'entity-1', [1, 0, 0]),
      makeVecRow('f2', 'entity-1', [0, 1, 0]),
    ];

    // First call populates cache
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'entity-1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

    // Second call should be a cache hit
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'entity-1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBe(0);

    parseSpy.mockRestore();
  });

  it('populateCache=false does not cache; parseEmbedding called on each call', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');

    const queryVec = new Float32Array([1, 0, 0]);
    const rows = [makeVecRow('f1', 'entity-1', [1, 0, 0])];

    await service.rankSemantic({
      entityId: 'entity-1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
    });

    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'entity-1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0); // not cached

    parseSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. evictCache(entityId)
// ---------------------------------------------------------------------------

describe('evictCache(entityId)', () => {
  it('clears specific entity cache only; other entities remain cached', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');
    const queryVec = new Float32Array([1, 0, 0]);

    // Populate cache for two entities
    for (const id of ['entity-a', 'entity-b']) {
      await service.rankSemantic({
        entityId: id,
        queryVec,
        candidateRows: [makeVecRow(`f-${id}`, id, [1, 0, 0])],
        weight: undefined,
        miniSearchScores: undefined,
        populateCache: true,
        limit: 10,
      });
    }

    // Evict only entity-a
    service.evictCache('entity-a');

    // entity-a must re-parse
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'entity-a',
      queryVec,
      candidateRows: [makeVecRow('f-entity-a', 'entity-a', [1, 0, 0])],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

    // entity-b must still be cached
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'entity-b',
      queryVec,
      candidateRows: [makeVecRow('f-entity-b', 'entity-b', [1, 0, 0])],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBe(0);

    parseSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 5. evictCache() — clears all
// ---------------------------------------------------------------------------

describe('evictCache() without argument', () => {
  it('clears all entity caches', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');
    const queryVec = new Float32Array([1, 0, 0]);

    for (const id of ['entity-1', 'entity-2']) {
      await service.rankSemantic({
        entityId: id,
        queryVec,
        candidateRows: [makeVecRow(`f-${id}`, id, [1, 0, 0])],
        weight: undefined,
        miniSearchScores: undefined,
        populateCache: true,
        limit: 10,
      });
    }

    service.evictCache(); // clear all

    parseSpy.mockClear();
    for (const id of ['entity-1', 'entity-2']) {
      await service.rankSemantic({
        entityId: id,
        queryVec,
        candidateRows: [makeVecRow(`f-${id}`, id, [1, 0, 0])],
        weight: undefined,
        miniSearchScores: undefined,
        populateCache: true,
        limit: 10,
      });
    }
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

    parseSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 6. clearAll()
// ---------------------------------------------------------------------------

describe('clearAll()', () => {
  it('resets vectorCache, miniSearch, and miniSearchEntryIdsByEntity', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'apple', 'body', '[]')];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');
    const queryVec = new Float32Array([1, 0, 0]);

    // Populate index and cache
    await service.sync('e1');
    await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [makeVecRow('f1', 'e1', [1, 0, 0])],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });

    service.clearAll();

    // Keyword search should return empty after clearAll
    const results = service.searchKeyword('apple', ['e1'], 10);
    expect(results).toHaveLength(0);

    // Cache should be cleared — parseEmbedding called on next rankSemantic
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [makeVecRow('f1', 'e1', [1, 0, 0])],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

    parseSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 7. sync(entityId)
// ---------------------------------------------------------------------------

describe('sync(entityId)', () => {
  it('rebuilds index for specific entity and evicts its cache', async () => {
    const initialRows = [makeMiniSearchRow('f1', 'e1', 'apple', 'body', '[]')];
    const repo = makeRepo(initialRows);
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');
    const queryVec = new Float32Array([1, 0, 0]);

    await service.sync('e1');

    // Populate cache
    await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [makeVecRow('f1', 'e1', [1, 0, 0])],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });

    // Now update repo to return new rows and sync
    const newRows = [
      makeMiniSearchRow('f1', 'e1', 'apple', 'body', '[]'),
      makeMiniSearchRow('f2', 'e1', 'banana', 'body', '[]'),
    ];
    (repo.findMiniSearchRows as ReturnType<typeof vi.fn>).mockResolvedValue(newRows);

    await service.sync('e1'); // should evict cache and rebuild index

    // searchKeyword should find newly added 'banana'
    const results = service.searchKeyword('banana', ['e1'], 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('f2');

    // Cache should be evicted
    parseSpy.mockClear();
    await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [makeVecRow('f1', 'e1', [1, 0, 0])],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: true,
      limit: 10,
    });
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

    parseSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 8. sync() — all entities
// ---------------------------------------------------------------------------

describe('sync() without argument', () => {
  it('rebuilds all-entity index and evicts all cache', async () => {
    const initialRows = [
      makeMiniSearchRow('f1', 'e1', 'apple', 'body', '[]'),
      makeMiniSearchRow('f2', 'e2', 'car', 'body', '[]'),
    ];
    const repo = makeRepo(initialRows);
    const service = new SearchService(repo);
    const parseSpy = vi.spyOn(embeddingModule, 'parseEmbedding');
    const queryVec = new Float32Array([1, 0, 0]);

    await service.sync();

    // Populate cache for both entities
    for (const [id, eid] of [['f1', 'e1'], ['f2', 'e2']]) {
      await service.rankSemantic({
        entityId: eid,
        queryVec,
        candidateRows: [makeVecRow(id, eid, [1, 0, 0])],
        weight: undefined,
        miniSearchScores: undefined,
        populateCache: true,
        limit: 10,
      });
    }

    const newRows = [
      makeMiniSearchRow('f1', 'e1', 'apple updated', 'body', '[]'),
      makeMiniSearchRow('f3', 'e1', 'new fact', 'body', '[]'),
    ];
    (repo.findMiniSearchRows as ReturnType<typeof vi.fn>).mockResolvedValue(newRows);

    await service.sync(); // global sync

    // New fact 'f3' should be found
    const results = service.searchKeyword('new fact', ['e1'], 10);
    expect(results.length).toBeGreaterThan(0);

    // All caches should be evicted
    parseSpy.mockClear();
    for (const [id, eid] of [['f1', 'e1'], ['f2', 'e2']]) {
      await service.rankSemantic({
        entityId: eid,
        queryVec,
        candidateRows: [makeVecRow(id, eid, [1, 0, 0])],
        weight: undefined,
        miniSearchScores: undefined,
        populateCache: true,
        limit: 10,
      });
    }
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

    parseSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 9. searchKeyword
// ---------------------------------------------------------------------------

describe('searchKeyword', () => {
  it('returns results filtered by entityIds', async () => {
    const rows = [
      makeMiniSearchRow('f1', 'e1', 'apple fruit', 'body', '[]'),
      makeMiniSearchRow('f2', 'e2', 'apple cider', 'body', '[]'),
    ];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const results = service.searchKeyword('apple', ['e1'], 10);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('f1');
  });

  it('respects limit', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeMiniSearchRow(`f${i}`, 'e1', `apple item ${i}`, 'body', '[]'),
    );
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const results = service.searchKeyword('apple', ['e1'], 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty when entity not in entityIds', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'apple', 'body', '[]')];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const results = service.searchKeyword('apple', ['e-other'], 10);
    expect(results).toHaveLength(0);
  });

  it('returns empty when no results match query', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'banana', 'body', '[]')];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const results = service.searchKeyword('xyzzy_no_match_abc', ['e1'], 10);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. getMiniSearchScores
// ---------------------------------------------------------------------------

describe('getMiniSearchScores', () => {
  it('returns normalized scores (all <= 1, all > 0)', async () => {
    const rows = [
      makeMiniSearchRow('f1', 'e1', 'apple fruit', 'body', '[]'),
      makeMiniSearchRow('f2', 'e1', 'apple', 'body', '[]'),
    ];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const scores = service.getMiniSearchScores('apple', ['e1']);
    expect(scores.size).toBeGreaterThan(0);
    // Scores are divided by max(1, topRawScore), so all are <= 1 and > 0
    for (const score of scores.values()) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    // The relative ordering must be preserved: highest ranked by MiniSearch has highest score
    const scoreArr = [...scores.entries()];
    // f1 (longer match 'apple fruit') and f2 ('apple') — both match; scores are monotone
    expect(scoreArr.every(([, s]) => s > 0)).toBe(true);
  });

  it('top result is normalized to max(rawScore, 1) — value at most 1', async () => {
    // When raw MiniSearch score >= 1, the top result gets score == 1.
    // When raw score < 1, it's divided by 1, still <= 1.
    const rows = [
      makeMiniSearchRow('f1', 'e1', 'exact', 'body', '[]'),
    ];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const scores = service.getMiniSearchScores('exact', ['e1']);
    expect(scores.size).toBe(1);
    const topScore = scores.get('f1')!;
    expect(topScore).toBeGreaterThan(0);
    expect(topScore).toBeLessThanOrEqual(1);
  });

  it('respects preFilterLimit', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeMiniSearchRow(`f${i}`, 'e1', `apple item ${i}`, 'body', '[]'),
    );
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const scores = service.getMiniSearchScores('apple', ['e1'], 2);
    expect(scores.size).toBeLessThanOrEqual(2);
  });

  it('returns empty Map when no results', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'banana', 'body', '[]')];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const scores = service.getMiniSearchScores('xyzzy_no_match', ['e1']);
    expect(scores.size).toBe(0);
  });

  it('filters by entityIds', async () => {
    const rows = [
      makeMiniSearchRow('f1', 'e1', 'apple', 'body', '[]'),
      makeMiniSearchRow('f2', 'e2', 'apple', 'body', '[]'),
    ];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    const scores = service.getMiniSearchScores('apple', ['e1']);
    expect(scores.has('f1')).toBe(true);
    expect(scores.has('f2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. rankSemantic — cosine math
// ---------------------------------------------------------------------------

describe('rankSemantic — cosine math', () => {
  it('produces scores identical to direct cosineSimilarity call', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const queryVec = [0.6, 0.8, 0.0];
    const factVec = [1.0, 0.0, 0.0];
    const expectedScore = cosineSimilarity(queryVec, factVec);

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [makeVecRow('f1', 'e1', factVec)],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
    });

    expect(results[0].score).toBeCloseTo(expectedScore, 10);
  });

  it('matches parseEmbedding then cosineSimilarity exactly', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const queryVec = [0.3, 0.4, 0.866];
    const factVec = [0.5, 0.5, 0.707];
    const row = makeVecRow('f1', 'e1', factVec);
    const parsedVec = parseEmbedding(row.embedding_blob, row.embedding)!;
    const expectedScore = cosineSimilarity(queryVec, parsedVec);

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [row],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
    });

    expect(results[0].score).toBeCloseTo(expectedScore, 10);
  });
});

// ---------------------------------------------------------------------------
// 12. rankSemantic — hybrid blend
// ---------------------------------------------------------------------------

describe('rankSemantic — hybrid blend', () => {
  it('score = weight * cosine + (1-weight) * kwScore when weight provided', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const queryVec = [1, 0, 0];
    const factVec = [1, 0, 0];
    const weight = 0.7;
    const kwScore = 0.5;

    const miniSearchScores = new Map([['f1', kwScore]]);
    const expectedCos = cosineSimilarity(queryVec, factVec);
    const expectedScore = weight * Math.max(0, expectedCos) + (1 - weight) * kwScore;

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [makeVecRow('f1', 'e1', factVec)],
      weight,
      miniSearchScores,
      populateCache: false,
      limit: 10,
    });

    expect(results[0].score).toBeCloseTo(expectedScore, 10);
  });

  it('kwScore defaults to 0 when not in miniSearchScores map', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const queryVec = [1, 0, 0];
    const factVec = [1, 0, 0];
    const weight = 0.5;
    const expectedCos = cosineSimilarity(queryVec, factVec);
    const expectedScore = weight * Math.max(0, expectedCos) + (1 - weight) * 0; // kwScore=0

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [makeVecRow('f1', 'e1', factVec)],
      weight,
      miniSearchScores: new Map(), // no entry for f1
      populateCache: false,
      limit: 10,
    });

    expect(results[0].score).toBeCloseTo(expectedScore, 10);
  });

  it('clamps negative cosine to 0 in hybrid blend', async () => {
    const repo = makeRepo();
    const svc = new SearchService(repo);
    const queryVec = [1, 0, 0];
    const factVec = [-1, 0, 0]; // cosine = -1.0
    const weight = 0.7;
    const kwScore = 0.5;
    const miniSearchScores = new Map([['f1', kwScore]]);

    const blob = new Uint8Array(new Float32Array(factVec).buffer);
    const results = await svc.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: [{ id: 'f1', entity_id: 'e1', embedding_blob: blob, embedding: null, updated_at: 1000, access_count: 1 }],
      weight,
      miniSearchScores,
      populateCache: false,
      limit: 10,
    });

    // Math.max(0, -1.0) clamps to 0; expected = (1 - weight) * kwScore = 0.15
    const expected = (1 - weight) * kwScore;
    expect(results[0].score).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// 13. rankSemantic — missing vector
// ---------------------------------------------------------------------------

describe('rankSemantic — missing vector', () => {
  it('rows with null embedding get score=-2 when weight=undefined', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec: [1, 0, 0],
      candidateRows: [makeVecRow('f-null', 'e1', null)],
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
    });

    expect(results[0].score).toBe(-2);
  });

  it('rows with null embedding get (1-weight)*kwScore when weight < 1', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const weight = 0.4;
    const kwScore = 0.8;
    const expected = (1 - weight) * kwScore;

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec: [1, 0, 0],
      candidateRows: [makeVecRow('f-null', 'e1', null)],
      weight,
      miniSearchScores: new Map([['f-null', kwScore]]),
      populateCache: false,
      limit: 10,
    });

    expect(results[0].score).toBeCloseTo(expected, 10);
  });

  it('rows with null embedding get score=-2 when weight=1', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec: [1, 0, 0],
      candidateRows: [makeVecRow('f-null', 'e1', null)],
      weight: 1,
      miniSearchScores: new Map(),
      populateCache: false,
      limit: 10,
    });

    expect(results[0].score).toBe(-2);
  });
});

// ---------------------------------------------------------------------------
// 14. rankSemantic — skipSort
// ---------------------------------------------------------------------------

describe('rankSemantic — skipSort', () => {
  it('results are not sorted when skipSort=true', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    // Row order: f-low (score ~0) then f-high (score ~1)
    // Without sort, original order is preserved.
    const queryVec = [1, 0, 0];
    const rows = [
      makeVecRow('f-low', 'e1', [0, 0, 1]), // low cosine similarity to [1,0,0]
      makeVecRow('f-high', 'e1', [1, 0, 0]), // perfect cosine similarity
    ];

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
      skipSort: true,
    });

    // Order should match input order, not score order
    expect(results[0].id).toBe('f-low');
    expect(results[1].id).toBe('f-high');
  });

  it('results ARE sorted when skipSort=false (default)', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const queryVec = [1, 0, 0];
    const rows = [
      makeVecRow('f-low', 'e1', [0, 0, 1]),
      makeVecRow('f-high', 'e1', [1, 0, 0]),
    ];

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
      skipSort: false,
    });

    expect(results[0].id).toBe('f-high');
    expect(results[1].id).toBe('f-low');
  });
});

// ---------------------------------------------------------------------------
// 15. rankSemantic — limit
// ---------------------------------------------------------------------------

describe('rankSemantic — limit', () => {
  it('returns at most limit results', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const queryVec = [1, 0, 0];
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeVecRow(`f${i}`, 'e1', [1, 0, 0]),
    );

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 3,
    });

    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 16. Tiebreak sort
// ---------------------------------------------------------------------------

describe('tiebreak sort', () => {
  it('sorts by score desc, then access_count desc, then updated_at desc, then id asc', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    // All rows have the same cosine similarity (all same vector)
    const queryVec = [1, 0, 0];
    const rows = [
      makeVecRow('f-z', 'e1', [1, 0, 0], { updated_at: 1000, access_count: 0 }),
      makeVecRow('f-a', 'e1', [1, 0, 0], { updated_at: 1000, access_count: 0 }),
      makeVecRow('f-b', 'e1', [1, 0, 0], { updated_at: 2000, access_count: 0 }), // higher updated_at
      makeVecRow('f-c', 'e1', [1, 0, 0], { updated_at: 1000, access_count: 5 }), // higher access_count
    ];

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
    });

    // f-c: access_count=5 → rank 1
    expect(results[0].id).toBe('f-c');
    // f-b: access_count=0, updated_at=2000 → rank 2
    expect(results[1].id).toBe('f-b');
    // f-a: access_count=0, updated_at=1000, id='f-a' → rank 3 (lexicographically before 'f-z')
    expect(results[2].id).toBe('f-a');
    // f-z: access_count=0, updated_at=1000, id='f-z' → rank 4
    expect(results[3].id).toBe('f-z');
  });

  it('higher score wins regardless of access_count', async () => {
    const repo = makeRepo();
    const service = new SearchService(repo);

    const queryVec = [1, 0, 0];
    const rows = [
      makeVecRow('f-high-score', 'e1', [1, 0, 0], { access_count: 0 }),    // score≈1
      makeVecRow('f-low-score', 'e1', [0.5, 0.866, 0], { access_count: 100 }), // lower score, high access
    ];

    const results = await service.rankSemantic({
      entityId: 'e1',
      queryVec,
      candidateRows: rows,
      weight: undefined,
      miniSearchScores: undefined,
      populateCache: false,
      limit: 10,
    });

    expect(results[0].id).toBe('f-high-score');
  });
});

// ---------------------------------------------------------------------------
// 17. normalizeMiniSearchRow (via sync + searchKeyword)
// ---------------------------------------------------------------------------

describe('normalizeMiniSearchRow', () => {
  it('tags JSON array joined by space — all tags are searchable', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'doc', 'body', '["foo","bar","baz"]')];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    // Should find by any tag keyword
    const r1 = service.searchKeyword('foo', ['e1'], 10);
    expect(r1.length).toBeGreaterThan(0);
    const r2 = service.searchKeyword('bar', ['e1'], 10);
    expect(r2.length).toBeGreaterThan(0);
  });

  it('non-array JSON tags passed as-is to MiniSearch', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'doc', 'body', '"some-tag"')];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);
    await service.sync();

    // Non-array JSON string is left as-is — just shouldn't throw
    const results = service.searchKeyword('some-tag', ['e1'], 10);
    // May or may not match depending on MiniSearch tokenization, just no crash
    expect(Array.isArray(results)).toBe(true);
  });

  it('malformed JSON tags left as-is — no crash', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'doc', 'body', 'not-valid-json')];
    const repo = makeRepo(rows);
    const service = new SearchService(repo);

    // Should not throw
    await expect(service.sync()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 18. rebuildIndex (via sync)
// ---------------------------------------------------------------------------

describe('rebuildIndex via sync()', () => {
  it('after global sync, searchKeyword finds newly added documents', async () => {
    const initialRows = [makeMiniSearchRow('f1', 'e1', 'apple', 'body', '[]')];
    const repo = makeRepo(initialRows);
    const service = new SearchService(repo);
    await service.sync();

    let results = service.searchKeyword('banana', ['e1'], 10);
    expect(results).toHaveLength(0);

    const newRows = [
      ...initialRows,
      makeMiniSearchRow('f2', 'e1', 'banana split', 'body', '[]'),
    ];
    (repo.findMiniSearchRows as ReturnType<typeof vi.fn>).mockResolvedValue(newRows);
    await service.sync();

    results = service.searchKeyword('banana', ['e1'], 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('f2');
  });

  it('after entity sync, old docs removed and new ones indexed', async () => {
    const oldRows = [makeMiniSearchRow('f-old', 'e1', 'oldword', 'body', '[]')];
    const repo = makeRepo(oldRows);
    const service = new SearchService(repo);
    await service.sync('e1');

    expect(service.searchKeyword('oldword', ['e1'], 10).length).toBeGreaterThan(0);

    const newRows = [makeMiniSearchRow('f-new', 'e1', 'newword', 'body', '[]')];
    (repo.findMiniSearchRows as ReturnType<typeof vi.fn>).mockResolvedValue(newRows);
    await service.sync('e1');

    // Old doc should be gone
    expect(service.searchKeyword('oldword', ['e1'], 10)).toHaveLength(0);
    // New doc should be found
    expect(service.searchKeyword('newword', ['e1'], 10).length).toBeGreaterThan(0);
  });

  it('findMiniSearchRows is called with entityId when syncing specific entity', async () => {
    const repo = makeRepo([]);
    const service = new SearchService(repo);
    await service.sync('e1');
    expect(repo.findMiniSearchRows).toHaveBeenCalledWith('e1');
  });

  it('findMiniSearchRows is called without args when syncing globally', async () => {
    const repo = makeRepo([]);
    const service = new SearchService(repo);
    await service.sync();
    expect(repo.findMiniSearchRows).toHaveBeenCalledWith();
  });
});
