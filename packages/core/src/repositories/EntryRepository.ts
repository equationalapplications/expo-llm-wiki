import type { SQLiteAdapter, WikiFact } from '../types';
import { parseEmbedding } from '../utils/embedding';

function mapRowToFact(row: any): WikiFact {
  const tags: string[] = (() => {
    if (Array.isArray(row.tags)) return row.tags;
    try { const p = JSON.parse(row.tags as string); if (Array.isArray(p)) return p; } catch {}
    return [];
  })();

  return {
    id: row.id,
    entity_id: row.entity_id,
    title: row.title,
    body: row.body,
    tags,
    confidence: row.confidence,
    source_type: row.source_type,
    source_hash: row.source_hash ?? null,
    source_ref: row.source_ref ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_accessed_at: (row.last_accessed_at === null || row.last_accessed_at === undefined)
      ? null
      : Number(row.last_accessed_at),
    access_count: Number(row.access_count ?? 0),
  } as WikiFact;
}

export class EntryRepository extends (await import('./BaseRepository')).BaseRepository {
  private chunkSize = 500;

  /**
   * Fetch facts by IDs, optionally scoped to entity IDs.
   * Returns facts in the order of the input IDs (first match wins).
   */
  async findByIds(
    ids: readonly string[],
    scopedEntityIds?: readonly string[],
    tx?: SQLiteAdapter,
  ): Promise<WikiFact[]> {
    const executor = this.getExecutor(tx);
    const rows: any[] = [];
    const entityClause = scopedEntityIds && scopedEntityIds.length > 0
      ? ` AND entity_id IN (${scopedEntityIds.map(() => '?').join(',')})`
      : '';
    const entityParams = scopedEntityIds ?? [];

    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = await executor.getAllAsync<any>(
        `SELECT * FROM ${this.prefix}entries WHERE id IN (${placeholders})${entityClause} AND deleted_at IS NULL`,
        [...chunk, ...entityParams],
      );
      rows.push(...chunkRows);
    }

    const byId = new Map(rows.map(r => [r.id, r]));
    return ids
      .map(id => byId.get(id))
      .filter((r): r is any => r !== undefined)
      .map(mapRowToFact);
  }

  /**
   * Upsert a WikiFact. Nullable fields set to null when fact value is null.
   * Returns { changes, lastInsertRowId }.
   */
  async upsert(fact: WikiFact, tx?: SQLiteAdapter): Promise<{ changes: number; lastInsertRowId: number }> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const tagsJson = JSON.stringify(fact.tags);
    const embeddingBlob = fact.embedding_blob instanceof Uint8Array
      ? fact.embedding_blob
      : (fact.embedding_blob && typeof fact.embedding_blob === 'object' && 'type' in fact.embedding_blob)
        ? new Uint8Array((fact.embedding_blob as any).data)
        : undefined;

    return executor.runAsync(
      `INSERT INTO ${this.prefix}entries (
        id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count,
        embedding_blob, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity_id = excluded.entity_id,
        title = excluded.title,
        body = excluded.body,
        tags = excluded.tags,
        confidence = excluded.confidence,
        source_type = excluded.source_type,
        source_hash = excluded.source_hash,
        source_ref = excluded.source_ref,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at,
        access_count = excluded.access_count,
        embedding_blob = excluded.embedding_blob,
        embedding = NULL`,
      [
        fact.id,
        fact.entity_id,
        fact.title,
        fact.body,
        tagsJson,
        fact.confidence,
        fact.source_type,
        fact.source_hash,
        fact.source_ref,
        fact.created_at,
        now, // updated_at set by repo
        fact.last_accessed_at === null ? null : fact.last_accessed_at,
        fact.access_count,
        embeddingBlob ?? null,
        null,
      ],
    );
  }

  /**
   * Soft-delete a single entry by ID. Sets deleted_at + updated_at.
   */
  async softDelete(entryId: string, tx?: SQLiteAdapter): Promise<{ changes: number }> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    return executor.runAsync(
      `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      [now, now, entryId],
    );
  }

  /**
   * Fetch IDs + entity_ids of soft-deleted rows older than cutoff for a given entity.
   * Used by runPrune().
   */
  async getPrunableMetadata(
    entityId: string,
    cutoff: number,
    tx?: SQLiteAdapter,
  ): Promise<Array<{ id: string; entity_id: string }>> {
    const executor = this.getExecutor(tx);
    return executor.getAllAsync<{ id: string; entity_id: string }>(
      `SELECT id, entity_id FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
      [entityId, cutoff],
    );
  }
}
