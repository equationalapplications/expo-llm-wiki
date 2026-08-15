import type { SQLiteAdapter } from '../types';
import {
  formatSourcesJson,
  formatVerifiedJson,
  latestVerified,
} from '@equationalapplications/core-okf';

export type OkfSource = {
  id?: string;
  resource: string;
  title?: string;
  author?: string;
  usage_count?: number;
  last_modified?: string;
  usage_window?: { from: string; to: string };
};
export type OkfVerifiedEntry = { by: string; at: string };

/**
 * DAO discipline (spec §8): only knowledge-content writes may bump `updated_at`.
 * Trust / provenance / lifecycle / freshness writes MUST NOT touch it. Every
 * `UPDATE` in this class is a non-content metadata write. Tests in
 * `__tests__/daoDiscipline.test.ts` and `__tests__/okfTrustWrites.test.ts`
 * snapshot the SQL via a logging adapter and assert the SET clause omits
 * `updated_at`.
 *
 * Deliberately does NOT push an outbox event, unlike `EntryRepository.upsert`
 * / `TaskRepository.upsert` (spec §8 "Outbox/transaction scope" note): outbox
 * delivery exists for *content* sync, and these writes are metadata, not
 * content, by the same reasoning that exempts them from `updated_at`. A
 * downstream sync consumer will not learn about a new verifier until the
 * next full re-export/re-import — accepted for v0.2.
 */
export class OkfTrustWritesRepository {
  constructor(private db: SQLiteAdapter, private prefix: string) {}

  private getExecutor(tx?: SQLiteAdapter): SQLiteAdapter {
    return tx ?? this.db;
  }

  /**
   * Append one or more verification events to a fact's `okf_verified` JSON
   * array, atomically, in a single SQL statement.
   *
   * The implementation uses json_each over the existing array UNION ALL'd
   * with json_each over the new events wrapped in json_group_array — a single
   * UPDATE expression. SQLite serializes this against concurrent writers on
   * the same row, so two callers appending simultaneously cannot lose each
   * other's events (the previous implementation serialized only the supplied
   * array and overwrote, dropping any pre-existing history).
   *
   * Sets the `last_verified_*` convenience columns from the latest event in
   * the union (computed in code; see {@link latestVerified}).
   */
  async writeOkfTrust(
    entryId: string,
    entityId: string,
    verified: OkfVerifiedEntry[],
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    if (verified.length === 0) return;
    const latest = latestVerified(verified, Date.now());
    const newEventsJson = JSON.stringify(verified);
    await executor.runAsync(
      `UPDATE ${this.prefix}entries
         SET okf_verified = COALESCE(
           (SELECT json_group_array(json_object('by', s.by_val, 'at', s.at_val))
            FROM (
              SELECT json_extract(value, '$.by') AS by_val,
                     json_extract(value, '$.at') AS at_val
              FROM json_each(okf_verified)
              UNION ALL
              SELECT json_extract(value, '$.by'),
                     json_extract(value, '$.at')
              FROM json_each(?)
            ) AS s
            ORDER BY s.at_val),
           '[]'
         ),
         last_verified_by = ?,
         last_verified_at = ?
       WHERE id = ? AND entity_id = ?`,
      [newEventsJson, latest?.by ?? null, latest?.at ?? null, entryId, entityId],
    );
  }

  /** Replace the `sources` list (provenance). */
  async writeOkfSources(
    entryId: string,
    entityId: string,
    sources: OkfSource[],
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    const json = formatSourcesJson(sources);
    await executor.runAsync(
      `UPDATE ${this.prefix}entries
         SET okf_sources = ?
       WHERE id = ? AND entity_id = ?`,
      [json, entryId, entityId],
    );
  }

  /** Set the OKF v0.2 lifecycle status. */
  async setLifecycleStatus(
    entryId: string,
    entityId: string,
    status: 'draft' | 'stable' | 'deprecated',
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `UPDATE ${this.prefix}entries
         SET lifecycle_status = ?
       WHERE id = ? AND entity_id = ?`,
      [status, entryId, entityId],
    );
  }

  /** Set the absolute cutoff (epoch ms) for staleness, or NULL to clear. */
  async setStaleAfter(
    entryId: string,
    entityId: string,
    date: number | null,
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `UPDATE ${this.prefix}entries
         SET stale_after = ?
       WHERE id = ? AND entity_id = ?`,
      [date, entryId, entityId],
    );
  }

  /** Set the producer / verifier actor string. Rare. */
  async setGeneratedBy(
    entryId: string,
    entityId: string,
    actor: string,
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `UPDATE ${this.prefix}entries
         SET generated_by = ?
       WHERE id = ? AND entity_id = ?`,
      [actor, entryId, entityId],
    );
  }

  // The same five methods exist for tasks, with `tasks` instead of `entries`.
  // Tasks are symmetric per spec §2.5.

  /** Atomic append, task variant — mirrors {@link writeOkfTrust}. */
  async writeOkfTrustTask(
    taskId: string,
    entityId: string,
    verified: OkfVerifiedEntry[],
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    if (verified.length === 0) return;
    const latest = latestVerified(verified, Date.now());
    const newEventsJson = JSON.stringify(verified);
    await executor.runAsync(
      `UPDATE ${this.prefix}tasks
         SET okf_verified = COALESCE(
           (SELECT json_group_array(json_object('by', s.by_val, 'at', s.at_val))
            FROM (
              SELECT json_extract(value, '$.by') AS by_val,
                     json_extract(value, '$.at') AS at_val
              FROM json_each(okf_verified)
              UNION ALL
              SELECT json_extract(value, '$.by'),
                     json_extract(value, '$.at')
              FROM json_each(?)
            ) AS s
            ORDER BY s.at_val),
           '[]'
         ),
         last_verified_by = ?,
         last_verified_at = ?
       WHERE id = ? AND entity_id = ?`,
      [newEventsJson, latest?.by ?? null, latest?.at ?? null, taskId, entityId],
    );
  }

  async writeOkfSourcesTask(
    taskId: string,
    entityId: string,
    sources: OkfSource[],
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    const json = formatSourcesJson(sources);
    await executor.runAsync(
      `UPDATE ${this.prefix}tasks
         SET okf_sources = ?
       WHERE id = ? AND entity_id = ?`,
      [json, taskId, entityId],
    );
  }

  async setLifecycleStatusTask(
    taskId: string,
    entityId: string,
    status: 'draft' | 'stable' | 'deprecated',
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `UPDATE ${this.prefix}tasks
         SET lifecycle_status = ?
       WHERE id = ? AND entity_id = ?`,
      [status, taskId, entityId],
    );
  }

  async setStaleAfterTask(
    taskId: string,
    entityId: string,
    date: number | null,
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `UPDATE ${this.prefix}tasks
         SET stale_after = ?
       WHERE id = ? AND entity_id = ?`,
      [date, taskId, entityId],
    );
  }

  async setGeneratedByTask(
    taskId: string,
    entityId: string,
    actor: string,
    tx?: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `UPDATE ${this.prefix}tasks
         SET generated_by = ?
       WHERE id = ? AND entity_id = ?`,
      [actor, taskId, entityId],
    );
  }
}
