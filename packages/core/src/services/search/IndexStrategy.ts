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
   * Strategy-native relevance: non-negative, higher is better, comparable
   * only within one result set. Not normalized — `SearchService.getKeywordScores`
   * divides by `max(1, top)` for the hybrid blend, and `searchKeyword` passes
   * scores through unscaled. Strategies MAY emit `NaN` for tie-handling;
   * `SearchService._compareSearchResults` already tolerates this.
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
 * Concurrency: every method is callable from a serialized turn on
 * `SearchService.syncChain`. Strategies MUST NOT spawn background work.
 */
export interface IndexStrategy {
  /** Insert or replace. Both implementations upsert by primary key (id). */
  add(documents: readonly IndexDocument[]): Promise<void>;

  /**
   * Remove by id. Missing ids are silently ignored. Implementations MUST NOT
   * touch ids outside the supplied list.
   */
  discard(ids: readonly string[]): Promise<void>;

  /** Empty the entire index. Per-entity clears use discard() with the entity's known ids. */
  removeAll(): Promise<void>;

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
   * Returns the set of ids previously indexed under `entityId`, used by
   * `SearchService.rebuildIndex` to know which docs to discard before
   * adding fresh ones. Only MiniSearch implements this (it tracks per-entity
   * id sets in-RAM); strategies whose discard is keyed by a SQL-side
   * predicate (FTS5) do not need it and return `undefined`.
   */
  getEntryIdsByEntity?(entityId: string): ReadonlySet<string> | undefined;
}
