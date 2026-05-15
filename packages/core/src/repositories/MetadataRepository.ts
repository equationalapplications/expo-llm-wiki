import { BaseRepository } from './BaseRepository';
import type { SQLiteAdapter } from '../types';

export class MetadataRepository extends BaseRepository {
  // CHECKPOINTS TABLE METHODS

  async getCheckpoint(entityId: string, tx: SQLiteAdapter): Promise<{ memory?: number; heal?: number }> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{
      memory_checkpoint: number | null;
      heal_checkpoint: number | null;
    }>(
      `SELECT memory_checkpoint, heal_checkpoint FROM ${this.prefix}checkpoints WHERE entity_id = ?`,
      [entityId],
    );
    if (!row) return {};
    return {
      memory: row.memory_checkpoint ?? undefined,
      heal: row.heal_checkpoint ?? undefined,
    };
  }

  async updateCheckpoint(
    entityId: string,
    updates: { memory?: number; heal?: number },
    tx: SQLiteAdapter,
  ): Promise<void> {
    const fields: string[] = [];
    const values: number[] = [];

    if (updates.memory !== undefined) {
      fields.push('memory_checkpoint = ?');
      values.push(updates.memory);
    }
    if (updates.heal !== undefined) {
      fields.push('heal_checkpoint = ?');
      values.push(updates.heal);
    }
    if (fields.length === 0) return;

    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}checkpoints (entity_id, memory_checkpoint, heal_checkpoint)
       VALUES (?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET ${fields.join(', ')}`,
      [entityId, updates.memory ?? 0, updates.heal ?? 0, ...values],
    );
  }

  async deleteCheckpoint(entityId: string, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `DELETE FROM ${this.prefix}checkpoints WHERE entity_id = ?`,
      [entityId],
    );
  }

  // META TABLE METHODS

  async getMeta(key: string, tx?: SQLiteAdapter): Promise<string | null> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ value: string }>(
      `SELECT value FROM ${this.prefix}meta WHERE key = ?`,
      [key],
    );
    return row ? row.value : null;
  }

  async setMeta(key: string, value: string, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async clearDimensionMismatch(tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `DELETE FROM ${this.prefix}meta WHERE key = 'embedding_dimension_mismatch'`,
    );
  }
}
