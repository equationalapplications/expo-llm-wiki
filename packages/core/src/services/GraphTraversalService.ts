import type { EdgeRepository, NeighborhoodQueryOptions } from '../repositories/EdgeRepository';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { GraphTraversalOptions, GraphNeighborhood, WikiConfig } from '../types';
import { WikiInvalidReadOptions } from '../types';
import { isLiveAt } from '../utils/temporal';
import { packFactsByBudget, factTokenCost } from '../utils/budget';

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

    const rawAsOf = options.asOf;
    if (rawAsOf !== undefined && !(typeof rawAsOf === 'number' && Number.isFinite(rawAsOf) && rawAsOf >= 0)) {
      throw new WikiInvalidReadOptions('asOf', 'must be a finite epoch-ms number >= 0');
    }
    const rawTokenBudget = options.tokenBudget;
    if (rawTokenBudget !== undefined && !(typeof rawTokenBudget === 'number' && Number.isFinite(rawTokenBudget) && rawTokenBudget >= 0)) {
      throw new WikiInvalidReadOptions('tokenBudget', 'must be a finite number >= 0');
    }
    const live = rawAsOf === undefined
      ? { mode: 'current' as const, t: Date.now() }
      : { mode: 'asOf' as const, t: Math.trunc(rawAsOf) };

    const opts: NeighborhoodQueryOptions = {
      maxDepth: Math.max(1, Math.min(options.maxDepth ?? 1, 3)),
      direction: options.direction ?? this.config.traversalDirection ?? 'both',
      edgeTypes: options.edgeTypes,
      minConfidence: options.minTraversalConfidence ?? this.config.minTraversalConfidence ?? 'tentative',
      excludeSourceTypes: options.excludeSourceTypes ?? this.config.excludeSourceTypes ?? [],
      excludeDrafts: options.excludeDrafts ?? this.config.excludeDrafts ?? false,
      live,
      maxNodes,
    };

    const { nodeIds, edges } = await this.edgeRepo.getNeighborhood(entityId, options.sourceId, opts);
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    // Spec §10.7: a non-live anchor returns alone — both endpoints of a
    // walkable edge must be live at the query instant.
    const [anchor] = await this.entryRepo.findByIds([options.sourceId], [entityId]);
    if (anchor && !isLiveAt(anchor, live.mode, live.t)) return { nodes: [anchor], edges: [] };

    // findByIds() returns facts in input-ID order (Map-based lookup,
    // see packages/core/src/repositories/EntryRepository.ts:104-108) — no re-sort needed.
    const nodes = await this.entryRepo.findByIds(nodeIds, [entityId]);
    const hydratedIds = new Set(nodes.map((node) => node.id));
    const filteredEdges = edges.filter(
      (edge) => hydratedIds.has(edge.source_id) && hydratedIds.has(edge.target_id),
    );
    if (options.tokenBudget === undefined) return { nodes, edges: filteredEdges };
    const budget = Math.trunc(options.tokenBudget);
    const [anchorPacked] = packFactsByBudget([nodes[0]], budget).items;
    const kept = [anchorPacked];
    let used = factTokenCost(anchorPacked);
    for (const node of nodes.slice(1)) {
      const cost = factTokenCost(node);
      if (used + cost <= budget) { kept.push(node); used += cost; }
    }
    const keptIds = new Set(kept.map((n) => n.id));
    return { nodes: kept, edges: filteredEdges.filter((e) => keptIds.has(e.source_id) && keptIds.has(e.target_id)) };
  }
}
