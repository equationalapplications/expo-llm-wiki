// packages/core/src/services/search/MiniSearchIndexStrategy.ts

import MiniSearch from 'minisearch';
import type {
  IndexDocument,
  IndexSearchOptions,
  IndexSearchResult,
  IndexStrategy,
} from './IndexStrategy';

/**
 * In-RAM keyword index. Extracted from `SearchService` without behavior
 * change. The strategy owns the MiniSearch instance, the `entryIdsByEntity`
 * tracking map, the `entityIdById` reverse map, and the explicit-vacuum
 * policy (#64).
 *
 * Memory cost: O(total text). The fix for #257 lives in PR-2's FTS5
 * strategy; this one stays for Expo/OPFS environments without FTS5 and for
 * hosts that explicitly pin `WikiConfig.indexStrategy: 'minisearch'`.
 */
export class MiniSearchIndexStrategy implements IndexStrategy {
  private index: MiniSearch<IndexDocument>;
  /**
   * Per-entity id set. `replaceEntity()` and `hasIndexedEntity()` read it;
   * `addDocuments()` and `discardIds()` keep it in sync. `SearchService` does
   * not see this map; it only sees `hasIndexedEntity`. The previous
   * `miniSearchEntryIdsByEntity` lived on `SearchService`.
   */
  private entryIdsByEntity = new Map<string, Set<string>>();
  /**
   * Reverse of `entryIdsByEntity`. `replace(entityId, ids, …)` uses it to
   * decide which ids are owned by `entityId` (the only safe membership test
   * — a rebuild that failed between its discard pass and the set replacement
   * can leave the forward set claiming ids the MiniSearch instance does not
   * hold). The pre-extraction `syncEntries` deleted from one set per id, not
   * from every entity's set.
   */
  private entityIdById = new Map<string, string>();

  constructor() {
    this.index = this.createIndex();
  }

  /**
   * Build a fresh MiniSearch instance with the project's index options.
   * Called from the constructor and from `replaceAll`. We do not use
   * `removeAll()` on an existing instance because that empties the index but
   * leaves `dirtCount` and the vacuum bookkeeping intact, which would trip
   * `syncEntries`' conditional vacuum early after a clear.
   */
  private createIndex(): MiniSearch<IndexDocument> {
    return new MiniSearch({
      fields: ['title', 'body', 'tags'],
      storeFields: ['entity_id'],
      // Vacuuming is driven explicitly at the end of each serialized rebuild
      // (see SearchService.syncEntries). Auto-vacuum fires on its own
      // schedule, asynchronously with respect to the caller, and traversing
      // the tree mid-rebuild is what threw the uncaught TypeError in
      // MiniSearch.performVacuuming (#64).
      autoVacuum: false,
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  /**
   * Incremental sync. Removes only ids currently tracked under `entityId`
   * (other entities' docs are untouched), then upserts `documents` by id.
   * `addAll` throws on a duplicate id, so the same id appearing in both
   * `ids` and `documents` is discarded first — the upsert is a no-op when
   * the new doc has the same content.
   *
   * Atomicity: never awaits between the discard pass and `addDocuments`, so
   * a concurrent `search()` sees the index wholly before or wholly after,
   * never half-updated. This is the precondition the pre-extraction
   * `syncEntries` kept with its "no await from here to `addAll`" comment.
   */
  async replace(
    entityId: string,
    ids: readonly string[],
    documents: readonly IndexDocument[],
  ): Promise<void> {
    this.discardIds(ids, entityId);
    this.addDocuments(documents);
  }

  /**
   * Per-entity rebuild. Removes every id tracked under `entityId` (with the
   * `index.has(id)` guard so a stale tracking set cannot make `discard()`
   * throw), then writes `documents`. The entity stays registered as
   * indexed — even when `documents` is empty — so the next `syncEntries`
   * call can take the fast path.
   */
  async replaceEntity(entityId: string, documents: readonly IndexDocument[]): Promise<void> {
    const previous = this.entryIdsByEntity.get(entityId);
    if (previous) this.discardIds([...previous]);
    // Registered even when empty, so hasIndexedEntity(entityId) === true.
    this.entryIdsByEntity.set(entityId, new Set());
    this.addDocuments(documents);
  }

  /**
   * Global rebuild / clear. Replaces the MiniSearch instance and clears both
   * id maps, so `hasIndexedEntity` returns `false` for every entity afterwards.
   * `SearchService.clearAll()` calls `replaceAll([])`.
   */
  async replaceAll(documents: readonly IndexDocument[]): Promise<void> {
    this.index = this.createIndex();
    this.entryIdsByEntity.clear();
    this.entityIdById.clear();
    this.addDocuments(documents);
  }

  /**
   * Best-match-first search over the documents whose `entity_id` is in
   * `options.entityIds`. `preFilterLimit` overrides `limit` (hybrid retrieval
   * uses this to over-fetch candidates before the `limit` cap). Scores are
   * raw BM25+ — `SearchService.getKeywordScores` and `searchKeyword` apply
   * any scaling, not the strategy.
   */
  async search(query: string, options: IndexSearchOptions): Promise<IndexSearchResult[]> {
    if (options.entityIds.length === 0) return [];
    const entityIdSet = new Set(options.entityIds);
    const limit = options.preFilterLimit ?? options.limit;
    const raw = this.index.search(query, {
      filter: (r) => entityIdSet.has((r as unknown as IndexDocument).entity_id),
      combineWith: 'OR',
    });
    // Tiebreak equal-score results by id before slicing: MiniSearch breaks
    // ties by internal insertion order, which the strategy's own
    // discard/add changes. Callers truncate to a `limit`, so the ids
    // surviving a tie at the boundary must not depend on write history.
    raw.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (!Number.isNaN(scoreDiff) && scoreDiff !== 0) return scoreDiff;
      return a.id.localeCompare(b.id);
    });
    // `storeFields: ['entity_id']` puts entity_id on every result.
    return raw.slice(0, limit).map((r) => ({
      id: r.id,
      entity_id: (r as unknown as IndexDocument).entity_id,
      score: r.score,
    }));
  }

  /**
   * Explicit vacuum. MiniSearch 7.2.0's `dirtCount` rule: search after an
   * un-vacuumed discard inverts the relative scores of term-sharing
   * documents at any index size. `SearchService.syncEntries` calls this
   * after a discard-bearing turn. No-op when `dirtCount === 0`.
   */
  async vacuum(): Promise<void> {
    if (this.index.dirtCount > 0) {
      await this.index.vacuum();
    }
  }

  /**
   * `true` when `entityId` has been indexed at least once under the current
   * strategy state. Backed by `entryIdsByEntity.has(entityId)`, which is
   * kept in sync by `addDocuments`, `replaceEntity`, and `replaceAll`.
   */
  hasIndexedEntity(entityId: string): boolean {
    return this.entryIdsByEntity.has(entityId);
  }

  /**
   * Upsert `documents` into the MiniSearch instance and register them in
   * `entryIdsByEntity` and `entityIdById`. MiniSearch mutates documents
   * during `addAll`, so we pass copies. Idempotent: re-adding an already
   * indexed id is a no-op when the document is identical, otherwise
   * MiniSearch's `addAll` throws — `replace` discards first for that reason.
   */
  private addDocuments(documents: readonly IndexDocument[]): void {
    if (documents.length === 0) return;
    const docs: IndexDocument[] = documents.map((d) => ({ ...d }));
    this.index.addAll(docs);
    for (const doc of docs) {
      const set = this.entryIdsByEntity.get(doc.entity_id) ?? new Set<string>();
      set.add(doc.id);
      this.entryIdsByEntity.set(doc.entity_id, set);
      this.entityIdById.set(doc.id, doc.entity_id);
    }
  }

  /**
   * Discard `ids` from the MiniSearch instance and from both id maps, but
   * only for ids currently owned by `entityId` (the second argument). When
   * `entityId` is omitted (used by `replaceEntity` for the bulk rebuild
   * path), every id is discarded regardless of owning entity.
   *
   * `index.has(id)` is the membership test of record: a rebuild that failed
   * between its own discard pass and the set replacement can leave the
   * tracking set claiming ids the index no longer holds — `discard()` throws
   * on those, so we guard.
   */
  private discardIds(ids: readonly string[], entityId?: string): void {
    for (const id of ids) {
      // Scope check first: an id not owned by `entityId` is silently ignored.
      // Doing the scope check before `index.discard` is what stops a
      // `replace(entityId, ids, …)` call from touching docs under any other
      // entity.
      const owning = this.entityIdById.get(id);
      if (owning === undefined) continue;
      if (entityId !== undefined && owning !== entityId) continue;
      if (this.index.has(id)) this.index.discard(id);
      this.entryIdsByEntity.get(owning)?.delete(id);
      this.entityIdById.delete(id);
    }
  }
}