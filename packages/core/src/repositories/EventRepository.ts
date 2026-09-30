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
   * Watermark-guarded prune (spec 2026-09-29 competitive-memory §6): delete
   * events at or before `cutoff` **and** at-or-before the librarian watermark.
   * Events the librarian has not processed yet are retention-held, never
   * deleted. `wm = null` (no watermark yet) deletes nothing.
   * Used by runPrune under the deferred/ops strategies.
   */
  async pruneThrough(entityId: string, cutoff: number, wm: LibrarianWatermark | null): Promise<{ changes: number }> {
    if (!wm) return { changes: 0 };
    return this.db.runAsync(
      `DELETE FROM ${this.prefix}events WHERE entity_id = ? AND created_at <= ? AND NOT ${AFTER_SQL}`,
      [entityId, cutoff, ...afterArgs(wm)],
    );
  }

  /**
   * Count events at or before `cutoff` that are after the watermark — the
   * retention-held tail `pruneThrough` left in place. `wm = null` counts all
   * events at or before `cutoff` (every one of them is held back).
   */
  async countHeldBack(entityId: string, cutoff: number, wm: LibrarianWatermark | null): Promise<number> {
    const where = wm ? ` AND ${AFTER_SQL}` : '';
    const row = await this.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${this.prefix}events WHERE entity_id = ? AND created_at <= ?${where}`,
      [entityId, cutoff, ...(wm ? afterArgs(wm) : [])],
    );
    return Number(row?.n ?? 0);
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
   * Return events for `entityId` strictly after the watermark `(at, id)` in
   * chronological (ASC, id-ASC tie-break) order. Pass `wm = null` to read
   * from the beginning of the entity's event log. `limit` caps the result.
   *
   * Used by the op-based librarian (PR-B) to enumerate its unprocessed tail.
   */
  async getAfter(
    entityId: string,
    wm: LibrarianWatermark | null,
    limit?: number,
  ): Promise<WikiEvent[]> {
    const limitClause = limit != null ? ` LIMIT ?` : '';
    const params: unknown[] = wm ? [entityId, wm.at, wm.at, wm.id] : [entityId];
    const where = wm ? `entity_id = ? AND ${AFTER_SQL}` : `entity_id = ?`;
    if (limit != null) params.push(limit);
    const rows = await this.db.getAllAsync<WikiEvent>(
      `SELECT * FROM ${this.prefix}events WHERE ${where} ORDER BY created_at ASC, id ASC${limitClause}`,
      params,
    );
    return rows.map(mapEvent);
  }

  /**
   * Count of events for `entityId` strictly after the watermark. Used as
   * the op-based librarian's bounded batch size and by the deferred-maintenance
   * pending report. Pass `wm = null` to count the entity's whole event log
   * (no watermark yet) — mirrors `getAfter` / `sumSummaryCharsAfter`.
   */
  async countAfter(entityId: string, wm: LibrarianWatermark | null): Promise<number> {
    const params: unknown[] = wm ? [entityId, wm.at, wm.at, wm.id] : [entityId];
    const where = wm ? `entity_id = ? AND ${AFTER_SQL}` : `entity_id = ?`;
    const row = await this.db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.prefix}events WHERE ${where}`,
      params,
    );
    return row?.count ?? 0;
  }

  /**
   * Return the event at a given chronological offset for `entityId` (0-based,
   * oldest first). Used by MaintenanceService.seedLibrarianWatermark to anchor
   * the watermark on a real row when a legacy DB first migrates to the
   * op-based librarian. The offset is clamped and truncated to defend against
   * hostile or fractional callers.
   */
  async getAtOffset(entityId: string, offset: number, tx?: SQLiteAdapter): Promise<WikiEvent | null> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<any>(
      `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at ASC, id ASC LIMIT 1 OFFSET ?`,
      [entityId, Math.max(0, Math.trunc(offset))],
    );
    return row ? mapEvent(row) : null;
  }

  /**
   * Sum of `summary` lengths (in characters) for events for `entityId`
   * strictly after the watermark. Pass `wm = null` to sum the entity's whole
   * event log (no watermark yet). Used by the op-based librarian's token
   * budget estimator (PR-B) and by the auto-trigger's pending-size check
   * (PR-C). SQLite's `LENGTH` returns character count for UTF-8 text input.
   */
  async sumSummaryCharsAfter(entityId: string, wm: LibrarianWatermark | null, tx?: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    const params: unknown[] = wm ? [entityId, wm.at, wm.at, wm.id] : [entityId];
    const where = wm ? `entity_id = ? AND ${AFTER_SQL}` : `entity_id = ?`;
    const row = await executor.getFirstAsync<{ total: number | null }>(
      `SELECT SUM(LENGTH(summary)) as total FROM ${this.prefix}events WHERE ${where}`,
      params,
    );
    return row?.total ?? 0;
  }
}
