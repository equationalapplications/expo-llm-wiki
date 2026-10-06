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
 * consistent with the rows it has been told to add/discard.
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
   * Remove `ids` (missing ones are ignored), then upsert `documents` by id.
   * Touches no other id. Used for incremental sync.
   */
  replace(ids: readonly string[], documents: readonly IndexDocument[]): Promise<void>;

  /**
   * Remove every document indexed under `entityId`, then add `documents`
   * (all of which belong to `entityId`). Used for per-entity rebuilds.
   */
  replaceEntity(entityId: string, documents: readonly IndexDocument[]): Promise<void>;

  /** Empty the index, then add `documents`. Used for global rebuilds and clears. */
  replaceAll(documents: readonly IndexDocument[]): Promise<void>;

  /**
   * Search the index, best match first. If
   * `preFilterLimit` is set, the strategy MAY return up to `preFilterLimit`
   * candidates before the `limit` cap is applied (hybrid retrieval uses this
   * to over-fetch candidates for downstream vector blending).
   */
  search(query: string, options: IndexSearchOptions): Promise<IndexSearchResult[]>;

  /**
   * Strategy-internal cleanup. For MiniSearch, this is the explicit vacuum
   * that `syncEntries` invokes after a discard-bearing turn (#64). FTS5 has
   * no equivalent; the default implementation is a no-op.
   */
  vacuum?(): Promise<void>;

  /**
   * Returns the set of ids indexed under `entityId`, or `undefined` if the
   * entity has never been indexed. `SearchService.syncEntries` uses it to
   * decide between the incremental path and a full `replaceEntity` rebuild,
   * and to discard only ids that belong to the entity.
   */
  getEntryIdsByEntity?(entityId: string): ReadonlySet<string> | undefined;
}
