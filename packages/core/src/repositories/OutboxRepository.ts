import { BaseRepository } from './BaseRepository';
import type { SQLiteAdapter } from '../types';
import { generateId } from '../utils/ids';

export class OutboxRepository extends BaseRepository {
  /**
   * Insert a new outbox event within the provided transaction.
   * `tx` is required — callers must always pass the active transaction
   * so the write is atomic with the main table mutation.
   */
  async push(
    params: {
      entityId: string;
      tableName: string;
      recordId: string;
      operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'UPSERT';
      payload: any;
    },
    tx: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    const id = generateId('out_');
    const now = Date.now();
    await executor.runAsync(
      `INSERT INTO ${this.prefix}outbox (id, entity_id, table_name, record_id, operation, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, params.entityId, params.tableName, params.recordId, params.operation, JSON.stringify(params.payload), now],
    );
  }

  /**
   * Fetch pending outbox rows ordered by created_at ASC.
   * Reads directly from `this.db` (not a transaction).
   */
  async fetchPending(limit = 50): Promise<any[]> {
    return this.db.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}outbox ORDER BY created_at ASC LIMIT ?`,
      [limit],
    );
  }

  /**
   * Delete acknowledged outbox rows by their IDs.
   * No-op when `ids` is empty.
   * Deletes directly from `this.db` (not a transaction).
   */
  async acknowledge(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    await this.db.runAsync(
      `DELETE FROM ${this.prefix}outbox WHERE id IN (${placeholders})`,
      ids,
    );
  }
}
