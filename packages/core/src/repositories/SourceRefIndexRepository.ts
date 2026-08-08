import type { SQLiteAdapter } from '../types';
import { BaseRepository } from './BaseRepository';
import { generateId } from '../utils/ids';

/**
 * Per-(entity_id, source_hash) record of the canonical sourceRef currently
 * holding that hash. The partial UNIQUE index on (entity_id, source_hash)
 * WHERE deleted_at IS NULL enforces the sourceRef-level TOCTOU-race invariant
 * for the #79 fix. See
 * docs/superpowers/specs/2026-08-07-dependabot-concurrency-release-hygiene-design.md §B1.
 *
 * The entries table cannot express this invariant directly because a single
 * `ingestDocument` call writes N facts that all share
 * (entity_id, source_ref, source_hash); a UNIQUE index on
 * `entries(entity_id, source_hash)` would block the 2nd–Nth fact inserts in
 * the normal multi-fact path. The per-(entity, hash) granularity of
 * source_ref_index matches the TOCTOU invariant exactly.
 *
 * No outbox events: this is an internal index table whose state is fully
 * derivable from `entries`. Hosts that need CDC continue to read `entries`
 * outbox events; the index is not part of the user-visible contract.
 */
export class SourceRefIndexRepository extends BaseRepository {
  /**
   * Idempotent insert: the partial UNIQUE index catches concurrent inserts for
   * the same (entity_id, source_hash). The caller (IngestionService) catches
   * the resulting SQLITE_CONSTRAINT_UNIQUE and translates it to the per-mode
   * duplicate-hash outcome. Runtime IDs use the `sri_` prefix to avoid
   * collision with the deterministic `sri:<entity>:<hash>` IDs used by the v9
   * backfill (the colon separator keeps the two ID spaces disjoint).
   */
  async upsert(
    entityId: string,
    sourceHash: string,
    sourceRef: string,
    tx: SQLiteAdapter,
  ): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [generateId('sri_'), entityId, sourceHash, sourceRef, Date.now()],
    );
  }

  /**
   * Idempotent soft-delete of the live row for (entity_id, source_ref).
   * Called at the start of every ingestDocument to remove the prior run's
   * index row, so the new upsert doesn't collide with itself. No-op when the
   * row is already soft-deleted or never existed.
   */
  async softDeleteByEntityAndSourceRef(
    entityId: string,
    sourceRef: string,
    tx: SQLiteAdapter,
  ): Promise<number> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    const result = await executor.runAsync(
      `UPDATE ${this.prefix}source_ref_index
       SET deleted_at = ?, created_at = ?
       WHERE entity_id = ? AND source_ref = ? AND deleted_at IS NULL`,
      [now, now, entityId, sourceRef],
    );
    return result.changes;
  }

  /**
   * Returns the live sourceRef holding the given hash, or null when no live
   * row exists. Used by the IngestionService pre-check (line 82) and the
   * catch-and-translate canonical lookup (line 212).
   */
  async findActiveByEntityAndHash(
    entityId: string,
    sourceHash: string,
    tx?: SQLiteAdapter,
  ): Promise<string | null> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ source_ref: string }>(
      `SELECT source_ref FROM ${this.prefix}source_ref_index
       WHERE entity_id = ? AND source_hash = ? AND deleted_at IS NULL`,
      [entityId, sourceHash],
    );
    return row?.source_ref ?? null;
  }
}
