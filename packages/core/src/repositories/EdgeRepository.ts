import { BaseRepository } from './BaseRepository';
import type { WikiEdge, SQLiteAdapter } from '../types';

export class EdgeRepository extends BaseRepository {
  /** Insert an edge, silently skipping if (source_id, target_id, edge_type) already exists. */
  async addIgnoreDuplicate(edge: WikiEdge, tx?: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}edges (id, entity_id, source_id, target_id, edge_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, target_id, edge_type) DO NOTHING`,
      [edge.id, edge.entity_id, edge.source_id, edge.target_id, edge.edge_type, edge.created_at],
    );
  }

  async getByEntityId(entityId: string, tx?: SQLiteAdapter): Promise<WikiEdge[]> {
    const executor = this.getExecutor(tx);
    return executor.getAllAsync<WikiEdge>(
      `SELECT * FROM ${this.prefix}edges WHERE entity_id = ? ORDER BY created_at ASC`,
      [entityId],
    );
  }

  /** Hard delete — edges have no soft-delete concept, only presence/absence. `tx` is REQUIRED. */
  async bulkDeleteByEntityId(entityId: string, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(`DELETE FROM ${this.prefix}edges WHERE entity_id = ?`, [entityId]);
  }
}
