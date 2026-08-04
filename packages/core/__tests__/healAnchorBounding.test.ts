import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaintenanceService, HEAL_MAX_ANCHORS } from '../src/services/MaintenanceService';
import { PromptService } from '../src/services/PromptService';
import type { WikiFact } from '../src/types';

function makeFact(id: string, sourceType: string, title = `title ${id}`): WikiFact {
  return {
    id, entity_id: 'e1', title, body: `body ${id}`, tags: '[]' as any, confidence: 'inferred',
    source_type: sourceType as any, source_hash: null, source_ref: null,
    created_at: 1, updated_at: 1, last_accessed_at: null, access_count: 0, deleted_at: null,
  } as WikiFact;
}

describe('doRunHeal — bounded anchors and batched candidates (#63)', () => {
  let mockDb: any;
  let mockOptions: any;
  let mockEntryRepo: any;
  let mockTaskRepo: any;
  let mockEventRepo: any;
  let mockSearchService: any;
  let mockJobManager: any;
  let mockEmbeddingService: any;
  let buildHealSpy: any;

  const CANDIDATES = 30;
  const ANCHORS = 2560;

  beforeEach(() => {
    mockDb = {
      withTransactionAsync: vi.fn(async (fn: (tx: any) => Promise<void>) => fn(mockDb)),
      runAsync: vi.fn().mockResolvedValue({ changes: 0, lastInsertRowId: 0 }),
    };
    mockOptions = {
      llmProvider: {
        generateText: vi.fn().mockResolvedValue(
          JSON.stringify({ downgraded: [], deleted: [], newFacts: [] }),
        ),
      },
    };
    const candidates = Array.from({ length: CANDIDATES }, (_, i) => makeFact(`c${i}`, 'librarian_inferred'));
    const anchorIds = Array.from({ length: ANCHORS }, (_, i) => `a${i}`);

    mockEntryRepo = {
      findHealCandidatesByEntityId: vi.fn().mockResolvedValue(candidates),
      findAllByEntityId: vi.fn(() => { throw new Error('heal must not load every fact'); }),
      findAnchorRowsByIds: vi.fn(async (_entityId: string, ids: string[]) =>
        ids.map(id => ({ id, title: `title ${id}`, source_ref: `doc://${id}` })),
      ),
      markOrphaned: vi.fn().mockResolvedValue([]),
      downgradeStaleInferred: vi.fn().mockResolvedValue(undefined),
      downgradeByIds: vi.fn().mockResolvedValue(undefined),
      softDeleteByIds: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    mockTaskRepo = { findAllPending: vi.fn().mockResolvedValue([]) };
    mockEventRepo = { getRecent: vi.fn().mockResolvedValue([]) };
    mockSearchService = {
      sync: vi.fn().mockResolvedValue(undefined),
      evictCache: vi.fn(),
      // Every anchor matches, plus a non-anchor the SQL filter must drop.
      searchKeyword: vi.fn(() => [...anchorIds, 'c0'].map(id => ({ id, score: 1 }))),
    };
    mockJobManager = { acquireLock: vi.fn(), releaseLock: vi.fn() };
    mockEmbeddingService = {
      embedFact: vi.fn().mockResolvedValue(true),
      notifyEmbeddingPersisted: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeService() {
    const promptService = new PromptService();
    buildHealSpy = vi.spyOn(promptService, 'buildHealPrompt');
    return new MaintenanceService(
      mockDb, 'llm_wiki_', mockOptions,
      mockEntryRepo, mockTaskRepo, mockEventRepo, {} as any,
      mockSearchService, mockJobManager, mockEmbeddingService,
      promptService,
    );
  }

  it('caps anchors per call regardless of corpus size', async () => {
    const svc = makeService();
    await svc.runHeal('e1');

    expect(buildHealSpy).toHaveBeenCalled();
    for (const call of buildHealSpy.mock.calls) {
      const anchors = call[1] as Array<{ id: string }>;
      expect(anchors.length).toBeLessThanOrEqual(HEAL_MAX_ANCHORS);
    }
  });

  it('drops non-anchor search hits — the index is not anchor-only', async () => {
    const svc = makeService();
    await svc.runHeal('e1');

    for (const call of buildHealSpy.mock.calls) {
      const anchors = call[1] as Array<{ id: string }>;
      expect(anchors.map(a => a.id)).not.toContain('c0');
    }
    // The source-type filter is applied after retrieval, in SQL.
    expect(mockEntryRepo.findAnchorRowsByIds).toHaveBeenCalled();
  });

  it('never loads every fact for the entity', async () => {
    const svc = makeService();
    await svc.runHeal('e1');
    expect(mockEntryRepo.findHealCandidatesByEntityId).toHaveBeenCalledWith('e1');
    expect(mockEntryRepo.findAllByEntityId).not.toHaveBeenCalled();
  });

  it('batches candidates across several calls instead of one giant prompt', async () => {
    const svc = makeService();
    await svc.runHeal('e1');

    expect(mockOptions.llmProvider.generateText.mock.calls.length).toBeGreaterThan(1);
    const sentCandidateCounts = buildHealSpy.mock.calls.map((c: any[]) => (c[0] as unknown[]).length);
    expect(Math.max(...sentCandidateCounts)).toBeLessThan(CANDIDATES);
  });

  it('only applies model output for ids offered in that same batch', async () => {
    mockOptions.llmProvider.generateText.mockResolvedValue(
      // c0 is a real candidate; a0 is an anchor and must never be touched.
      JSON.stringify({ downgraded: ['c0', 'a0'], deleted: [], newFacts: [] }),
    );
    const svc = makeService();
    await svc.runHeal('e1');

    const downgradedIds = mockEntryRepo.downgradeByIds.mock.calls[0][0] as string[];
    expect(downgradedIds).toContain('c0');
    expect(downgradedIds).not.toContain('a0');
  });

  it('resolves anchors at most once per distinct batch, not once per prompt build', async () => {
    // Anchor selection costs a keyword search plus a repository read, and
    // runBatched builds a prompt more than once per batch it sends — trimming
    // to maxPromptChars, and again per half when a batch splits. Those repeats
    // share prefixes, so the per-pass memo must collapse them.
    const svc = makeService();
    await svc.runHeal('e1');

    const distinctQueries = new Set(
      mockSearchService.searchKeyword.mock.calls.map((c: any[]) => c[0] as string),
    );
    expect(mockSearchService.searchKeyword.mock.calls.length).toBe(distinctQueries.size);
    expect(mockEntryRepo.findAnchorRowsByIds.mock.calls.length).toBeLessThanOrEqual(
      distinctQueries.size,
    );
  });
});
