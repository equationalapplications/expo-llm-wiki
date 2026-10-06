/**
 * One document that both keyword-index strategies must understand. Both
 * implementations expect `tags` to be a single string with the JSON array's
 * tokens space-joined (see `toIndexDoc` in utils/indexDoc.ts). The exact token
 * shape is strategy-private — callers do not see it.
 */
export interface IndexDocument {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  tags: string;
}

export interface IndexSearchOptions {
  /** Empty array means "no entities match"; strategy returns []. */
  entityIds: string[];
  /** Upper bound on results returned. Strategy MUST return ≤ `limit`. */
  limit: number;
  /** Optional pre-filter cap used by hybrid retrieval. */
  preFilterLimit?: number;
}

export interface IndexSearchResult {
  id: string;
  /**
   * Strategy-native relevance: finite, non-negative, higher is better,
   * comparable only within one result set. Not normalized —
   * `SearchService.getKeywordScores` divides by `max(1, top)` for the hybrid
   * blend, and `searchKeyword` passes scores through unscaled. SearchService
   * drops any result whose score is not finite.
   */
  score: number;
  /**
   * The entity id this search result belongs to. Populated from
   * `IndexDocument.entity_id` by the strategy on every result.
   */
  entity_id: string;
}

/**
 * Keyword-index abstraction. The strategy owns its own backing store
 * (in-RAM MiniSearch vs on-disk FTS5) and is responsible for keeping it
 * consistent with the rows it has been told to write. The strategy also owns
 * the per-entity id bookkeeping — `SearchService` never sees the ids, only
 * an indexed-or-not probe.
 *
 * Concurrency: writes are called from serialized turns on
 * `SearchService.syncChain`, but searches are not, so each write method MUST
 * apply as one step — a concurrent `search()` sees the index wholly before or
 * wholly after it, never between its removal and its insertion. MiniSearch
 * gets this by never awaiting inside a write; FTS5 by one transaction per
 * write. Strategies MUST NOT spawn background work.
 */
export interface IndexStrategy {
  /**
   * Replace documents under `entityId`: remove the given `ids` only if they
   * are currently tracked under `entityId` (ids under other entities and ids
   * the strategy never indexed are silently ignored), then upsert
   * `documents` by id. The strategy owns its id-tracking structure; callers
   * do not see it. Used for incremental sync.
   *
   * Argument order is `(entityId, ids, documents)` so the FTS5 SQL
   * `DELETE … WHERE entity_id = ? AND id IN (…)` matches the call shape.
   */
  replace(
    entityId: string,
    ids: readonly string[],
    documents: readonly IndexDocument[],
  ): Promise<void>;

  /**
   * Drop every document currently tracked under `entityId`, then add
   * `documents` (all of which belong to `entityId`). The entity stays
   * registered as indexed, even when `documents` is empty — `hasIndexedEntity`
   * continues to return `true` so the next incremental sync can take the
   * fast path. Used for per-entity rebuilds.
   */
  replaceEntity(entityId: string, documents: readonly IndexDocument[]): Promise<void>;

  /**
   * Empty the entire index, then add `documents`. After this call, no entity
   * is registered as indexed (`hasIndexedEntity` returns `false` for every
   * entity). Used for global rebuilds and clears.
   */
  replaceAll(documents: readonly IndexDocument[]): Promise<void>;

  /**
   * Search the index, best match first. If `preFilterLimit` is set, the
   * strategy MAY return up to `preFilterLimit` candidates before the `limit`
   * cap is applied (hybrid retrieval uses this to over-fetch candidates for
   * downstream vector blending). Score semantics are in `IndexSearchResult`.
   */
  search(query: string, options: IndexSearchOptions): Promise<IndexSearchResult[]>;

  /**
   * Strategy-internal cleanup. For MiniSearch, this is the explicit vacuum
   * that `syncEntries` invokes after a discard-bearing turn (#64). FTS5 has
   * no equivalent; the default implementation is a no-op.
   */
  vacuum?(): Promise<void>;

  /**
   * `true` when `entityId` has been indexed at least once under the current
   * strategy state; `false` otherwise. `SearchService.syncEntries` uses this
   * to choose between the empty-ids no-op fast path and the full-rebuild
   * fallback. Implementations MUST return `false` after `replaceAll([])` and
   * MUST return `true` after a `replace`/`replaceEntity` that wrote at least
   * one document (including `replace(entityId, [], [])` for tracking alone).
   * Returning `undefined` means "unknown — take the rebuild path".
   */
  hasIndexedEntity?(entityId: string): boolean | undefined;

  /**
   * Create or verify the strategy's backing schema and run state changes.
   * Called once by `createIndexStrategy`, before the strategy is installed.
   */
  init?(): Promise<void>;

  /**
   * Apply every change recorded in the strategy's durable ledger, in bounded
   * chunks. A strategy that implements this keeps itself consistent with
   * SQLite on its own: `SearchService` routes every sync to `drain()` and
   * never feeds it rows (spec 2026-10-05 §PR-2 revision). MUST NOT be
   * called from inside a `withTransactionAsync` callback; it opens its own
   * transactions.
   */
  drain?(): Promise<void>;

  /** Rebuild entirely in SQL from the source tables; no rows pass through JS. */
  rebuildFromSource?(): Promise<void>;
}
