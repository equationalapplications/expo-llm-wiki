import type { EdgeRepository, NeighborhoodQueryOptions } from '../repositories/EdgeRepository';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { GraphTraversalOptions, GraphNeighborhood, WikiConfig } from '../types';

/**
 * Pure orchestrator — no SQL. Merges WikiConfig defaults with per-call options,
 * delegates the recursive walk to EdgeRepository, then hydrates node IDs into facts.
 */
export class GraphTraversalService {
  constructor(
    private edgeRepo: EdgeRepository,
    private entryRepo: EntryRepository,
    private config: WikiConfig,
  ) {}

  async traverseGraph(entityId: string, options: GraphTraversalOptions): Promise<GraphNeighborhood> {
    const fallbackMaxNodes = 20;
    const rawConfigDefault = this.config.maxTraversalNodes ?? fallbackMaxNodes;
    const defaultMaxNodes =
      Number.isFinite(rawConfigDefault) && rawConfigDefault >= 1
        ? Math.floor(rawConfigDefault)
        : fallbackMaxNodes;
    const rawMaxNodes = options.maxTraversalNodes ?? defaultMaxNodes;
    const maxNodes =
      Number.isFinite(rawMaxNodes) && rawMaxNodes >= 1 ? Math.floor(rawMaxNodes) : defaultMaxNodes;

    const opts: NeighborhoodQueryOptions = {
      maxDepth: Math.max(1, Math.min(options.maxDepth ?? 1, 3)),
      direction: options.direction ?? this.config.traversalDirection ?? 'both',
      edgeTypes: options.edgeTypes,
      minConfidence: options.minTraversalConfidence ?? this.config.minTraversalConfidence ?? 'tentative',
      excludeSourceTypes: options.excludeSourceTypes ?? this.config.excludeSourceTypes ?? [],
      maxNodes,
    };

    const { nodeIds, edges } = await this.edgeRepo.getNeighborhood(entityId, options.sourceId, opts);
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    // findByIds() returns facts in input-ID order (Map-based lookup,
    // see packages/core/src/repositories/EntryRepository.ts:104-108) — no re-sort needed.
    const nodes = await this.entryRepo.findByIds(nodeIds, [entityId]);
    const hydratedIds = new Set(nodes.map((node) => node.id));
    const filteredEdges = edges.filter(
      (edge) => hydratedIds.has(edge.source_id) && hydratedIds.has(edge.target_id),
    );
    return { nodes, edges: filteredEdges };
  }
}
