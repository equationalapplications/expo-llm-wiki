import type { SQLiteAdapter, WikiFact } from '../types';
import { BaseRepository } from './BaseRepository';
import { OutboxRepository } from './OutboxRepository';

export type EntryRowMetadata = {
  id: string;
  entity_id: string;
  updated_at: number | null;
  access_count: number | null;
};

export type EntryRowWithEmbeddings = EntryRowMetadata & {
  embedding_blob: Uint8Array | null;
  embedding: string | null;
};

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
    okf_type: row.okf_type ?? null,
  };
}

function normalizeEmbeddingBlobValue(blob: unknown): Uint8Array | null {
  if (blob instanceof Uint8Array) return blob;
  if (blob !== null && blob !== undefined && typeof blob === 'object') {
    const obj = blob as Record<string, unknown>;
    if (obj['type'] === 'Buffer' && Array.isArray(obj['data'])) {
      return new Uint8Array(obj['data'] as number[]);
    }
    const entries = Object.keys(obj);
    if (entries.length > 0 && entries.every((k) => /^\d+$/.test(k))) {
      const len = entries.length;
      const arr = new Uint8Array(len);
      for (let i = 0; i < len; i++) arr[i] = (obj[String(i)] as number) ?? 0;
      return arr;
    }
  }
  return null;
}

/** Mapper that preserves embedding_blob for export/import round-tripping. */
function mapRowToFactWithBlobs(row: any): WikiFact {
  const base = mapRowToFact(row);
  const embeddingBlob = normalizeEmbeddingBlobValue(row.embedding_blob);
  return embeddingBlob ? { ...base, embedding_blob: embeddingBlob } : base;
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
    const embeddingBlob = this.normalizeEmbeddingBlob(fact.embedding_blob);

    const existingRow = await executor.getFirstAsync<{ id: string }>(
      `SELECT id FROM ${this.prefix}entries WHERE id = ?`,
      [fact.id],
    );
    const operation = fact.deleted_at ? 'DELETE' : (existingRow ? 'UPDATE' : 'INSERT');

    const result = await executor.runAsync(
      `INSERT INTO ${this.prefix}entries (
        id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count,
        deleted_at, embedding_blob, embedding, okf_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        embedding = NULL,
        okf_type = excluded.okf_type`,
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
        now,
        fact.last_accessed_at === null ? null : fact.last_accessed_at,
        fact.access_count,
        fact.deleted_at ?? null,
        embeddingBlob ?? null,
        null,
        fact.okf_type ?? null,
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
   * Normalize an embedding blob value to Uint8Array or null.
   */
  private normalizeEmbeddingBlob(blob: unknown): Uint8Array | null {
    return normalizeEmbeddingBlobValue(blob);
  }

  /**
   * Fetch existing rows by IDs and return id/entity_id/updated_at for import collision resolution.
   */
  async findExistingMetadataByIds(
    ids: readonly string[],
    tx?: SQLiteAdapter,
  ): Promise<Array<{ id: string; entity_id: string; updated_at: number }>> {
    const executor = this.getExecutor(tx);
    const rows: Array<{ id: string; entity_id: string; updated_at: number }> = [];
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = await executor.getAllAsync<any>(
        `SELECT id, entity_id, updated_at FROM ${this.prefix}entries WHERE id IN (${placeholders})`,
        chunk,
      );
      rows.push(...chunkRows.map((row) => ({ id: row.id, entity_id: row.entity_id, updated_at: Number(row.updated_at) })));
    }
    return rows;
  }

  async findIdById(id: string, entityId: string, tx?: SQLiteAdapter): Promise<string | null> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ id: string }>(
      `SELECT id FROM ${this.prefix}entries WHERE id = ? AND entity_id = ?`,
      [id, entityId],
    );
    return row?.id ?? null;
  }

  async findIdsBySource(
    entityId: string,
    sourceRef: string | null,
    sourceHash: string | null,
    tx?: SQLiteAdapter,
    includeDeleted = false,
  ): Promise<string[]> {
    const executor = this.getExecutor(tx);
    let sql = `SELECT id FROM ${this.prefix}entries WHERE entity_id = ?`;
    const args: unknown[] = [entityId];
    if (sourceRef !== null) {
      sql += ` AND source_ref = ?`;
      args.push(sourceRef);
    }
    if (sourceHash !== null) {
      sql += ` AND source_hash = ?`;
      args.push(sourceHash);
    }
    if (!includeDeleted) {
      sql += ` AND deleted_at IS NULL`;
    }
    const rows = await executor.getAllAsync<{ id: string }>(sql, args);
    return rows.map((row) => row.id);
  }

  async upsertForImport(fact: WikiFact, tx: SQLiteAdapter): Promise<{ changes: number; lastInsertRowId: number }> {
    const executor = this.getExecutor(tx);
    const tagsJson = JSON.stringify(fact.tags);
    const embeddingBlob = this.normalizeEmbeddingBlob(fact.embedding_blob);

    const result = await executor.runAsync(
      `INSERT INTO ${this.prefix}entries (
        id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count,
        deleted_at, embedding_blob, embedding, okf_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity_id = excluded.entity_id,
        title = excluded.title,
        body = excluded.body,
        tags = excluded.tags,
        confidence = excluded.confidence,
        source_type = excluded.source_type,
        source_hash = excluded.source_hash,
        source_ref = excluded.source_ref,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at,
        access_count = excluded.access_count,
        deleted_at = excluded.deleted_at,
        embedding_blob = excluded.embedding_blob,
        embedding = NULL,
        okf_type = excluded.okf_type`,
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
        fact.updated_at,
        fact.last_accessed_at === null ? null : fact.last_accessed_at,
        fact.access_count,
        fact.deleted_at ?? null,
        embeddingBlob ?? null,
        null,
        fact.okf_type ?? null,
      ],
    );

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

    // Build a separate SELECT query to get affected IDs before updating
    let selectQ = `SELECT id FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`;
    const selectArgs: any[] = [entityId];
    if (sourceRef) {
      selectQ += ` AND source_ref = ?`;
      selectArgs.push(sourceRef);
    }
    if (sourceHash) {
      selectQ += ` AND source_hash = ?`;
      selectArgs.push(sourceHash);
    }

    const idsToDelete = await executor.getAllAsync<{ id: string }>(selectQ, selectArgs);

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
   * Fetch live, mutable entries for an entity — everything heal is allowed to
   * downgrade or delete — oldest first, capped at `limit`, skipping anything
   * stamped inside the recheck cooldown (heal_checked_at > recheckCutoff).
   *
   * Oldest-first rather than newest-first: with a cooldown in place, newest-first
   * would keep re-selecting recently-touched facts every pass while older ones
   * wait indefinitely to even enter a batch.
   */
  async findHealCandidatesByEntityId(
    entityId: string,
    limit: number,
    recheckCutoff: number,
    tx?: SQLiteAdapter,
  ): Promise<WikiFact[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL AND source_type != 'immutable_document'
         AND (heal_checked_at IS NULL OR heal_checked_at <= ?)
       ORDER BY updated_at ASC LIMIT ?`,
      [entityId, recheckCutoff, limit],
    );
    return rows.map(mapRowToFact);
  }

  /**
   * Resolve search hits to document anchors. The MiniSearch index holds every
   * fact, not only immutable_document rows, so the source-type restriction has
   * to be applied here, after retrieval.
   */
  async findAnchorRowsByIds(
    entityId: string,
    ids: readonly string[],
    tx?: SQLiteAdapter,
  ): Promise<Array<{ id: string; title: string; source_ref: string | null }>> {
    if (ids.length === 0) return [];
    const executor = this.getExecutor(tx);
    const rows: Array<{ id: string; title: string; source_ref: string | null }> = [];
    // Chunked like every other multi-id read here. The current caller stays well
    // under SQLITE_MAX_VARIABLE_NUMBER, but that is a property of the caller,
    // not of this method.
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const chunkRows = await executor.getAllAsync<{ id: string; title: string; source_ref: string | null }>(
        `SELECT id, title, source_ref FROM ${this.prefix}entries
         WHERE entity_id = ? AND deleted_at IS NULL
           AND source_type = 'immutable_document'
           AND id IN (${placeholders})`,
        [entityId, ...chunk],
      );
      rows.push(...chunkRows);
    }
    return rows;
  }

  /**
   * Fetch recent non-deleted entries for an entity (limited), ordered by updated_at DESC.
   * Used by MaintenanceService.doRunLibrarian().
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
   * Fetch all non-deleted entries for an entity with embedding blobs preserved.
   * Used by ImportExportService for export/import round-tripping.
   */
  async findAllByEntityIdWithBlobs(entityId: string, tx?: SQLiteAdapter): Promise<WikiFact[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [entityId],
    );
    return rows.map(mapRowToFactWithBlobs);
  }

  /**
   * Count non-deleted entries for the given entities whose embedding_blob dimension
   * doesn't match queryVecLength. Used by read() to detect model-switch mismatches.
   */
  async countDimensionMismatched(
    entityIds: readonly string[],
    queryVecLength: number,
    tx?: SQLiteAdapter,
  ): Promise<number> {
    if (entityIds.length === 0) return 0;
    const executor = this.getExecutor(tx);
    const placeholders = entityIds.map(() => '?').join(',');
    const row = await executor.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM ${this.prefix}entries
       WHERE entity_id IN (${placeholders}) AND deleted_at IS NULL
         AND embedding_blob IS NOT NULL
         AND (CAST(length(embedding_blob) AS INTEGER) % 4 = 0)
         AND (CAST(length(embedding_blob) AS INTEGER) / 4) != ?`,
      [...entityIds, queryVecLength],
    );
    return row?.cnt ?? 0;
  }

  /**
   * Count non-deleted entries for entityId that are stale relative to targetDim
   * (either no blob or wrong dimension). Used by runReembed() per-entity skip logic.
   */
  async countStaleForEntity(entityId: string, targetDim: number, tx?: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL
         AND (
           embedding_blob IS NULL
           OR (CAST(length(embedding_blob) AS INTEGER) / 4) != ?
         )`,
      [entityId, targetDim],
    );
    return row?.cnt ?? 0;
  }

  /**
   * Count non-deleted entries with stale or unconverted embeddings relative to `dim`.
   * Used by _reconcileEmbeddingDimension() to decide when to promote the pending
   * embedding_dimension value.
   */
  async countStaleEmbeddings(dim: number, tx?: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM ${this.prefix}entries
       WHERE deleted_at IS NULL
         AND (
           (embedding_blob IS NOT NULL AND (CAST(length(embedding_blob) AS INTEGER) / 4) != ?)
           OR (embedding_blob IS NULL AND embedding IS NOT NULL)
         )`,
      [dim],
    );
    return row?.cnt ?? 0;
  }

  /**
   * Bulk delete pruned entries (already soft-deleted) by IDs.
   * Used by runPrune(). Returns total number of deleted rows.
   * `tx` is REQUIRED so outbox deletion events are staged atomically.
   */
  async bulkDeletePruned(
    entityId: string,
    cutoff: number,
    ids: string[],
    tx: SQLiteAdapter,
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
      if (result.changes > 0) {
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
   * Used by MaintenanceService.doRunHeal().
   */
  async markOrphaned(
    entityId: string,
    orphanThreshold: number,
    tx: SQLiteAdapter,
  ): Promise<string[]> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const updatedRows = await executor.getAllAsync<{ id: string }>(
      `UPDATE ${this.prefix}entries
       SET deleted_at = ?, updated_at = ?
       WHERE entity_id = ? AND access_count = 0 AND created_at <= ? AND source_type != 'immutable_document' AND deleted_at IS NULL
       RETURNING id`,
      [now, now, entityId, orphanThreshold],
    );
    for (const row of updatedRows) {
      await this.outbox.push({
        entityId,
        tableName: 'entries',
        recordId: row.id,
        operation: 'DELETE',
        payload: { id: row.id, entity_id: entityId, deleted_at: now },
      }, tx);
    }
    return updatedRows.map(r => r.id);
  }

  /**
   * Downgrade stale inferred entries to 'tentative'.
   * Used by MaintenanceService.doRunHeal().
   *
   * Returns the ids it downgraded so the caller can fold them into
   * {@link HealResult.downgraded} without double-counting a fact the model also
   * downgraded in the same pass.
   */
  async downgradeStaleInferred(
    entityId: string,
    staleThreshold: number,
    tx: SQLiteAdapter,
  ): Promise<string[]> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const eligibleRows = await executor.getAllAsync<{ id: string }>(
      `SELECT id FROM ${this.prefix}entries
       WHERE entity_id = ? AND confidence = 'inferred'
         AND (last_accessed_at <= ? OR (last_accessed_at IS NULL AND created_at <= ?))
         AND source_type != 'immutable_document' AND deleted_at IS NULL`,
      [entityId, staleThreshold, staleThreshold],
    );
    if (eligibleRows.length === 0) return [];
    await executor.runAsync(
      `UPDATE ${this.prefix}entries
       SET confidence = 'tentative', updated_at = ?
       WHERE entity_id = ? AND confidence = 'inferred' AND (last_accessed_at <= ? OR (last_accessed_at IS NULL AND created_at <= ?)) AND source_type != 'immutable_document' AND deleted_at IS NULL`,
      [now, entityId, staleThreshold, staleThreshold],
    );
    for (const row of eligibleRows) {
      await this.outbox.push({
        entityId,
        tableName: 'entries',
        recordId: row.id,
        operation: 'UPDATE',
        payload: { id: row.id, entity_id: entityId, confidence: 'tentative', updated_at: now },
      }, tx);
    }
    return eligibleRows.map(r => r.id);
  }

  /**
   * Downgrade specific entries to 'tentative' by IDs.
   * Used by MaintenanceService.doRunHeal().
   */
  async downgradeByIds(
    ids: string[],
    entityId: string,
    tx: SQLiteAdapter,
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

  /**
   * Soft-delete specific entries by IDs.
   * Used by MaintenanceService.doRunHeal().
   */
  async softDeleteByIds(
    ids: string[],
    entityId: string,
    tx: SQLiteAdapter,
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

  /**
   * Bulk soft-delete all entries for an entity.
   * Stages DELETE outbox entries for each row in the same transaction.
   * `tx` is REQUIRED.
   */
  async bulkSoftDeleteByEntityId(entityId: string, tx: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    // Get IDs before updating for outbox staging
    const idsToDelete = await executor.getAllAsync<{ id: string }>(
      `SELECT id FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
      [entityId],
    );
    const result = await executor.runAsync(
      `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL`,
      [now, now, entityId],
    );
    // Stage outbox entries for each deleted record
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

  async findMiniSearchRows(
    entityId?: string,
    tx?: SQLiteAdapter,
  ): Promise<Array<{ id: string; entity_id: string; title: string; body: string; tags: string }>> {
    const executor = this.getExecutor(tx);
    if (entityId !== undefined) {
      return executor.getAllAsync(
        `SELECT id, entity_id, title, body, tags FROM ${this.prefix}entries WHERE deleted_at IS NULL AND entity_id = ?`,
        [entityId],
      );
    }
    return executor.getAllAsync(
      `SELECT id, entity_id, title, body, tags FROM ${this.prefix}entries WHERE deleted_at IS NULL`,
    );
  }

  async updateEmbeddingBlob(id: string, blob: Uint8Array, tx?: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `UPDATE ${this.prefix}entries SET embedding_blob = ?, embedding = NULL WHERE id = ?`,
      [blob, id],
    );
  }

  async hasLegacySourceTypes(tx?: SQLiteAdapter): Promise<boolean> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM ${this.prefix}entries WHERE source_type IN ('user_document', 'agent_inferred') LIMIT 1`,
      [],
    );
    return row != null;
  }

  async countLegacySourceTypes(tx?: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.prefix}entries WHERE source_type IN ('user_document', 'agent_inferred')`,
      [],
    );
    return row?.count ?? 0;
  }

  async findAllForReembed(entityId?: string, tx?: SQLiteAdapter): Promise<Array<WikiFact & { embedding_blob?: Uint8Array | null }>> {
    const executor = this.getExecutor(tx);
    if (entityId !== undefined) {
      return executor.getAllAsync(
        `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
        [entityId],
      );
    }
    return executor.getAllAsync(
      `SELECT * FROM ${this.prefix}entries WHERE deleted_at IS NULL`,
    );
  }

  async findRowsForSourceRefMigration(tx?: SQLiteAdapter): Promise<Array<{ rowid: number; source_ref: string }>> {
    const executor = this.getExecutor(tx);
    return executor.getAllAsync(
      `SELECT rowid, source_ref FROM ${this.prefix}entries
       WHERE source_ref IS NOT NULL
         AND (
           TRIM(source_ref) != source_ref
           OR INSTR(source_ref, '/') > 0
           OR INSTR(source_ref, '\\') > 0
           OR INSTR(source_ref, CHAR(0)) > 0
           OR source_ref GLOB '*[^-A-Za-z0-9._ ]*'
         )`,
    );
  }

  async updateSourceRefByRowid(rowid: number, sourceRef: string | null, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `UPDATE ${this.prefix}entries SET source_ref = ? WHERE rowid = ?`,
      [sourceRef, rowid],
    );
  }

  async findLatestSourceHash(entityId: string, sourceRef: string, tx?: SQLiteAdapter): Promise<string | null> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ source_hash: string | null }>(
      `SELECT source_hash FROM ${this.prefix}entries
       WHERE entity_id = ? AND source_ref = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC, id ASC
       LIMIT 1`,
      [entityId, sourceRef],
    );
    return row?.source_hash ?? null;
  }

  /**
   * Batch version of {@link findLatestSourceHash}. Returns a Map covering every
   * requested ref, where the value is the source_hash from the row with the
   * most-recently-updated live fact for that ref, or null when no live row exists.
   *
   * The SQL uses ROW_NUMBER() OVER (PARTITION BY source_ref ORDER BY updated_at
   * DESC, id ASC) — NOT MAX(source_hash). Aggregation with MAX(source_hash) is
   * wrong because MAX computes independently across grouped rows; the hash must
   * come from the exact row that wins MAX(updated_at). The `id ASC` tie-break
   * keeps selection deterministic when two live rows share `updated_at`.
   *
   * Source refs are de-duplicated and processed in chunks so the per-query bind
   * parameter count stays under SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (default
   * 999, leaving one slot for `entity_id`).
   *
   * Empty input is a synchronous early return with zero SQL calls.
   */
  async findLatestSourceHashes(
    entityId: string,
    sourceRefs: readonly string[],
    tx?: SQLiteAdapter,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (sourceRefs.length === 0) return out;
    // Pre-populate with null for every requested ref so callers can distinguish
    // "no live row" (null) from "row with a null source_hash" (also null in this
    // shape, but at least the key is guaranteed present).
    const dedupedRefs = Array.from(new Set(sourceRefs));
    for (const ref of dedupedRefs) {
      out.set(ref, null);
    }
    const executor = this.getExecutor(tx);
    // 1 bind parameter for entity_id; remaining slots for source_ref placeholders.
    const chunkLimit = Math.max(1, this.chunkSize - 1);
    for (let i = 0; i < dedupedRefs.length; i += chunkLimit) {
      const chunk = dedupedRefs.slice(i, i + chunkLimit);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await executor.getAllAsync<{ source_ref: string; source_hash: string | null }>(
        `WITH ranked AS (
           SELECT source_ref, source_hash,
                  ROW_NUMBER() OVER (
                    PARTITION BY source_ref
                    ORDER BY updated_at DESC, id ASC
                  ) as rn
           FROM ${this.prefix}entries
           WHERE entity_id = ? AND source_ref IN (${placeholders}) AND deleted_at IS NULL
         )
         SELECT source_ref, source_hash
         FROM ranked
         WHERE rn = 1`,
        [entityId, ...chunk],
      );
      for (const r of rows) {
        out.set(r.source_ref, r.source_hash);
      }
    }
    return out;
  }

  /**
   * Return the live source_refs for an entity that hold the given source_hash.
   * Used by the ingestDocument duplicate-hash guard and by hosts auditing
   * duplicate-content collisions. Sorted `COLLATE BINARY` so the canonical
   * ref (the code-unit-minimum of the set) is stable across deploys.
   */
  async findSourceRefsByHash(
    entityId: string,
    sourceHash: string,
    tx?: SQLiteAdapter,
  ): Promise<string[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<{ source_ref: string }>(
      `SELECT source_ref FROM ${this.prefix}entries
       WHERE entity_id = ? AND source_hash = ? AND deleted_at IS NULL
         AND source_ref IS NOT NULL
       GROUP BY source_ref
       ORDER BY source_ref COLLATE BINARY`,
      [entityId, sourceHash],
    );
    return rows.map(r => r.source_ref);
  }

  /**
   * Per-sourceRef rollup for an entity: one row per live source_ref, with the
   * most-recently-updated live hash (NOT the lexically-max hash) and a live
   * fact count.
   *
   * The hash comes from the same row that wins ROW_NUMBER() over updated_at
   * DESC, so a ref with multiple live hashes (e.g. from import) reports the
   * latest one — matching single-doc `findLatestSourceHash` semantics.
   *
   * Sort is COLLATE BINARY: locale-dependent ordering re-mints identity on
   * every deploy, which is the bug this whole section exists to prevent.
   */
  async listSourceRefs(
    entityId: string,
    tx?: SQLiteAdapter,
  ): Promise<Array<{
    sourceRef: string;
    sourceHash: string | null;
    factCount: number;
    lastIngestedAt: number;
  }>> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<{
      source_ref: string;
      source_hash: string | null;
      fact_count: number;
      last_ingested_at: number;
    }>(
      `WITH ranked AS (
         SELECT source_ref, source_hash, updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY source_ref
                  ORDER BY updated_at DESC, id ASC
                ) AS rn,
                COUNT(*) OVER (PARTITION BY source_ref) AS fact_count
         FROM ${this.prefix}entries
         WHERE entity_id = ? AND deleted_at IS NULL AND source_ref IS NOT NULL
       )
       SELECT source_ref,
              source_hash       AS source_hash,
              fact_count        AS fact_count,
              updated_at        AS last_ingested_at
       FROM ranked
       WHERE rn = 1
       ORDER BY source_ref COLLATE BINARY`,
      [entityId],
    );
    return rows.map(r => ({
      sourceRef: r.source_ref,
      sourceHash: r.source_hash,
      factCount: Number(r.fact_count),
      lastIngestedAt: Number(r.last_ingested_at),
    }));
  }

  /**
   * Count live entries for an entity across all source_refs/source_hashes.
   * Used by forget({ dryRun, clearAll: true }).
   */
  async countLiveByEntityId(entityId: string, tx?: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM ${this.prefix}entries
     WHERE entity_id = ? AND deleted_at IS NULL`,
      [entityId],
    );
    return row?.cnt ?? 0;
  }

  /**
   * Count live entries matching a source filter (either or both may be null).
   * Used by forget({ dryRun: true }) with sourceRef/sourceHash.
   */
  async countLiveBySource(
    entityId: string,
    sourceRef: string | null,
    sourceHash: string | null,
    tx?: SQLiteAdapter,
  ): Promise<number> {
    const executor = this.getExecutor(tx);
    let q = `SELECT COUNT(*) AS cnt FROM ${this.prefix}entries
           WHERE entity_id = ? AND deleted_at IS NULL`;
    const args: unknown[] = [entityId];
    if (sourceRef !== null) { q += ` AND source_ref = ?`; args.push(sourceRef); }
    if (sourceHash !== null) { q += ` AND source_hash = ?`; args.push(sourceHash); }
    const row = await executor.getFirstAsync<{ cnt: number }>(q, args);
    return row?.cnt ?? 0;
  }

  async findMetadataByIds(ids: readonly string[], tx?: SQLiteAdapter): Promise<EntryRowMetadata[]> {
    if (ids.length === 0) return [];
    const executor = this.getExecutor(tx);
    const rows: EntryRowMetadata[] = [];
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = await executor.getAllAsync<EntryRowMetadata>(
        `SELECT id, entity_id, updated_at, access_count FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        chunk,
      );
      rows.push(...chunkRows);
    }
    return rows;
  }

  async findWithEmbeddingsByIds(ids: readonly string[], tx?: SQLiteAdapter): Promise<EntryRowWithEmbeddings[]> {
    if (ids.length === 0) return [];
    const executor = this.getExecutor(tx);
    const rows: EntryRowWithEmbeddings[] = [];
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = await executor.getAllAsync<EntryRowWithEmbeddings>(
        `SELECT id, entity_id, embedding_blob, embedding, updated_at, access_count FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        chunk,
      );
      rows.push(...chunkRows);
    }
    return rows;
  }

  async findMetadataByEntityIds(entityIds: readonly string[], tx?: SQLiteAdapter): Promise<EntryRowMetadata[]> {
    if (entityIds.length === 0) return [];
    const executor = this.getExecutor(tx);
    const placeholders = entityIds.map(() => '?').join(',');
    return executor.getAllAsync<EntryRowMetadata>(
      `SELECT id, entity_id, updated_at, access_count FROM ${this.prefix}entries WHERE entity_id IN (${placeholders}) AND deleted_at IS NULL`,
      [...entityIds],
    );
  }

  async findWithEmbeddingsByEntityIds(entityIds: readonly string[], tx?: SQLiteAdapter): Promise<EntryRowWithEmbeddings[]> {
    if (entityIds.length === 0) return [];
    const executor = this.getExecutor(tx);
    const placeholders = entityIds.map(() => '?').join(',');
    return executor.getAllAsync<EntryRowWithEmbeddings>(
      `SELECT id, entity_id, embedding_blob, embedding, updated_at, access_count FROM ${this.prefix}entries WHERE entity_id IN (${placeholders}) AND deleted_at IS NULL`,
      [...entityIds],
    );
  }

  async findEmbeddingsByIds(
    ids: readonly string[],
    tx?: SQLiteAdapter,
  ): Promise<Array<{ id: string; embedding_blob: Uint8Array | null; embedding: string | null }>> {
    if (ids.length === 0) return [];
    const executor = this.getExecutor(tx);
    const rows: Array<{ id: string; embedding_blob: Uint8Array | null; embedding: string | null }> = [];
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = await executor.getAllAsync<{ id: string; embedding_blob: Uint8Array | null; embedding: string | null }>(
        `SELECT id, embedding_blob, embedding FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        chunk,
      );
      rows.push(...chunkRows);
    }
    return rows;
  }

  async trackAccess(ids: readonly string[], now: number, tx?: SQLiteAdapter): Promise<void> {
    if (ids.length === 0) return;
    const executor = this.getExecutor(tx);
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      await executor.runAsync(
        `UPDATE ${this.prefix}entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`,
        [now, ...chunk],
      );
    }
  }

  getLegacyMigrationSQL(): string {
    return [
      `-- Migrate legacy source_type values (targets your WikiMemory prefix: ${this.prefix})`,
      `UPDATE ${this.prefix}entries SET source_type = 'immutable_document' WHERE source_type = 'user_document';`,
      `UPDATE ${this.prefix}entries SET source_type = 'librarian_inferred' WHERE source_type = 'agent_inferred';`,
    ].join('\n');
  }

  async findRecentByEntityIds(entityIds: readonly string[], limit: number, tx?: SQLiteAdapter): Promise<WikiFact[]> {
    if (entityIds.length === 0) return [];
    const executor = this.getExecutor(tx);
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries WHERE entity_id IN (${placeholders}) AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
      [...entityIds, limit],
    );
    return rows.map(mapRowToFact);
  }

  /**
   * Live untyped facts eligible for ontology backfill, oldest first.
   * Skips facts checked within the recheck cooldown (ontology_checked_at > recheckCutoff).
   */
  async findUntypedByEntityId(entityId: string, limit: number, recheckCutoff: number, tx?: SQLiteAdapter): Promise<WikiFact[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries
       WHERE entity_id = ? AND okf_type IS NULL AND deleted_at IS NULL
         AND (ontology_checked_at IS NULL OR ontology_checked_at <= ?)
       ORDER BY updated_at ASC LIMIT ?`,
      [entityId, recheckCutoff, limit],
    );
    return rows.map(mapRowToFact);
  }

  /** Counts live untyped facts: eligible (past cooldown) vs deferred (in cooldown). */
  async countUntypedByEntityId(entityId: string, recheckCutoff: number, tx?: SQLiteAdapter): Promise<{ eligible: number; deferred: number }> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ eligible: number | null; deferred: number | null }>(
      `SELECT
         SUM(CASE WHEN ontology_checked_at IS NULL OR ontology_checked_at <= ? THEN 1 ELSE 0 END) AS eligible,
         SUM(CASE WHEN ontology_checked_at IS NOT NULL AND ontology_checked_at > ? THEN 1 ELSE 0 END) AS deferred
       FROM ${this.prefix}entries
       WHERE entity_id = ? AND okf_type IS NULL AND deleted_at IS NULL`,
      [recheckCutoff, recheckCutoff, entityId],
    );
    return { eligible: Number(row?.eligible ?? 0), deferred: Number(row?.deferred ?? 0) };
  }

  /**
   * Sets okf_type only when currently NULL — additive by construction: a
   * concurrently-typed fact is never overwritten. Returns changes for the caller
   * to distinguish applied vs skipped.
   */
  async updateOkfType(id: string, entityId: string, okfType: string, tx: SQLiteAdapter): Promise<{ changes: number }> {
    const result = await tx.runAsync(
      `UPDATE ${this.prefix}entries SET okf_type = ?
       WHERE id = ? AND entity_id = ? AND okf_type IS NULL AND deleted_at IS NULL`,
      [okfType, id, entityId],
    );
    return { changes: result.changes };
  }

  /**
   * Stamps the backfill recheck cooldown. NEVER touches updated_at — import
   * merge resolution is last-write-wins on updated_at and a bump here would
   * make an unchanged local fact beat a genuinely newer remote edit.
   */
  async markOntologyChecked(ids: string[], entityId: string, now: number, tx: SQLiteAdapter): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      await tx.runAsync(
        `UPDATE ${this.prefix}entries SET ontology_checked_at = ?
         WHERE id IN (${placeholders}) AND entity_id = ? AND deleted_at IS NULL`,
        [now, ...chunk, entityId],
      );
    }
  }

  /**
   * Lightweight full-breadth title index (id, title, okf_type) over all live
   * typed facts. Used by ontology backfill edge resolution — a recent-N window
   * would miss an old fact's contemporaries. Untyped rows are excluded: they
   * can never pass the edge target-type check, and batch facts typed during
   * the run are re-added to the in-memory index by the caller.
   */
  async findTitleIndexByEntityId(entityId: string, tx?: SQLiteAdapter): Promise<Array<{ id: string; title: string; okf_type: string | null }>> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<{ id: string; title: string; okf_type: string | null }>(
      `SELECT id, title, okf_type FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL AND okf_type IS NOT NULL`,
      [entityId],
    );
    return rows.map(r => ({ id: r.id, title: r.title, okf_type: r.okf_type ?? null }));
  }

  /** Counts live mutable facts: eligible (past cooldown) vs deferred (in cooldown). */
  async countHealCandidatesByEntityId(
    entityId: string,
    recheckCutoff: number,
    tx?: SQLiteAdapter,
  ): Promise<{ eligible: number; deferred: number }> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ eligible: number | null; deferred: number | null }>(
      `SELECT
         SUM(CASE WHEN heal_checked_at IS NULL OR heal_checked_at <= ? THEN 1 ELSE 0 END) AS eligible,
         SUM(CASE WHEN heal_checked_at IS NOT NULL AND heal_checked_at > ? THEN 1 ELSE 0 END) AS deferred
       FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL AND source_type != 'immutable_document'`,
      [recheckCutoff, recheckCutoff, entityId],
    );
    return { eligible: Number(row?.eligible ?? 0), deferred: Number(row?.deferred ?? 0) };
  }

  /**
   * Stamps the heal recheck cooldown. NEVER touches updated_at — import merge
   * resolution is last-write-wins on updated_at and a bump here would make an
   * unchanged local fact beat a genuinely newer remote edit.
   *
   * Soft-deleted rows are skipped: a candidate heal deleted earlier in the same
   * transaction is no longer a candidate under any future pass, so its cooldown
   * value is irrelevant. This means the stamped count can be lower than the
   * offered-candidate count.
   */
  async markHealChecked(ids: string[], entityId: string, now: number, tx: SQLiteAdapter): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      await tx.runAsync(
        `UPDATE ${this.prefix}entries SET heal_checked_at = ?
         WHERE id IN (${placeholders}) AND entity_id = ? AND deleted_at IS NULL`,
        [now, ...chunk, entityId],
      );
    }
  }

  /**
   * Lightweight full-breadth index (id, title) over all live librarian_inferred
   * facts. This is heal's fuzzy-dedupe corpus, deliberately kept independent of
   * the bounded candidate window: seeding dedupe from a batchSize-limited read
   * would let a synthesized fact duplicating a fact outside the window pass the
   * Jaccard check, and a convergence loop would multiply those duplicates across
   * passes. Mirrors findTitleIndexByEntityId — full breadth, two columns, cheap.
   */
  async findInferredTitlesByEntityId(
    entityId: string,
    tx?: SQLiteAdapter,
  ): Promise<Array<{ id: string; title: string }>> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<{ id: string; title: string }>(
      `SELECT id, title FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL AND source_type = 'librarian_inferred'`,
      [entityId],
    );
    return rows.map(r => ({ id: r.id, title: r.title }));
  }
}
