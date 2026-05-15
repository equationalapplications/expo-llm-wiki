import { BaseRepository } from './BaseRepository';
import type { WikiEvent, SQLiteAdapter } from '../types';

export class EventRepository extends BaseRepository {
  /**
   * Insert a new event row.
   * `tx` is required to ensure mutations are atomic within transactions.
   */
  async add(event: WikiEvent, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.entity_id,
        event.event_type,
        event.summary,
        event.related_entry_id ?? null,
        event.created_at,
      ],
    );
  }

  async addIgnoreDuplicate(event: WikiEvent, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT OR IGNORE INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.entity_id,
        event.event_type,
        event.summary,
        event.related_entry_id ?? null,
        event.created_at,
      ],
    );
  }

  /**
   * Return the most recent events for an entity, newest first.
   * Defaults to a limit of 50.
   */
  async getRecent(entityId: string, limit = 50): Promise<WikiEvent[]> {
    return this.db.getAllAsync<WikiEvent>(
      `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?`,
      [entityId, limit],
    );
  }

  /**
   * Return the most recent events for the given entity IDs, newest first.
   * Defaults to a limit of 50.
   */
  async getRecentForEntities(entityIds: string[], limit = 50): Promise<WikiEvent[]> {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(', ');
    return this.db.getAllAsync<WikiEvent>(
      `SELECT * FROM ${this.prefix}events WHERE entity_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`,
      [...entityIds, limit],
    );
  }

  /**
   * Delete events for an entity that were created at or before the given cutoff timestamp.
   * Returns the number of deleted rows.
   */
  async prune(entityId: string, cutoff: number): Promise<{ changes: number }> {
    return this.db.runAsync(
      `DELETE FROM ${this.prefix}events WHERE entity_id = ? AND created_at <= ?`,
      [entityId, cutoff],
    );
  }

  /**
   * Return the total number of events stored for an entity.
   * `tx` is optional — pass an active transaction handle for atomic reads.
   */
  async count(entityId: string, tx?: SQLiteAdapter): Promise<number> {
    const executor = tx ?? this.db;
    const row = await executor.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.prefix}events WHERE entity_id = ?`,
      [entityId],
    );
    return row?.count ?? 0;
  }

  /**
   * Return all events for an entity in chronological (ASC) order.
   * When limit is provided, fetches newest-first then reverses to preserve chronological order.
   */
  async getByEntityId(entityId: string, limit?: number): Promise<WikiEvent[]> {
    if (limit != null) {
      const rows = await this.db.getAllAsync<WikiEvent>(
        `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?`,
        [entityId, limit],
      );
      return rows.slice().reverse();
    }
    return this.db.getAllAsync<WikiEvent>(
      `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at ASC`,
      [entityId],
    );
  }
}
