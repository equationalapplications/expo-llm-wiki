import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphTraversalService } from '../../src/services/GraphTraversalService';
import type { EdgeRepository } from '../../src/repositories/EdgeRepository';
import type { EntryRepository } from '../../src/repositories/EntryRepository';
import type { WikiConfig, WikiFact, WikiEdge } from '../../src/types';

function makeMocks() {
  const edgeRepo = {
    getNeighborhood: vi.fn(),
  } as unknown as EdgeRepository;

  const entryRepo = {
    findByIds: vi.fn(),
  } as unknown as EntryRepository;

  return { edgeRepo, entryRepo };
}

const sampleFact: WikiFact = {
  id: 'a',
  entity_id: 'entity1',
  title: 'A',
  body: 'body',
  tags: [],
  confidence: 'certain',
  source_type: 'user_stated',
  source_hash: null,
  source_ref: null,
  created_at: 1,
  updated_at: 1,
  last_accessed_at: null,
  access_count: 0,
  deleted_at: null,
};

const sampleEdge: WikiEdge = {
  id: 'e1',
  entity_id: 'entity1',
  source_id: 'a',
  target_id: 'b',
  edge_type: 'link',
  created_at: 1,
};

describe('GraphTraversalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses hardcoded defaults when neither per-call nor config values are set', async () => {
    const { edgeRepo, entryRepo } = makeMocks();
    vi.mocked(edgeRepo.getNeighborhood).mockResolvedValue({ nodeIds: ['a'], edges: [] });
    vi.mocked(entryRepo.findByIds).mockResolvedValue([sampleFact]);

    const svc = new GraphTraversalService(edgeRepo, entryRepo, {});
    await svc.traverseGraph('entity1', { sourceId: 'a' });

    expect(edgeRepo.getNeighborhood).toHaveBeenCalledWith('entity1', 'a', {
      maxDepth: 1,
      direction: 'both',
      edgeTypes: undefined,
      minConfidence: 'tentative',
      excludeSourceTypes: [],
      maxNodes: 20,
    });
  });

  it('uses config defaults when no per-call option is given', async () => {
    const { edgeRepo, entryRepo } = makeMocks();
    vi.mocked(edgeRepo.getNeighborhood).mockResolvedValue({ nodeIds: ['a'], edges: [] });
    vi.mocked(entryRepo.findByIds).mockResolvedValue([sampleFact]);

    const config: WikiConfig = {
      maxTraversalNodes: 5,
      minTraversalConfidence: 'certain',
      traversalDirection: 'outbound',
      excludeSourceTypes: ['immutable_document'],
    };
    const svc = new GraphTraversalService(edgeRepo, entryRepo, config);
    await svc.traverseGraph('entity1', { sourceId: 'a' });

    expect(edgeRepo.getNeighborhood).toHaveBeenCalledWith('entity1', 'a', {
      maxDepth: 1,
      direction: 'outbound',
      edgeTypes: undefined,
      minConfidence: 'certain',
      excludeSourceTypes: ['immutable_document'],
      maxNodes: 5,
    });
  });

  it('per-call options override config defaults', async () => {
    const { edgeRepo, entryRepo } = makeMocks();
    vi.mocked(edgeRepo.getNeighborhood).mockResolvedValue({ nodeIds: ['a'], edges: [] });
    vi.mocked(entryRepo.findByIds).mockResolvedValue([sampleFact]);

    const config: WikiConfig = {
      maxTraversalNodes: 5,
      minTraversalConfidence: 'certain',
      traversalDirection: 'outbound',
      excludeSourceTypes: ['immutable_document'],
    };
    const svc = new GraphTraversalService(edgeRepo, entryRepo, config);
    await svc.traverseGraph('entity1', {
      sourceId: 'a',
      maxDepth: 2,
      direction: 'inbound',
      maxTraversalNodes: 8,
      minTraversalConfidence: 'tentative',
      excludeSourceTypes: ['user_stated'],
    });

    expect(edgeRepo.getNeighborhood).toHaveBeenCalledWith('entity1', 'a', {
      maxDepth: 2,
      direction: 'inbound',
      edgeTypes: undefined,
      minConfidence: 'tentative',
      excludeSourceTypes: ['user_stated'],
      maxNodes: 8,
    });
  });

  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 3],
    [-5, 1],
  ])('clamps maxDepth=%d to %d', async (input, expected) => {
    const { edgeRepo, entryRepo } = makeMocks();
    vi.mocked(edgeRepo.getNeighborhood).mockResolvedValue({ nodeIds: ['a'], edges: [] });
    vi.mocked(entryRepo.findByIds).mockResolvedValue([sampleFact]);

    const svc = new GraphTraversalService(edgeRepo, entryRepo, {});
    await svc.traverseGraph('entity1', { sourceId: 'a', maxDepth: input });

    expect(edgeRepo.getNeighborhood).toHaveBeenCalledWith(
      'entity1',
      'a',
      expect.objectContaining({ maxDepth: expected }),
    );
  });

  it('passes edgeTypes: [] through unchanged (does not default it away)', async () => {
    const { edgeRepo, entryRepo } = makeMocks();
    vi.mocked(edgeRepo.getNeighborhood).mockResolvedValue({ nodeIds: ['a'], edges: [] });
    vi.mocked(entryRepo.findByIds).mockResolvedValue([sampleFact]);

    const svc = new GraphTraversalService(edgeRepo, entryRepo, {});
    await svc.traverseGraph('entity1', { sourceId: 'a', edgeTypes: [] });

    expect(edgeRepo.getNeighborhood).toHaveBeenCalledWith(
      'entity1',
      'a',
      expect.objectContaining({ edgeTypes: [] }),
    );
  });

  it('returns empty result without calling findByIds when getNeighborhood finds nothing', async () => {
    const { edgeRepo, entryRepo } = makeMocks();
    vi.mocked(edgeRepo.getNeighborhood).mockResolvedValue({ nodeIds: [], edges: [] });

    const svc = new GraphTraversalService(edgeRepo, entryRepo, {});
    const result = await svc.traverseGraph('entity1', { sourceId: 'missing' });

    expect(result).toEqual({ nodes: [], edges: [] });
    expect(entryRepo.findByIds).not.toHaveBeenCalled();
  });

  it('hydrates node IDs into facts scoped to entityId and drops dangling edges', async () => {
    const { edgeRepo, entryRepo } = makeMocks();
    vi.mocked(edgeRepo.getNeighborhood).mockResolvedValue({ nodeIds: ['a', 'b'], edges: [sampleEdge] });
    vi.mocked(entryRepo.findByIds).mockResolvedValue([sampleFact]);

    const svc = new GraphTraversalService(edgeRepo, entryRepo, {});
    const result = await svc.traverseGraph('entity1', { sourceId: 'a' });

    expect(entryRepo.findByIds).toHaveBeenCalledWith(['a', 'b'], ['entity1']);
    expect(result).toEqual({ nodes: [sampleFact], edges: [] });
  });

  it.each([
    [0, 20],
    [-1, 20],
    [NaN, 20],
    [Infinity, 20],
    [1.9, 1],
    [5, 5],
  ])('sanitizes maxTraversalNodes=%s to %s', async (input, expected) => {
    const { edgeRepo, entryRepo } = makeMocks();
    vi.mocked(edgeRepo.getNeighborhood).mockResolvedValue({ nodeIds: ['a'], edges: [] });
    vi.mocked(entryRepo.findByIds).mockResolvedValue([sampleFact]);

    const svc = new GraphTraversalService(edgeRepo, entryRepo, {});
    await svc.traverseGraph('entity1', { sourceId: 'a', maxTraversalNodes: input });

    expect(edgeRepo.getNeighborhood).toHaveBeenCalledWith(
      'entity1',
      'a',
      expect.objectContaining({ maxNodes: expected }),
    );
  });
});
