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
 * tracking map, and the explicit-vacuum policy (#64).
 *
 * Memory cost: O(total text). The fix for #257 lives in PR-2's FTS5
 * strategy; this one stays for Expo/OPFS environments without FTS5 and for
 * hosts that explicitly pin `WikiConfig.indexStrategy: 'minisearch'`.
 */
export class MiniSearchIndexStrategy implements IndexStrategy {
  private index: MiniSearch<IndexDocument>;
  /**
   * Per-entity id set: replaceEntity() discards from it, and
   * `SearchService.syncEntries` reads it (via getEntryIdsByEntity) to pick
   * the incremental path. The previous `miniSearchEntryIdsByEntity` lived on
   * SearchService.
   */
  private entryIdsByEntity = new Map<string, Set<string>>();
  /**
   * Reverse of `entryIdsByEntity`, so discardIds() touches only the owning
   * entity's set — the pre-extraction syncEntries deleted from that one set
   * rather than scanning every entity's.
   */
  private entityIdById = new Map<string, string>();

  constructor() {
    this.index = this.createIndex();
  }

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

  // Writes never await: MiniSearch is synchronous, so each one applies as a
  // single step and a concurrent search sees the index before or after it,
  // never half-updated — the guarantee the pre-extraction syncEntries kept
  // with "no await from here to addAll".

  async replace(ids: readonly string[], documents: readonly IndexDocument[]): Promise<void> {
    // Upsert: addAll throws on an id already in the index.
    this.discardIds([...ids, ...documents.map((d) => d.id)]);
    this.addDocuments(documents);
  }

  async replaceEntity(entityId: string, documents: readonly IndexDocument[]): Promise<void> {
    const previous = this.entryIdsByEntity.get(entityId);
    if (previous) this.discardIds([...previous]);
    // Registered even when empty, so syncEntries treats the entity as tracked.
    this.entryIdsByEntity.set(entityId, new Set());
    this.addDocuments(documents);
  }

  async replaceAll(documents: readonly IndexDocument[]): Promise<void> {
    // A fresh instance, not removeAll(): that empties the index but keeps
    // dirtCount and vacuum bookkeeping (minisearch 7.2.0), which would trip
    // syncEntries' conditional vacuum early after a clear.
    this.index = this.createIndex();
    this.entryIdsByEntity.clear();
    this.entityIdById.clear();
    this.addDocuments(documents);
  }

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
    // Raw MiniSearch scores, unscaled: searchKeyword callers and the
    // exposed factScores saw these before the extraction, and
    // getKeywordScores applies its own max(1, top) scaling.
    // `storeFields: ['entity_id']` puts entity_id on every result.
    return raw.slice(0, limit).map((r) => ({
      id: r.id,
      entity_id: (r as unknown as IndexDocument).entity_id,
      score: r.score,
    }));
  }

  async vacuum(): Promise<void> {
    // The MiniSearch 7.2.0 dirtCount rule: search after an un-vacuumed
    // discard inverts the relative scores of term-sharing documents at any
    // index size. Call this from SearchService.syncEntries after a
    // discard-bearing turn.
    if (this.index.dirtCount > 0) {
      await this.index.vacuum();
    }
  }

  /** Returns the per-entity id set — used by SearchService to know which
   *  docs to discard on a per-entity rebuild. */
  getEntryIdsByEntity(entityId: string): ReadonlySet<string> | undefined {
    return this.entryIdsByEntity.get(entityId);
  }

  private addDocuments(documents: readonly IndexDocument[]): void {
    if (documents.length === 0) return;
    // MiniSearch mutates the document objects during addAll; pass a copy.
    const docs: IndexDocument[] = documents.map((d) => ({ ...d }));
    this.index.addAll(docs);
    for (const doc of docs) {
      const set = this.entryIdsByEntity.get(doc.entity_id) ?? new Set<string>();
      set.add(doc.id);
      this.entryIdsByEntity.set(doc.entity_id, set);
      this.entityIdById.set(doc.id, doc.entity_id);
    }
  }

  private discardIds(ids: readonly string[]): void {
    for (const id of ids) {
      // `has()` is the membership test of record: a rebuild that failed
      // between its own discard pass and the set replacement can leave the
      // tracking set claiming ids the index no longer holds — discard()
      // throws on those, so guard with has().
      if (this.index.has(id)) this.index.discard(id);
      const entityId = this.entityIdById.get(id);
      if (entityId === undefined) continue;
      this.entryIdsByEntity.get(entityId)?.delete(id);
      this.entityIdById.delete(id);
    }
  }
}
