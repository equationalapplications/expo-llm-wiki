import { BaseRepository } from './BaseRepository';
import type { WikiEdge, SQLiteAdapter } from '../types';

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
    return rows.map((row) => ({
      id: String(row.id),
      entity_id: String(row.entity_id),
      source_id: String(row.source_id),
      target_id: String(row.target_id),
      edge_type: String(row.edge_type),
      created_at: Number(row.created_at),
    }));
  }

  /** Hard delete — edges have no soft-delete concept, only presence/absence. `tx` is REQUIRED. */
  async bulkDeleteByEntityId(entityId: string, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(`DELETE FROM ${this.prefix}edges WHERE entity_id = ?`, [entityId]);
  }
}
