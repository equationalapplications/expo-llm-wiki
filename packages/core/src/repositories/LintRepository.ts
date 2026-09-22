import { BaseRepository } from './BaseRepository';

/** Read-only queries for `lint` (spec §8.1). Every statement is entity-scoped. */
export class LintRepository extends BaseRepository {
  async countFactHealth(entityId: string): Promise<{ untypedFacts: number; drafts: number; unverifiedInferred: number }> {
    const row = await this.db.getFirstAsync<{ untyped: number | null; drafts: number | null; unverified: number | null }>(
      `SELECT
         SUM(CASE WHEN okf_type IS NULL THEN 1 ELSE 0 END) AS untyped,
         SUM(CASE WHEN lifecycle_status = 'draft' THEN 1 ELSE 0 END) AS drafts,
         SUM(CASE WHEN source_type = 'librarian_inferred'
                   AND COALESCE(json_array_length(CASE WHEN json_valid(okf_verified) THEN okf_verified END), 0) = 0
                  THEN 1 ELSE 0 END) AS unverified
       FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL`,
      [entityId],
    );
    return {
      untypedFacts: Number(row?.untyped ?? 0),
      drafts: Number(row?.drafts ?? 0),
      unverifiedInferred: Number(row?.unverified ?? 0),
    };
  }

  private danglingWhere(): string {
    const live = (col: string) =>
      `EXISTS (SELECT 1 FROM ${this.prefix}entries n WHERE n.id = e.${col} AND n.entity_id = e.entity_id AND n.deleted_at IS NULL)`;
    return `e.entity_id = ? AND (NOT ${live('source_id')} OR NOT ${live('target_id')})`;
  }

  async countDanglingEdges(entityId: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${this.prefix}edges e WHERE ${this.danglingWhere()}`,
      [entityId],
    );
    return Number(row?.n ?? 0);
  }

  async sampleDanglingEdgeIds(entityId: string, limit: number): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ id: string }>(
      `SELECT e.id FROM ${this.prefix}edges e WHERE ${this.danglingWhere()} ORDER BY e.id ASC LIMIT ?`,
      [entityId, limit],
    );
    return rows.map((r) => r.id);
  }

  /** Keyset page of edges whose endpoints are both live in this entity, with endpoint types. */
  async pageLiveEdges(
    entityId: string,
    afterId: string,
    limit: number,
  ): Promise<Array<{ id: string; edge_type: string; source_type: string | null; target_type: string | null }>> {
    return this.db.getAllAsync(
      `SELECT e.id, e.edge_type, s.okf_type AS source_type, t.okf_type AS target_type
         FROM ${this.prefix}edges e
         JOIN ${this.prefix}entries s ON s.id = e.source_id AND s.entity_id = e.entity_id AND s.deleted_at IS NULL
         JOIN ${this.prefix}entries t ON t.id = e.target_id AND t.entity_id = e.entity_id AND t.deleted_at IS NULL
        WHERE e.entity_id = ? AND e.id > ?
        ORDER BY e.id ASC
        LIMIT ?`,
      [entityId, afterId, limit],
    );
  }
}
