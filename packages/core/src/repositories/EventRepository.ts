import { BaseRepository } from './BaseRepository';
import type { WikiEvent, SQLiteAdapter } from '../types';
import type { LibrarianWatermark } from './MetadataRepository';

/**
 * Strict-after predicate on the (created_at, id) ordering used by the
 * op-based librarian (spec 2026-09-29 §4.1). Three placeholders: `[at, at, id]`.
 */
export const AFTER_SQL = '((created_at > ?) OR (created_at = ? AND id > ?))';

export function afterArgs(wm: LibrarianWatermark): [number, number, string] {
  return [wm.at, wm.at, wm.id];
}

/**
 * Map a row from the `events` table to the `WikiEvent` shape returned to
 * callers. `occurred_at` is dropped when NULL so legacy librarian prompt
 * bytes are unchanged for the (current default) case where no caller has
 * supplied a real-world timestamp.
 */
function mapEvent(row: WikiEvent): WikiEvent {
  if (row.occurred_at == null) {
    const rest: WikiEvent = { ...row };
    delete (rest as { occurred_at?: number | null }).occurred_at;
    return rest;
  }
  return row;
}

export class EventRepository extends BaseRepository {
  /**
   * Insert a new event row.
   * Pass `tx` to participate in a caller-owned transaction; omit to run against the default db.
   */
  async add(event: WikiEvent, tx?: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.entity_id,
        event.event_type,
        event.summary,
        event.related_entry_id ?? null,
        event.created_at,
        event.occurred_at ?? null,
      ],
    );
  }

  async addIgnoreDuplicate(event: WikiEvent, tx?: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT OR IGNORE INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.entity_id,
        event.event_type,
        event.summary,
        event.related_entry_id ?? null,
        event.created_at,
        event.occurred_at ?? null,
      ],
    );
  }

  /**
   * Return the most recent events for an entity, newest first.
   * Defaults to a limit of 50.
   */
  async getRecent(entityId: string, limit = 50): Promise<WikiEvent[]> {
    const rows = await this.db.getAllAsync<WikiEvent>(
      `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?`,
      [entityId, limit],
    );
    return rows.map(mapEvent);
  }

  /**
   * Return the most recent events for the given entity IDs, newest first.
   * Defaults to a limit of 50.
   */
  async getRecentForEntities(entityIds: string[], limit = 50): Promise<WikiEvent[]> {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(', ');
    const rows = await this.db.getAllAsync<WikiEvent>(
      `SELECT * FROM ${this.prefix}events WHERE entity_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`,
      [...entityIds, limit],
    );
    return rows.map(mapEvent);
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
      return rows.map(mapEvent).slice().reverse();
    }
    const rows = await this.db.getAllAsync<WikiEvent>(
      `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at ASC`,
      [entityId],
    );
    return rows.map(mapEvent);
  }

  /**
   * Return events strictly after the watermark `(at, id)` in chronological
   * (ASC) order. When `entityId` is provided, restrict to that entity.
   *
   * Used by the op-based librarian (PR-B) to enumerate its unprocessed tail.
   */
  async getAfter(wm: LibrarianWatermark, entityId?: string): Promise<WikiEvent[]> {
    const args = afterArgs(wm);
    const rows = entityId
      ? await this.db.getAllAsync<WikiEvent>(
          `SELECT * FROM ${this.prefix}events WHERE entity_id = ? AND ${AFTER_SQL} ORDER BY created_at ASC, id ASC`,
          [entityId, ...args],
        )
      : await this.db.getAllAsync<WikiEvent>(
          `SELECT * FROM ${this.prefix}events WHERE ${AFTER_SQL} ORDER BY created_at ASC, id ASC`,
          args,
        );
    return rows.map(mapEvent);
  }

  /**
   * Count of events strictly after the watermark. Used as the op-based
   * librarian's bounded batch size.
   */
  async countAfter(wm: LibrarianWatermark, entityId?: string): Promise<number> {
    const args = afterArgs(wm);
    const row = entityId
      ? await this.db.getFirstAsync<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${this.prefix}events WHERE entity_id = ? AND ${AFTER_SQL}`,
          [entityId, ...args],
        )
      : await this.db.getFirstAsync<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${this.prefix}events WHERE ${AFTER_SQL}`,
          args,
        );
    return row?.count ?? 0;
  }

  /**
   * Sum of `summary` lengths (in characters) for events strictly after the
   * watermark. Used by the op-based librarian's token budget estimator
   * (PR-B); CHAR_LENGTH keeps the count locale-independent on every SQLite.
   */
  async sumSummaryCharsAfter(wm: LibrarianWatermark, entityId?: string): Promise<number> {
    const args = afterArgs(wm);
    const row = entityId
      ? await this.db.getFirstAsync<{ total: number | null }>(
          `SELECT SUM(CHAR_LENGTH(summary)) as total FROM ${this.prefix}events WHERE entity_id = ? AND ${AFTER_SQL}`,
          [entityId, ...args],
        )
      : await this.db.getFirstAsync<{ total: number | null }>(
          `SELECT SUM(CHAR_LENGTH(summary)) as total FROM ${this.prefix}events WHERE ${AFTER_SQL}`,
          args,
        );
    return row?.total ?? 0;
  }
}
