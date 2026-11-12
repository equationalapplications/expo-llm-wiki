import type { SQLiteAdapter } from '../types';
import { BaseRepository } from './BaseRepository';

export interface LedgerRow {
  seq: number;
  entity_id: string;
  fact_id: string;
  attempts: number;
  last_attempt_at: number | null;
  fact_state: 'live' | 'deleted' | 'gone';
}

export interface VectorRemovalScope {
  entityId?: string;
  ids?: string[];
}

export interface VectorRemovalCursor {
  maxSeq: number;
  attempts: number;
  seq: number;
}

const CHUNK = 500;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const marks = (n: number) => new Array(n).fill('?').join(',');

/**
 * Ledger of facts whose vectors the host's external index still owes a
 * removal for (spec durable-vector-removal §5.1). Rows are enqueued by
 * triggers on `entries`; this class reads and settles them.
 */
export class VectorRemovalRepository extends BaseRepository {
  /** True when the ledger table exists (false for a store whose setup never ran). */
  async tablePresent(): Promise<boolean> {
    const row = await this.getExecutor().getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [`${this.prefix}vector_removals`],
    );
    return row != null;
  }

  /** Unconfirmed rows after `cursor`, ordered by (attempts, seq). */
  async readPage(
    scope: VectorRemovalScope,
    cursor: VectorRemovalCursor,
    limit: number,
    tx: SQLiteAdapter,
  ): Promise<LedgerRow[]> {
    const executor = this.getExecutor(tx);
    const t = `${this.prefix}vector_removals`;
    const where: string[] = [
      'v.confirmed_at IS NULL',
      'v.seq <= ?',
      '(v.attempts > ? OR (v.attempts = ? AND v.seq > ?))',
    ];
    const args: unknown[] = [cursor.maxSeq, cursor.attempts, cursor.attempts, cursor.seq];
    if (scope.entityId !== undefined) {
      where.push('v.entity_id = ?');
      args.push(scope.entityId);
    }
    if (scope.ids !== undefined) {
      if (scope.ids.length === 0) return [];
      where.push(`v.fact_id IN (${marks(scope.ids.length)})`);
      args.push(...scope.ids);
    }
    args.push(limit);
    return executor.getAllAsync<LedgerRow>(
      `SELECT v.seq AS seq, v.entity_id AS entity_id, v.fact_id AS fact_id,
              v.attempts AS attempts, v.last_attempt_at AS last_attempt_at,
              CASE WHEN e.id IS NULL THEN 'gone'
                   WHEN e.deleted_at IS NULL THEN 'live'
                   ELSE 'deleted' END AS fact_state
         FROM ${t} v
         LEFT JOIN ${this.prefix}entries e ON e.id = v.fact_id
        WHERE ${where.join(' AND ')}
        ORDER BY v.attempts, v.seq
        LIMIT ?`,
      args,
    );
  }

  async maxSeq(tx?: SQLiteAdapter): Promise<number> {
    const row = await this.getExecutor(tx).getFirstAsync<{ m: number | null }>(
      `SELECT MAX(seq) AS m FROM ${this.prefix}vector_removals`,
    );
    return row?.m ?? 0;
  }

  /** Returns the number of rows changed. */
  async confirm(seqs: number[], now: number, tx: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    let changed = 0;
    for (const c of chunks(seqs, CHUNK)) {
      const r = await executor.runAsync(
        `UPDATE ${this.prefix}vector_removals SET confirmed_at = ?
          WHERE seq IN (${marks(c.length)})`,
        [now, ...c],
      );
      changed += r.changes;
    }
    return changed;
  }

  async bumpAttempts(seqs: number[], now: number, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    for (const c of chunks(seqs, CHUNK)) {
      await executor.runAsync(
        `UPDATE ${this.prefix}vector_removals
            SET attempts = attempts + 1, last_attempt_at = ?
          WHERE seq IN (${marks(c.length)})`,
        [now, ...c],
      );
    }
  }

  /** For stale, gone or resurrected rows. Applies to the given seqs only. */
  async deleteBySeq(seqs: number[], tx: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    let changed = 0;
    for (const c of chunks(seqs, CHUNK)) {
      const r = await executor.runAsync(
        `DELETE FROM ${this.prefix}vector_removals WHERE seq IN (${marks(c.length)})`,
        c,
      );
      changed += r.changes;
    }
    return changed;
  }

  /** Unconfirmed rows of `entityId` among `ids`. */
  async pendingCountForIds(entityId: string, ids: string[]): Promise<number> {
    let n = 0;
    for (const c of chunks(ids, CHUNK)) {
      const row = await this.db.getFirstAsync<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ${this.prefix}vector_removals
          WHERE confirmed_at IS NULL AND entity_id = ? AND fact_id IN (${marks(c.length)})`,
        [entityId, ...c],
      );
      n += row?.c ?? 0;
    }
    return n;
  }

  /** Enqueue ids that have no row yet. Returns the number inserted. */
  async backstopEnqueue(
    entityId: string,
    ids: string[],
    now: number,
    tx: SQLiteAdapter,
  ): Promise<number> {
    const executor = this.getExecutor(tx);
    let inserted = 0;
    for (const c of chunks(ids, CHUNK)) {
      const values = c.map(() => '(?, ?, ?)').join(',');
      const args = c.flatMap((id) => [entityId, id, now]);
      const r = await executor.runAsync(
        `INSERT OR IGNORE INTO ${this.prefix}vector_removals (entity_id, fact_id, enqueued_at)
         VALUES ${values}`,
        args,
      );
      inserted += r.changes;
    }
    return inserted;
  }

  /** Remove rows together with a hard delete of the facts. */
  async deleteForFacts(entityId: string, ids: string[], tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    for (const c of chunks(ids, CHUNK)) {
      await executor.runAsync(
        `DELETE FROM ${this.prefix}vector_removals
          WHERE entity_id = ? AND fact_id IN (${marks(c.length)})`,
        [entityId, ...c],
      );
    }
  }

  /** Drop unconfirmed rows. Returns the count removed. */
  async discardPending(entityId?: string, tx?: SQLiteAdapter): Promise<number> {
    const executor = this.getExecutor(tx);
    const r =
      entityId === undefined
        ? await executor.runAsync(
            `DELETE FROM ${this.prefix}vector_removals WHERE confirmed_at IS NULL`,
          )
        : await executor.runAsync(
            `DELETE FROM ${this.prefix}vector_removals WHERE confirmed_at IS NULL AND entity_id = ?`,
            [entityId],
          );
    return r.changes;
  }

  async pendingStats(
    entityId?: string,
  ): Promise<{ count: number; oldestEnqueuedAt: number | null; maxAttempts: number }> {
    const row = await this.db.getFirstAsync<{
      c: number;
      o: number | null;
      m: number | null;
    }>(
      `SELECT COUNT(*) AS c, MIN(enqueued_at) AS o, MAX(attempts) AS m
         FROM ${this.prefix}vector_removals
        WHERE confirmed_at IS NULL${entityId === undefined ? '' : ' AND entity_id = ?'}`,
      entityId === undefined ? [] : [entityId],
    );
    return { count: row?.c ?? 0, oldestEnqueuedAt: row?.o ?? null, maxAttempts: row?.m ?? 0 };
  }

  async entitiesWithPending(): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ entity_id: string }>(
      `SELECT DISTINCT entity_id FROM ${this.prefix}vector_removals
        WHERE confirmed_at IS NULL ORDER BY entity_id`,
    );
    return rows.map((r) => r.entity_id);
  }

  /** Groups pending ledger fact ids by entity, for diagnostics on an all-entities drain. */
  async entitiesForIds(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const c of chunks(ids, CHUNK)) {
      const rows = await this.db.getAllAsync<{ entity_id: string; fact_id: string }>(
        `SELECT DISTINCT entity_id, fact_id FROM ${this.prefix}vector_removals
          WHERE confirmed_at IS NULL AND fact_id IN (${marks(c.length)})`,
        c,
      );
      for (const r of rows) out.set(r.entity_id, [...(out.get(r.entity_id) ?? []), r.fact_id]);
    }
    return out;
  }

  async statusFor(ids: string[]): Promise<Map<string, 'pending' | 'confirmed'>> {
    const out = new Map<string, 'pending' | 'confirmed'>();
    for (const c of chunks(ids, CHUNK)) {
      const rows = await this.db.getAllAsync<{ fact_id: string; confirmed_at: number | null }>(
        `SELECT fact_id, confirmed_at FROM ${this.prefix}vector_removals
          WHERE fact_id IN (${marks(c.length)})`,
        c,
      );
      for (const r of rows) out.set(r.fact_id, r.confirmed_at === null ? 'pending' : 'confirmed');
    }
    return out;
  }
}
