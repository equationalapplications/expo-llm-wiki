import { BaseRepository } from './BaseRepository';
import type { WikiEdge, SQLiteAdapter } from '../types';

export interface NeighborhoodQueryOptions {
  maxDepth: number; // already clamped to [1,3] by the caller (GraphTraversalService)
  direction: 'inbound' | 'outbound' | 'both';
  edgeTypes?: string[]; // undefined = no filter; [] = match nothing (short-circuits)
  minConfidence: 'certain' | 'inferred' | 'tentative';
  excludeSourceTypes: string[];
  maxNodes: number;
}

const CONFIDENCE_RANK: Record<'tentative' | 'inferred' | 'certain', number> = {
  tentative: 0,
  inferred: 1,
  certain: 2,
};

export class EdgeRepository extends BaseRepository {
  /**
   * Insert an edge, silently skipping on primary-key or uniqueness conflicts.
   * Throws when the insert was skipped due to an id collision with a different edge tuple.
   */
  async addIgnoreDuplicate(edge: WikiEdge, tx?: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    const result = await executor.runAsync(
      `INSERT OR IGNORE INTO ${this.prefix}edges (id, entity_id, source_id, target_id, edge_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [edge.id, edge.entity_id, edge.source_id, edge.target_id, edge.edge_type, edge.created_at],
    );

    if (result.changes > 0) return;

    const existing = await executor.getFirstAsync<{
      entity_id: string;
      source_id: string;
      target_id: string;
      edge_type: string;
    }>(
      `SELECT entity_id, source_id, target_id, edge_type FROM ${this.prefix}edges WHERE id = ?`,
      [edge.id],
    );

    if (!existing) return;

    if (
      String(existing.entity_id) !== edge.entity_id ||
      String(existing.source_id) !== edge.source_id ||
      String(existing.target_id) !== edge.target_id ||
      String(existing.edge_type) !== edge.edge_type
    ) {
      throw new Error(
        `Edge id collision: ${JSON.stringify(edge.id)} already exists with a different (entity_id, source_id, target_id, edge_type) tuple`,
      );
    }
  }

  async getByEntityId(entityId: string, tx?: SQLiteAdapter): Promise<WikiEdge[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}edges WHERE entity_id = ? ORDER BY created_at ASC`,
      [entityId],
    );
    return rows.map(mapRowToEdge);
  }

  /** Hard delete — edges have no soft-delete concept, only presence/absence. `tx` is REQUIRED. */
  async bulkDeleteByEntityId(entityId: string, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(`DELETE FROM ${this.prefix}edges WHERE entity_id = ?`, [entityId]);
  }

  /**
   * Multi-hop traversal from `sourceId` via SQLite `WITH RECURSIVE`. All filtering,
   * dead-ending, cycle-guarding, capping, and ordering happens in this one query.
   * The anchor is validated (exists, right entity, not soft-deleted) but never gated
   * by confidence/source_type — only nodes discovered beyond it are.
   */
  async getNeighborhood(
    entityId: string,
    sourceId: string,
    opts: NeighborhoodQueryOptions,
    tx?: SQLiteAdapter,
  ): Promise<{ nodeIds: string[]; edges: WikiEdge[] }> {
    const executor = this.getExecutor(tx);

    if (opts.edgeTypes && opts.edgeTypes.length === 0) {
      const anchor = await executor.getFirstAsync<{ id: string }>(
        `SELECT id FROM ${this.prefix}entries WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`,
        [sourceId, entityId],
      );
      return { nodeIds: anchor ? [anchor.id] : [], edges: [] };
    }

    const edgeTypesClause = opts.edgeTypes
      ? `e.edge_type IN (${opts.edgeTypes.map(() => '?').join(',')})`
      : '1=1';
    const excludeSourceTypesPlaceholders = opts.excludeSourceTypes.map(() => '?').join(',');
    const minConfidenceRank = CONFIDENCE_RANK[opts.minConfidence];

    const sql = `
      WITH RECURSIVE walk(node_id, depth, visited) AS (
        SELECT id, 0, ',' || id || ','
        FROM ${this.prefix}entries
        WHERE id = ? AND entity_id = ? AND deleted_at IS NULL

        UNION

        SELECT
          CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END,
          w.depth + 1,
          w.visited || (CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END) || ','
        FROM walk w
        JOIN ${this.prefix}edges e
          ON e.entity_id = ?
          AND (
            (? != 'inbound'  AND e.source_id = w.node_id) OR
            (? != 'outbound' AND e.target_id = w.node_id)
          )
          AND (${edgeTypesClause})
        JOIN ${this.prefix}entries n
          ON n.id = (CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END)
          AND n.entity_id = ?
          AND n.deleted_at IS NULL
          AND (
            CASE n.confidence
              WHEN 'tentative' THEN 0
              WHEN 'inferred' THEN 1
              WHEN 'certain' THEN 2
              ELSE -1
            END
          ) >= ?
          AND n.source_type NOT IN (${excludeSourceTypesPlaceholders})
        WHERE w.depth < ?
          AND instr(w.visited, ',' || (CASE WHEN e.source_id = w.node_id THEN e.target_id ELSE e.source_id END) || ',') = 0
      )
      SELECT node_id, MIN(depth) AS depth
      FROM walk
      GROUP BY node_id
      ORDER BY depth ASC, (SELECT updated_at FROM ${this.prefix}entries WHERE id = node_id) DESC
      LIMIT ?
    `;

    const params: unknown[] = [
      sourceId, entityId,
      entityId,
      opts.direction, opts.direction,
      ...(opts.edgeTypes ?? []),
      entityId,
      minConfidenceRank,
      ...opts.excludeSourceTypes,
      opts.maxDepth,
      opts.maxNodes,
    ];

    const rows = await executor.getAllAsync<{ node_id: string; depth: number }>(sql, params);
    const nodeIds = rows.map((r) => r.node_id);
    if (nodeIds.length === 0) return { nodeIds: [], edges: [] };

    const idPlaceholders = nodeIds.map(() => '?').join(',');
    const edgeRows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}edges WHERE entity_id = ? AND source_id IN (${idPlaceholders}) AND target_id IN (${idPlaceholders})`,
      [entityId, ...nodeIds, ...nodeIds],
    );

    return { nodeIds, edges: edgeRows.map(mapRowToEdge) };
  }
}

function mapRowToEdge(row: any): WikiEdge {
  return {
    id: String(row.id),
    entity_id: String(row.entity_id),
    source_id: String(row.source_id),
    target_id: String(row.target_id),
    edge_type: String(row.edge_type),
    created_at: Number(row.created_at),
  };
}
