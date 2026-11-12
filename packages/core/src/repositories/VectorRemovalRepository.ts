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

/** Wait before a failed row is retried by a backoff drain: min(2^attempts, 3600) seconds. */
export function removalBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts, 3600) * 1000;
}

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
  /** Name of the ledger table. */
  get ledgerTable(): string {
    return `${this.prefix}vector_removals`;
  }

  /** Owe the host a removal for `factId` unless a live row exists (a missing row counts as not live). Returns whether a row was enqueued. */
  async enqueueIfNotLive(entityId: string, factId: string, now: number): Promise<boolean> {
    // In its own transaction so it can't join a host's open raw transaction.
    return this.db.withTransactionAsync(async (tx) => {
      const r = await tx.runAsync(
        `INSERT OR REPLACE INTO ${this.prefix}vector_removals (entity_id, fact_id, enqueued_at)
         SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${this.prefix}entries WHERE id = ? AND deleted_at IS NULL)`,
        [entityId, factId, now, factId],
      );
      return (r?.changes ?? 0) > 0;
    });
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
      // Unary plus keeps SQLite from picking the (entity_id, ...) partial index
      // and scanning the entity's whole pending set when ids are given.
      where.push(scope.ids !== undefined ? '+v.entity_id = ?' : 'v.entity_id = ?');
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
          WHERE confirmed_at IS NULL AND seq IN (${marks(c.length)})`,
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
          WHERE confirmed_at IS NULL AND +entity_id = ? AND fact_id IN (${marks(c.length)})`,
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
    for (const c of chunks(ids, 300)) {
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

  /**
   * Remove rows together with a hard delete of the facts. `'all'` drops every
   * row of those ids; `'confirmedGone'` drops only confirmed rows whose fact
   * row no longer exists, so a removal re-owed meanwhile is never erased.
   */
  async deleteForFacts(
    entityId: string,
    ids: string[],
    tx: SQLiteAdapter,
    mode: 'all' | 'confirmedGone' = 'all',
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    const extra = mode === 'all'
      ? ''
      : ` AND confirmed_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${this.prefix}entries e WHERE e.id = ${this.prefix}vector_removals.fact_id)`;
    for (const c of chunks(ids, CHUNK)) {
      await executor.runAsync(
        `DELETE FROM ${this.prefix}vector_removals
          WHERE entity_id = ? AND fact_id IN (${marks(c.length)})${extra}`,
        [entityId, ...c],
      );
    }
  }

  /**
   * Delete rows whose fact row no longer exists: confirmed ones always, and
   * pending ones too when `includePending` (nothing can still owe them).
   * Keyed on `fact_id` store-wide. Returns the count removed.
   */
  async sweepOrphans(includePending: boolean, tx?: SQLiteAdapter): Promise<number> {
    const r = await this.getExecutor(tx).runAsync(
      `DELETE FROM ${this.prefix}vector_removals
        WHERE ${includePending ? '1 = 1' : 'confirmed_at IS NOT NULL'}
          AND NOT EXISTS (SELECT 1 FROM ${this.prefix}entries e WHERE e.id = ${this.prefix}vector_removals.fact_id)`,
    );
    return r?.changes ?? 0;
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

  /**
   * Entities with at least one pending row outside backoff (never attempted,
   * or last attempted longer ago than removalBackoffMs). Same rule as the drain.
   */
  async entitiesWithDuePending(now: number): Promise<string[]> {
    // (1 << MIN(attempts, 12)) = 2^attempts capped past 3600; keep in step with removalBackoffMs.
    const rows = await this.db.getAllAsync<{ entity_id: string }>(
      `SELECT DISTINCT entity_id FROM ${this.prefix}vector_removals
        WHERE confirmed_at IS NULL
          AND (last_attempt_at IS NULL
               OR ? - last_attempt_at >= MIN(1 << MIN(attempts, 12), 3600) * 1000)
        ORDER BY entity_id`,
      [now],
    );
    return rows.map((r) => r.entity_id);
  }

  async statusFor(ids: string[], tx?: SQLiteAdapter): Promise<Map<string, 'pending' | 'confirmed'>> {
    const executor = this.getExecutor(tx);
    const out = new Map<string, 'pending' | 'confirmed'>();
    for (const c of chunks(ids, CHUNK)) {
      const rows = await executor.getAllAsync<{ fact_id: string; confirmed_at: number | null }>(
        `SELECT fact_id, confirmed_at FROM ${this.prefix}vector_removals
          WHERE fact_id IN (${marks(c.length)})`,
        c,
      );
      for (const r of rows) out.set(r.fact_id, r.confirmed_at === null ? 'pending' : 'confirmed');
    }
    return out;
  }
}
