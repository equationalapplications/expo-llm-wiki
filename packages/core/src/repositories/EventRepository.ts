import { BaseRepository } from './BaseRepository';
import type { WikiEvent, SQLiteAdapter } from '../types';

export class EventRepository extends BaseRepository {
  /**
   * Insert a new event row.
   * `tx` is optional — callers may pass an active transaction handle or omit it
   * to write directly to the main db connection.
   */
  async add(event: WikiEvent, tx?: SQLiteAdapter): Promise<void> {
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
   */
  async count(entityId: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.prefix}events WHERE entity_id = ?`,
      [entityId],
    );
    return row?.count ?? 0;
  }
}
