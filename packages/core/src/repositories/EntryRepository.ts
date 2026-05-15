import type { SQLiteAdapter, WikiFact } from '../types';
import { BaseRepository } from './BaseRepository';
import { OutboxRepository } from './OutboxRepository';

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
    deleted_at: row.deleted_at != null ? Number(row.deleted_at) : null,
    access_count: Number(row.access_count ?? 0),
  };
}

export class EntryRepository extends BaseRepository {
  private chunkSize = 500;

  constructor(db: SQLiteAdapter, prefix: string, private outbox: OutboxRepository) {
    super(db, prefix);
  }

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
   * `tx` is REQUIRED to ensure atomic outbox staging.
   */
  async upsert(fact: WikiFact, tx: SQLiteAdapter): Promise<{ changes: number; lastInsertRowId: number }> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const tagsJson = JSON.stringify(fact.tags);
    const embeddingBlob = fact.embedding_blob instanceof Uint8Array
      ? fact.embedding_blob
      : (fact.embedding_blob && typeof fact.embedding_blob === 'object' && 'type' in fact.embedding_blob)
        ? new Uint8Array((fact.embedding_blob as any).data)
        : (fact.embedding_blob && typeof fact.embedding_blob === 'object')
          ? (() => {
              const obj = fact.embedding_blob as Record<string, number>;
              const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
              const arr = new Uint8Array(keys.length);
              for (let i = 0; i < keys.length; i++) arr[i] = obj[String(keys[i])];
              return arr;
            })()
          : undefined;

    // Determine if this is an INSERT or UPDATE for the outbox
    const existing = await executor.getFirstAsync<{ id: string }>(
      `SELECT id FROM ${this.prefix}entries WHERE id = ?`,
      [fact.id],
    );
    const operation = fact.deleted_at ? 'DELETE' : (existing ? 'UPDATE' : 'INSERT');

    const result = await executor.runAsync(
      `INSERT INTO ${this.prefix}entries (
        id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count,
        deleted_at, embedding_blob, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        deleted_at = excluded.deleted_at,
        embedding_blob = CASE WHEN excluded.embedding_blob IS NULL THEN embedding_blob ELSE excluded.embedding_blob END,
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
        fact.deleted_at ?? null,
        embeddingBlob ?? null,
        null,
      ],
    );

    await this.outbox.push({
      entityId: fact.entity_id,
      tableName: 'entries',
      recordId: fact.id,
      operation,
      payload: fact,
    }, tx);

    return result;
  }

  /**
   * Soft-delete a single entry by ID scoped to entityId. Sets deleted_at + updated_at.
   * `tx` is REQUIRED to ensure atomic outbox staging.
   */
  async softDelete(entryId: string, entityId: string, tx: SQLiteAdapter): Promise<{ changes: number }> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const result = await executor.runAsync(
      `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`,
      [now, now, entryId, entityId],
    );

    await this.outbox.push({
      entityId,
      tableName: 'entries',
      recordId: entryId,
      operation: 'DELETE',
      payload: { id: entryId, entity_id: entityId, deleted_at: now },
    }, tx);

    return result;
  }

  /**
   * Soft-delete entries by source_ref and/or source_hash within a transaction.
   * Stages a DELETE outbox entry for each row in the same transaction.
   * `tx` is REQUIRED.
   * Returns the number of rows deleted.
   */
  async softDeleteBySource(
    entityId: string,
    tx: SQLiteAdapter,
    sourceRef?: string | null,
    sourceHash?: string | null,
  ): Promise<number> {
    const executor = this.getExecutor(tx);
    const now = Date.now();

    let q = `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL`;
    const args: any[] = [now, now, entityId];
    if (sourceRef) {
      q += ` AND source_ref = ?`;
      args.push(sourceRef);
    }
    if (sourceHash) {
      q += ` AND source_hash = ?`;
      args.push(sourceHash);
    }

    // Get affected IDs before updating, for outbox staging
    const idsToDelete = await executor.getAllAsync<{ id: string }>(
      q.replace('UPDATE', 'SELECT id FROM').replace(/SET.*WHERE/, 'WHERE'),
      args,
    );

    const result = await executor.runAsync(q, args);

    for (const row of idsToDelete) {
      await this.outbox.push({
        entityId,
        tableName: 'entries',
        recordId: row.id,
        operation: 'DELETE',
        payload: { id: row.id, entity_id: entityId, deleted_at: now },
      }, tx);
    }

    return result.changes;
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

  /**
   * Fetch all non-deleted entries for an entity, ordered by updated_at DESC.
   * Used by _getFullBundle().
   */
  async findAllByEntityId(entityId: string, tx?: SQLiteAdapter): Promise<WikiFact[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [entityId],
    );
    return rows.map(mapRowToFact);
  }

  /**
   * Fetch recent non-deleted entries for an entity (limited), ordered by updated_at DESC.
   * Used by _doRunLibrarian().
   */
  async findRecentByEntityId(entityId: string, limit: number, tx?: SQLiteAdapter): Promise<WikiFact[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
      [entityId, limit],
    );
    return rows.map(mapRowToFact);
  }

  /**
   * Bulk delete pruned entries (already soft-deleted) by IDs.
   * Used by runPrune(). Returns total number of deleted rows.
   */
  async bulkDeletePruned(
    entityId: string,
    cutoff: number,
    ids: string[],
    tx?: SQLiteAdapter,
  ): Promise<number> {
    const executor = this.getExecutor(tx);
    let totalChanges = 0;
    const chunkSize = 500;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const result = await executor.runAsync(
        `DELETE FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ? AND id IN (${placeholders})`,
        [entityId, cutoff, ...chunk],
      );
      totalChanges += result.changes;
      // Stage outbox entries for permanently deleted records
      if (result.changes > 0 && tx) {
        for (const id of chunk) {
          await this.outbox.push({
            entityId,
            tableName: 'entries',
            recordId: id,
            operation: 'DELETE',
            payload: { id, entity_id: entityId, deleted_at: cutoff },
          }, tx);
        }
      }
    }
    return totalChanges;
  }

  /**
   * Mark orphaned entries (never accessed, old) as deleted.
   * Used by _doRunHeal().
   */
  async markOrphaned(
    entityId: string,
    orphanThreshold: number,
    tx?: SQLiteAdapter,
  ): Promise<number> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const result = await executor.runAsync(
      `UPDATE ${this.prefix}entries
       SET deleted_at = ?, updated_at = ?
       WHERE entity_id = ? AND access_count = 0 AND created_at <= ? AND source_type != 'immutable_document' AND deleted_at IS NULL`,
      [now, now, entityId, orphanThreshold],
    );
    // Stage outbox entries for orphaned records
    if (result.changes > 0 && tx) {
      const orphanedRows = await executor.getAllAsync<any>(
        `SELECT id FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at = ? AND access_count = 0 AND created_at <= ? AND source_type != 'immutable_document'`,
        [entityId, now, orphanThreshold],
      );
      for (const row of orphanedRows) {
        await this.outbox.push({
          entityId,
          tableName: 'entries',
          recordId: row.id,
          operation: 'DELETE',
          payload: { id: row.id, entity_id: entityId, deleted_at: now },
        }, tx);
      }
    }
    return result.changes;
  }

  /**
   * Downgrade stale inferred entries to 'tentative'.
   * Used by _doRunHeal().
   */
  async downgradeStaleInferred(
    entityId: string,
    staleThreshold: number,
    tx?: SQLiteAdapter,
  ): Promise<number> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const result = await executor.runAsync(
      `UPDATE ${this.prefix}entries
       SET confidence = 'tentative', updated_at = ?
       WHERE entity_id = ? AND confidence = 'inferred' AND (last_accessed_at <= ? OR (last_accessed_at IS NULL AND created_at <= ?)) AND source_type != 'immutable_document' AND deleted_at IS NULL`,
      [now, entityId, staleThreshold, staleThreshold],
    );
    // Stage outbox entries for downgraded records
    if (result.changes > 0 && tx) {
      const downgradedRows = await executor.getAllAsync<any>(
        `SELECT id FROM ${this.prefix}entries WHERE entity_id = ? AND confidence = 'tentative' AND updated_at = ? AND source_type != 'immutable_document' AND deleted_at IS NULL`,
        [entityId, now],
      );
      for (const row of downgradedRows) {
        await this.outbox.push({
          entityId,
          tableName: 'entries',
          recordId: row.id,
          operation: 'UPDATE',
          payload: { id: row.id, entity_id: entityId, confidence: 'tentative', updated_at: now },
        }, tx);
      }
    }
    return result.changes;
  }

  /**
   * Downgrade specific entries to 'tentative' by IDs.
   * Used by _doRunHeal().
   */
  async downgradeByIds(
    ids: string[],
    entityId: string,
    tx?: SQLiteAdapter,
  ): Promise<void> {
    if (ids.length === 0) return;
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    await executor.runAsync(
      `UPDATE ${this.prefix}entries SET confidence = 'tentative', updated_at = ? WHERE id IN (${placeholders}) AND entity_id = ?`,
      [now, ...ids, entityId],
    );
    // Stage outbox entries for downgraded records
    if (tx) {
      for (const id of ids) {
        await this.outbox.push({
          entityId,
          tableName: 'entries',
          recordId: id,
          operation: 'UPDATE',
          payload: { id, entity_id: entityId, confidence: 'tentative', updated_at: now },
        }, tx);
      }
    }
  }

  /**
   * Soft-delete specific entries by IDs.
   * Used by _doRunHeal().
   */
  async softDeleteByIds(
    ids: string[],
    entityId: string,
    tx?: SQLiteAdapter,
  ): Promise<void> {
    if (ids.length === 0) return;
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    await executor.runAsync(
      `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id IN (${placeholders}) AND entity_id = ?`,
      [now, now, ...ids, entityId],
    );
    // Stage outbox entries for soft-deleted records
    if (tx) {
      for (const id of ids) {
        await this.outbox.push({
          entityId,
          tableName: 'entries',
          recordId: id,
          operation: 'DELETE',
          payload: { id, entity_id: entityId, deleted_at: now },
        }, tx);
      }
    }
  }
}
