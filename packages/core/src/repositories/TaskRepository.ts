import { BaseRepository } from './BaseRepository';
import { OutboxRepository } from './OutboxRepository';
import type { WikiTask, SQLiteAdapter } from '../types';

function mapRowToTask(row: any): WikiTask {
  return {
    id: row.id,
    entity_id: row.entity_id,
    description: row.description,
    status: row.status,
    priority: Number(row.priority),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    resolved_at: row.resolved_at != null ? Number(row.resolved_at) : null,
    deleted_at: row.deleted_at != null ? Number(row.deleted_at) : null,
  };
}

export class TaskRepository extends BaseRepository {
  constructor(
    db: SQLiteAdapter,
    prefix: string,
    private outbox: OutboxRepository,
  ) {
    super(db, prefix);
  }

  /**
   * Fetch a single task by ID. Returns null if not found or soft-deleted.
   */
  async findById(id: string): Promise<WikiTask | null> {
    const row = await this.db.getFirstAsync<any>(
      `SELECT * FROM ${this.prefix}tasks WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return row ? mapRowToTask(row) : null;
  }

  /**
   * Fetch all pending/in_progress tasks for the given entity IDs.
   * Returns empty array when entityIds is empty.
   */
  async findAllPending(entityIds: string[], limit?: number): Promise<WikiTask[]> {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(', ');
    const sql =
      `SELECT * FROM ${this.prefix}tasks ` +
      `WHERE entity_id IN (${placeholders}) AND status IN ('pending', 'in_progress') AND deleted_at IS NULL ` +
      `ORDER BY priority DESC, created_at ASC` +
      (limit != null ? ` LIMIT ?` : '');
    const params: unknown[] = limit != null ? [...entityIds, limit] : [...entityIds];
    const rows = await this.db.getAllAsync<any>(sql, params);
    return rows.map(mapRowToTask);
  }

  async findExistingMetadataByIds(
    ids: readonly string[],
    tx?: SQLiteAdapter,
  ): Promise<Array<{ id: string; entity_id: string; updated_at: number }>> {
    const executor = this.getExecutor(tx);
    const rows: Array<{ id: string; entity_id: string; updated_at: number }> = [];
    const chunkSize = 500;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = await executor.getAllAsync<any>(
        `SELECT id, entity_id, updated_at FROM ${this.prefix}tasks WHERE id IN (${placeholders})`,
        chunk,
      );
      rows.push(...chunkRows.map((row) => ({ id: row.id, entity_id: row.entity_id, updated_at: Number(row.updated_at) })));
    }
    return rows;
  }

  /**
   * Upsert a WikiTask within the provided transaction.
   * Uses ON CONFLICT(id) DO UPDATE (not INSERT OR REPLACE).
   * Stages an outbox entry in the same transaction.
   * `tx` is REQUIRED.
   */
  async upsert(task: WikiTask, tx: SQLiteAdapter, updatedAt?: number): Promise<void> {
    const executor = this.getExecutor(tx);
    const now = Number.isFinite(updatedAt) ? updatedAt : Date.now();

    const operation = task.deleted_at != null ? 'DELETE' : 'UPSERT';

    await executor.runAsync(
      `INSERT INTO ${this.prefix}tasks (
        id, entity_id, description, status, priority,
        created_at, updated_at, resolved_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity_id = excluded.entity_id,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at,
        deleted_at = excluded.deleted_at`,
      [
        task.id,
        task.entity_id,
        task.description,
        task.status,
        task.priority,
        task.created_at,
        now, // updated_at set by repo or import override
        task.resolved_at ?? null,
        task.deleted_at ?? null,
      ],
    );

    await this.outbox.push(
      {
        entityId: task.entity_id,
        tableName: 'tasks',
        recordId: task.id,
        operation,
        payload: task,
      },
      tx,
    );
  }

  async upsertForImport(task: WikiTask, tx: SQLiteAdapter, updatedAt?: number): Promise<void> {
    const executor = this.getExecutor(tx);
    const now = Number.isFinite(updatedAt) ? updatedAt : Date.now();

    await executor.runAsync(
      `INSERT INTO ${this.prefix}tasks (
        id, entity_id, description, status, priority,
        created_at, updated_at, resolved_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity_id = excluded.entity_id,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at,
        deleted_at = excluded.deleted_at`,
      [
        task.id,
        task.entity_id,
        task.description,
        task.status,
        task.priority,
        task.created_at,
        now,
        task.resolved_at ?? null,
        task.deleted_at ?? null,
      ],
    );
  }

  /**
   * Soft-delete a task by ID. Sets deleted_at and updated_at.
   * Stages a DELETE outbox entry in the same transaction.
   * `tx` is REQUIRED.
   */
  async softDelete(id: string, entityId: string, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    await executor.runAsync(
      `UPDATE ${this.prefix}tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`,
      [now, now, id, entityId],
    );
    await this.outbox.push(
      {
        entityId,
        tableName: 'tasks',
        recordId: id,
        operation: 'DELETE',
        payload: { id, entity_id: entityId, deleted_at: now },
      },
      tx,
    );
  }

  /**
   * Fetch all non-deleted tasks for an entity, ordered by priority DESC, created_at ASC.
   * Used by _getFullBundle().
   */
  async findAllByEntityId(entityId: string, tx?: SQLiteAdapter): Promise<WikiTask[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}tasks WHERE entity_id = ? AND deleted_at IS NULL ORDER BY priority DESC, created_at ASC`,
      [entityId],
    );
    return rows.map(mapRowToTask);
  }

  /**
   * Bulk delete pruned tasks (already soft-deleted) by cutoff date.
   * Used by runPrune(). Returns number of deleted rows.
   */
  async bulkDeletePruned(
    entityId: string,
    cutoff: number,
    tx: SQLiteAdapter,
  ): Promise<number> {
    const executor = this.getExecutor(tx);
    const rowsToDelete = await executor.getAllAsync<{ id: string; deleted_at: number }>(
      `SELECT id, deleted_at FROM ${this.prefix}tasks WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
      [entityId, cutoff],
    );
    if (rowsToDelete.length === 0) return 0;

    const result = await executor.runAsync(
      `DELETE FROM ${this.prefix}tasks WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
      [entityId, cutoff],
    );

    for (const row of rowsToDelete) {
      await this.outbox.push(
        {
          entityId,
          tableName: 'tasks',
          recordId: row.id,
          operation: 'DELETE',
          payload: { id: row.id, entity_id: entityId, deleted_at: row.deleted_at },
        },
        tx,
      );
    }

    return result.changes;
  }

  /**
   * Soft-delete a task by ID within a transaction.
   * Stages a DELETE outbox entry in the same transaction.
   * `tx` is REQUIRED.
   */
  async softDeleteById(
    id: string,
    entityId: string,
    tx: SQLiteAdapter,
  ): Promise<{ changes: number }> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const result = await executor.runAsync(
      `UPDATE ${this.prefix}tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`,
      [now, now, id, entityId],
    );
    if (result.changes > 0) {
      await this.outbox.push(
        {
          entityId,
          tableName: 'tasks',
          recordId: id,
          operation: 'DELETE',
          payload: { id, entity_id: entityId, deleted_at: now },
        },
        tx,
      );
    }
    return result;
  }

  /**
   * Bulk soft-delete all tasks for an entity.
   * Stages DELETE outbox entries for each row in the same transaction.
   * `tx` is REQUIRED.
   */
  async bulkSoftDeleteByEntityId(entityId: string, tx: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    // Get IDs before updating for outbox staging
    const idsToDelete = await executor.getAllAsync<{ id: string }>(
      `SELECT id FROM ${this.prefix}tasks WHERE entity_id = ? AND deleted_at IS NULL`,
      [entityId],
    );
    const result = await executor.runAsync(
      `UPDATE ${this.prefix}tasks SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL`,
      [now, now, entityId],
    );
    // Stage outbox entries for each deleted record
    for (const row of idsToDelete) {
      await this.outbox.push({
        entityId,
        tableName: 'tasks',
        recordId: row.id,
        operation: 'DELETE',
        payload: { id: row.id, entity_id: entityId, deleted_at: now },
      }, tx);
    }
    return result.changes;
  }
}
