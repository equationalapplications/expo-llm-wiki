import { describe, it, expect, vi, beforeEach } from 'vitest';
import MiniSearch from 'minisearch';
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

  it('resets the minisearch dirt counter that removeAll() leaves behind', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeMiniSearchRow(`f${i}`, 'e1', `word${i}`));
    const { repo } = makeLiveRepo(rows);
    const service = new SearchService(repo);
    await service.sync('e1');

    // Accrue dirt with a raw discard: syncEntries vacuums its own discards
    // away (see the syncEntries suite), so the private index is the honest
    // way to leave dirtCount > 0 behind.
    (service as any).miniSearch.discard('f3');
    expect((service as any).miniSearch.dirtCount).toBe(1);

    // minisearch 7.2.0's removeAll() does not reset dirtCount (or its vacuum
    // bookkeeping); clearAll must swap in a fresh index so "fully resets"
    // holds.
    service.clearAll();
    expect((service as any).miniSearch.dirtCount).toBe(0);
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

// ---------------------------------------------------------------------------
// Concurrent sync() — #64
// ---------------------------------------------------------------------------

describe('sync() concurrency', () => {
  /**
   * Repo whose findMiniSearchRows snapshots the "database" at call time and
   * resolves after a scripted delay. Concurrent rebuilds therefore let a slow,
   * stale read land after a fast, fresh one and clobber it. Serialized
   * rebuilds read at their own turn and cannot.
   */
  function makeScriptedRepo(
    dbRows: { current: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> },
    delaysMs: number[],
  ) {
    let call = 0;
    const inFlight = { max: 0, now: 0 };
    // sync() does all its work inside a .then(), so nothing reads the "database"
    // synchronously. A test that mutates dbRows right after calling sync() would
    // mutate it *before* the first read and prove nothing; firstRead lets a test
    // wait until the first read has actually snapshotted.
    let signalFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    const repo = {
      findMiniSearchRows: vi.fn(async () => {
        const snapshot = dbRows.current.slice();
        const delay = delaysMs[call++] ?? 0;
        signalFirstRead();
        inFlight.now++;
        inFlight.max = Math.max(inFlight.max, inFlight.now);
        await new Promise((resolve) => setTimeout(resolve, delay));
        inFlight.now--;
        return snapshot;
      }),
    } as unknown as EntryRepository;
    return { repo, inFlight, firstRead };
  }

  it('a slow stale rebuild does not clobber a fast fresh one', async () => {
    const dbRows = {
      current: [makeMiniSearchRow('f1', 'e1', 'alpha')],
    };
    // First sync reads slowly, second reads fast — without serialization the
    // first finishes last and discards f2.
    const { repo, firstRead } = makeScriptedRepo(dbRows, [40, 0]);
    const service = new SearchService(repo);

    const first = service.sync('e1');
    // Only after the first (slow) read has snapshotted the old rows does f2
    // land. Concurrently, the second read would then pick f2 up and finish
    // first, and the stale first read would overwrite the index without it.
    await firstRead;
    dbRows.current = [makeMiniSearchRow('f1', 'e1', 'alpha'), makeMiniSearchRow('f2', 'e1', 'beta')];
    const second = service.sync('e1');
    await Promise.all([first, second]);

    const ids = service.searchKeyword('alpha beta', ['e1'], 10).map((r) => r.id).sort();
    expect(ids).toEqual(['f1', 'f2']);
  });

  it('never runs two rebuilds at once', async () => {
    const dbRows = { current: [makeMiniSearchRow('f1', 'e1')] };
    const { repo, inFlight } = makeScriptedRepo(dbRows, [30, 20, 10, 0, 0]);
    const service = new SearchService(repo);

    await Promise.all([
      service.sync('e1'),
      service.sync('e1'),
      service.sync('e1'),
      service.sync('e1'),
      service.sync('e1'),
    ]);

    expect(repo.findMiniSearchRows).toHaveBeenCalledTimes(5);
    expect(inFlight.max).toBe(1);
  });

  it('a rebuild failure warns instead of escaping as a rejection, and the chain survives', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'alpha')];
    let shouldFail = true;
    const repo = {
      findMiniSearchRows: vi.fn(async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('boom');
        }
        return rows;
      }),
    } as unknown as EntryRepository;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new SearchService(repo);

    await expect(service.sync('e1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('search index rebuild failed'),
      expect.any(Error),
    );

    // Chain is not poisoned: the next sync still runs and indexes.
    await service.sync('e1');
    expect(service.searchKeyword('alpha', ['e1'], 10).map((r) => r.id)).toEqual(['f1']);

    warn.mockRestore();
  });

  it('vacuums explicitly and does not leave auto-vacuum armed', async () => {
    const vacuumSpy = vi.spyOn(MiniSearch.prototype, 'vacuum').mockResolvedValue(undefined as never);
    const repo = makeRepo([makeMiniSearchRow('f1', 'e1')]);
    const service = new SearchService(repo);

    await service.sync('e1');

    expect(vacuumSpy).toHaveBeenCalledTimes(1);
    // Reading MiniSearch's internal options is deliberate: autoVacuum has no
    // public getter, and the whole point of B2 is that it is off.
    expect((service as any).miniSearch._options.autoVacuum).toBe(false);

    vacuumSpy.mockRestore();
  });

  it('a throw from cache eviction does not poison the chain for later syncs', async () => {
    // evictCache runs after the rebuild on every sync. If it threw outside the
    // guard it would reject the chain promise, and because each sync chains off
    // the previous one, every subsequent sync would reject forever — the same
    // unhandled rejection this method exists to prevent, just one step removed.
    const repo = makeRepo([makeMiniSearchRow('f1', 'e1', 'alpha')]);
    const service = new SearchService(repo);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evict = vi.spyOn(service, 'evictCache').mockImplementationOnce(() => {
      throw new Error('cache eviction blew up');
    });

    await expect(service.sync('e1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('search index rebuild failed'),
      expect.any(Error),
    );

    // The chain still works, and the index from the failed turn is intact —
    // eviction runs after the rebuild, so the rebuild itself had committed.
    await expect(service.sync('e1')).resolves.toBeUndefined();
    expect(service.searchKeyword('alpha', ['e1'], 10).map((r) => r.id)).toEqual(['f1']);

    evict.mockRestore();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// syncEntries — incremental index updates (#232)
// ---------------------------------------------------------------------------

type MsRow = { id: string; entity_id: string; title: string; body: string; tags: string };

/** In-memory "live rows" table; soft-deleting a row = removing it from `live.rows`. */
function makeLiveRepo(initial: MsRow[]) {
  const live = { rows: initial.slice() };
  const findMiniSearchRows = vi.fn(async (entityId?: string) =>
    live.rows.filter((r) => entityId === undefined || r.entity_id === entityId));
  const findMiniSearchRowsByIds = vi.fn(async (entityId: string, ids: readonly string[]) =>
    live.rows.filter((r) => r.entity_id === entityId && ids.includes(r.id)));
  const repo = { findMiniSearchRows, findMiniSearchRowsByIds } as unknown as EntryRepository;
  return { repo, live, findMiniSearchRows, findMiniSearchRowsByIds };
}

const hits = (service: SearchService, query: string, entityIds = ['e1']) =>
  service.searchKeyword(query, entityIds, 100).map((r) => r.id).sort();

describe('syncEntries', () => {
  it('indexes new ids by reading only those rows', async () => {
    const { repo, live, findMiniSearchRows, findMiniSearchRowsByIds } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');
    findMiniSearchRows.mockClear();

    live.rows.push(makeMiniSearchRow('f2', 'e1', 'banana'));
    await service.syncEntries('e1', ['f2']);

    expect(findMiniSearchRowsByIds).toHaveBeenCalledWith('e1', ['f2']);
    expect(findMiniSearchRows).not.toHaveBeenCalled();
    expect(hits(service, 'banana')).toEqual(['f2']);
    expect(hits(service, 'apple')).toEqual(['f1']);
  });

  it('replaces an updated row', async () => {
    const { repo, live } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');

    live.rows[0] = makeMiniSearchRow('f1', 'e1', 'cherry');
    await service.syncEntries('e1', ['f1']);

    expect(hits(service, 'apple')).toEqual([]);
    expect(hits(service, 'cherry')).toEqual(['f1']);
  });

  it('removes a soft-deleted row', async () => {
    const { repo, live } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');

    live.rows = [];
    await service.syncEntries('e1', ['f1']);

    expect(hits(service, 'apple')).toEqual([]);
  });

  it('skips a tracked id the index no longer holds instead of throwing at it', async () => {
    // The drifted state a failed rebuild can leave behind: rebuildIndex
    // discards the previous ids and only then replaces the tracked set, so a
    // throw in between leaves the set claiming ids the index has already
    // dropped. discard() on such an id throws ("it is not in the index").
    const { repo } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (service as any).miniSearch.discard('f1'); // index loses f1; tracked set still has it

    await expect(service.syncEntries('e1', ['f1'])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(hits(service, 'apple')).toEqual(['f1']); // re-added from the live row

    warn.mockRestore();
  });

  it('never touches an id indexed under another entity', async () => {
    const { repo } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple'), makeMiniSearchRow('g1', 'e2', 'apple')]);
    const service = new SearchService(repo);
    await service.sync();

    await service.syncEntries('e1', ['g1']);

    expect(hits(service, 'apple', ['e2'])).toEqual(['g1']);
    expect(hits(service, 'apple', ['e1'])).toEqual(['f1']);
  });

  it('ignores ids that are neither indexed nor live', async () => {
    const { repo } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(service.syncEntries('e1', ['nope'])).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
    expect(hits(service, 'apple')).toEqual(['f1']);
    warn.mockRestore();
  });

  it('makes no repository call for an empty id list on a tracked entity', async () => {
    const { repo, findMiniSearchRows, findMiniSearchRowsByIds } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');
    findMiniSearchRows.mockClear();

    await service.syncEntries('e1', []);

    expect(findMiniSearchRows).not.toHaveBeenCalled();
    expect(findMiniSearchRowsByIds).not.toHaveBeenCalled();
  });

  it('an empty-id early return still waits for an already-queued rebuild', async () => {
    // A forget() or global sync() rebuild is queued and mid-read when a write
    // dedups down to an empty id set. The old `await sync(entityId)` tail
    // waited for that rebuild; the early return must not skip past it, or the
    // host's next search reads a pre-rebuild index (read-after-write).
    const rows = [makeMiniSearchRow('f1', 'e1', 'apple')];
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    const repo = {
      findMiniSearchRows: vi.fn(async () => {
        if (readCount++ === 0) return rows; // initial sync completes, entity tracked
        signalFirstRead();
        await readGate; // the queued rebuild's read hangs
        return rows;
      }),
      findMiniSearchRowsByIds: vi.fn(async () => []),
    } as unknown as EntryRepository;
    const service = new SearchService(repo);
    let readCount = 0;

    await service.sync('e1'); // registers the entity

    const queued = service.sync('e1');
    await firstRead; // the rebuild's read is in flight

    const empty = service.syncEntries('e1', []);
    let resolved = false;
    void empty.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false); // gated on the queued rebuild, not resolved early

    releaseRead();
    await Promise.all([queued, empty]);
    expect(resolved).toBe(true);
    expect(repo.findMiniSearchRowsByIds).not.toHaveBeenCalled();
  });

  it('on an empty id list for a never-indexed entity: rebuilds it in full and registers it', async () => {
    const { repo, live, findMiniSearchRows, findMiniSearchRowsByIds } = makeLiveRepo([
      makeMiniSearchRow('f0', 'e1', 'cherry'),
      makeMiniSearchRow('f1', 'e1', 'apple'),
    ]);
    const service = new SearchService(repo);

    await service.syncEntries('e1', []);

    expect(findMiniSearchRows).toHaveBeenCalledWith('e1');
    expect(findMiniSearchRowsByIds).not.toHaveBeenCalled();
    expect(hits(service, 'apple')).toEqual(['f1']);
    expect(hits(service, 'cherry')).toEqual(['f0']);

    // The rebuild registered the entity, so the next sync stays incremental.
    findMiniSearchRows.mockClear();
    live.rows.push(makeMiniSearchRow('f2', 'e1', 'banana'));
    await service.syncEntries('e1', ['f2']);

    expect(findMiniSearchRowsByIds).toHaveBeenCalledWith('e1', ['f2']);
    expect(findMiniSearchRows).not.toHaveBeenCalled();
    expect(hits(service, 'banana')).toEqual(['f2']);
  });

  it('falls back to a full entity rebuild for an entity it has never indexed', async () => {
    const { repo, findMiniSearchRows, findMiniSearchRowsByIds } = makeLiveRepo([
      makeMiniSearchRow('f0', 'e1', 'cherry'),
      makeMiniSearchRow('f1', 'e1', 'apple'),
    ]);
    const service = new SearchService(repo);

    await service.syncEntries('e1', ['f1']);

    expect(findMiniSearchRows).toHaveBeenCalledWith('e1');
    expect(findMiniSearchRowsByIds).not.toHaveBeenCalled();
    expect(hits(service, 'apple')).toEqual(['f1']);
    expect(hits(service, 'cherry')).toEqual(['f0']);
  });

  it('on a failed read: warns, leaves the index unchanged, and rebuilds the entity next time', async () => {
    const { repo, live, findMiniSearchRows, findMiniSearchRowsByIds } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    findMiniSearchRowsByIds.mockRejectedValueOnce(new Error('boom'));

    live.rows.push(makeMiniSearchRow('f2', 'e1', 'banana'));
    await expect(service.syncEntries('e1', ['f2'])).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('search index incremental sync failed for e1'),
      expect.any(Error),
    );
    expect(hits(service, 'apple')).toEqual(['f1']);
    expect(hits(service, 'banana')).toEqual([]);

    // Stale → the next call rebuilds the entity in full, even with no ids.
    findMiniSearchRows.mockClear();
    await service.syncEntries('e1', []);
    expect(findMiniSearchRows).toHaveBeenCalledWith('e1');
    expect(hits(service, 'banana')).toEqual(['f2']);

    // …and after that it is incremental again.
    findMiniSearchRows.mockClear();
    await service.syncEntries('e1', ['f2']);
    expect(findMiniSearchRows).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a markStale() landing mid-rebuild-read is not cleared by that rebuild', async () => {
    // markStale fires inside the host's still-open transaction, so a rebuild
    // whose read is in flight when it lands cannot have seen those rows —
    // completing the rebuild must not clear the flag, or the rows stay
    // unindexed until some unrelated full rebuild.
    const rows = [makeMiniSearchRow('f1', 'e1', 'apple')];
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    const repo = {
      findMiniSearchRows: vi.fn(async () => {
        signalFirstRead();
        await readGate;
        return rows;
      }),
      findMiniSearchRowsByIds: vi.fn(async () => []),
    } as unknown as EntryRepository;
    const service = new SearchService(repo);

    const rebuilding = service.sync('e1');
    await firstRead; // the rebuild's read is in flight
    service.markStale('e1'); // the host's upsertGraph marks stale mid-read
    releaseRead();
    await rebuilding;

    // The turn completed, but the flag set during its read survives…
    expect((service as any).staleEntities.has('e1')).toBe(true);

    // …so the next syncEntries still rebuilds in full instead of going
    // incremental on an index that missed the host's rows.
    (repo.findMiniSearchRows as ReturnType<typeof vi.fn>).mockClear();
    await service.syncEntries('e1', []);
    expect(repo.findMiniSearchRows).toHaveBeenCalledWith('e1');
  });

  it('syncEntries does not clear a markStale() that lands during its own rebuild read', async () => {
    // The counterpart to the case above, on syncEntries' own rebuild path: the
    // epoch is snapshotted before rebuildIndex, and clearing the flag is gated
    // on that snapshot surviving the read. A markStale landing mid-read belongs
    // to rows the read cannot have seen, so the flag must outlive the turn.
    const rows = [makeMiniSearchRow('f1', 'e1', 'apple')];
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    const repo = {
      findMiniSearchRows: vi.fn(async () => {
        signalFirstRead();
        await readGate;
        return rows;
      }),
      findMiniSearchRowsByIds: vi.fn(async () => []),
    } as unknown as EntryRepository;
    const service = new SearchService(repo);

    // Never indexed, so syncEntries falls back to the full-rebuild path.
    const rebuilding = service.syncEntries('e1', ['f1']);
    await firstRead; // the rebuild's read is in flight
    service.markStale('e1'); // the host's upsertGraph marks stale mid-read
    releaseRead();
    await rebuilding;

    expect((service as any).staleEntities.has('e1')).toBe(true);

    // …so the next call still rebuilds in full rather than going incremental
    // on an index that missed the host's rows.
    (repo.findMiniSearchRows as ReturnType<typeof vi.fn>).mockClear();
    (repo.findMiniSearchRowsByIds as ReturnType<typeof vi.fn>).mockClear();
    await service.syncEntries('e1', ['f1']);
    expect(repo.findMiniSearchRows).toHaveBeenCalledWith('e1');
    expect(repo.findMiniSearchRowsByIds).not.toHaveBeenCalled();
  });

  it('markStale forces one full rebuild; sync() clears the flag', async () => {
    const { repo, findMiniSearchRows, findMiniSearchRowsByIds } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');

    service.markStale('e1');
    findMiniSearchRows.mockClear();
    await service.syncEntries('e1', ['f1']);
    expect(findMiniSearchRows).toHaveBeenCalledWith('e1');
    expect(findMiniSearchRowsByIds).not.toHaveBeenCalled();

    findMiniSearchRows.mockClear();
    await service.syncEntries('e1', ['f1']);
    expect(findMiniSearchRows).not.toHaveBeenCalled();
    expect(findMiniSearchRowsByIds).toHaveBeenCalledTimes(1);

    service.markStale('e1');
    await service.sync('e1');
    findMiniSearchRows.mockClear();
    await service.syncEntries('e1', ['f1']);
    expect(findMiniSearchRows).not.toHaveBeenCalled();
  });

  it('after clearAll(), takes the full-rebuild path instead of a duplicate-id addAll', async () => {
    const { repo, findMiniSearchRows } = makeLiveRepo([makeMiniSearchRow('f1', 'e1', 'apple')]);
    const service = new SearchService(repo);
    await service.sync('e1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    service.clearAll();
    findMiniSearchRows.mockClear();
    await service.syncEntries('e1', ['f1']);

    expect(findMiniSearchRows).toHaveBeenCalledWith('e1');
    expect(warn).not.toHaveBeenCalled();
    expect(hits(service, 'apple')).toEqual(['f1']);
    warn.mockRestore();
  });

  it('never overlaps a sync() turn', async () => {
    const rows = [makeMiniSearchRow('f1', 'e1', 'apple')];
    const inFlight = { now: 0, max: 0 };
    const slow = async <T>(value: T, ms: number): Promise<T> => {
      inFlight.now++;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight.now--;
      return value;
    };
    const repo = {
      findMiniSearchRows: vi.fn((entityId?: string) => slow(rows.filter((r) => !entityId || r.entity_id === entityId), 15)),
      findMiniSearchRowsByIds: vi.fn((entityId: string, ids: readonly string[]) =>
        slow(rows.filter((r) => r.entity_id === entityId && ids.includes(r.id)), 5)),
    } as unknown as EntryRepository;
    const service = new SearchService(repo);
    await service.sync('e1');

    await Promise.all([
      service.syncEntries('e1', ['f1']),
      service.sync('e1'),
      service.syncEntries('e1', ['f1']),
      service.sync('e1'),
    ]);

    expect(inFlight.max).toBe(1);
    expect(hits(service, 'apple')).toEqual(['f1']);
  });

  it('equal-score results survive a limit identically before and after an incremental re-index', async () => {
    // Ten identical rows score identically, so the only thing distinguishing
    // them is MiniSearch's internal insertion order — which syncEntries
    // changes by discarding and re-adding the touched id. Callers truncate to
    // a limit, so the ids surviving the tie must not depend on write history.
    const rows = Array.from({ length: 10 }, (_, i) => makeMiniSearchRow(`f${i}`, 'e1', 'same', 'same', '[]'));
    const { repo } = makeLiveRepo(rows);
    const service = new SearchService(repo);
    await service.sync('e1');

    const before = service.searchKeyword('same', ['e1'], 5).map((r) => r.id);
    await service.syncEntries('e1', ['f3']);
    const after = service.searchKeyword('same', ['e1'], 5).map((r) => r.id);

    expect(before).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(after).toEqual(before);
  });

  it('getMiniSearchScores truncates equal scores by id, not insertion order', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => makeMiniSearchRow(`f${i}`, 'e1', 'same', 'same', '[]'));
    const { repo } = makeLiveRepo(rows);
    const service = new SearchService(repo);
    await service.sync('e1');

    const before = [...service.getMiniSearchScores('same', ['e1'], 5).keys()];
    await service.syncEntries('e1', ['f3']);
    const after = [...service.getMiniSearchScores('same', ['e1'], 5).keys()];

    expect(before).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(after).toEqual(before);
  });

  it('vacuums after a turn that discarded, never after an add-only turn', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => makeMiniSearchRow(`f${i}`, 'e1', `word${i}`));
    const { repo, live } = makeLiveRepo(rows);
    const service = new SearchService(repo);
    await service.sync('e1');
    const vacuumSpy = vi.spyOn(MiniSearch.prototype, 'vacuum'); // spy-through: the real vacuum must run
    vacuumSpy.mockClear(); // sync()'s own unconditional vacuum

    // Add-only: appending a fresh fact accrues no dirt, so the #232 fast path
    // (chunked merge imports) pays no O(index) vacuum.
    live.rows.push(makeMiniSearchRow('fnew', 'e1', 'brandnew'));
    await service.syncEntries('e1', ['fnew']);
    expect(vacuumSpy).not.toHaveBeenCalled();

    // A discard leaves dirt, and dirt inverts term-sharing scores until a
    // vacuum — so the turn that discarded must vacuum it away.
    live.rows[0] = makeMiniSearchRow('f0', 'e1', 'rewritten');
    await service.syncEntries('e1', ['f0']);
    expect(vacuumSpy).toHaveBeenCalledTimes(1);
    expect((service as any).miniSearch.dirtCount).toBe(0);

    vacuumSpy.mockRestore();
  });
});
