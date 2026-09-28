import MiniSearch, { SearchResult } from 'minisearch';
import { EntryRepository } from '../repositories/EntryRepository';
import { cosineSimilarity } from '../utils/cosine';
import { parseEmbedding } from '../utils/embedding';

export interface ScoredRow {
  id: string;
  entity_id: string;
  score: number;
  updated_at: number | null;
  access_count: number | null;
}

export interface RankSemanticArgs {
  entityId: string;
  queryVec: Float32Array | number[];
  candidateRows: Array<{
    id: string;
    entity_id: string;
    embedding_blob: Uint8Array | null;
    embedding: string | null;
    updated_at: number | null;
    access_count: number | null;
  }>;
  weight: number | undefined;
  miniSearchScores: Map<string, number> | undefined;
  populateCache: boolean;
  limit: number;
  skipSort?: boolean;
}

export class SearchService {
  /**
   * Maximum number of entities whose parsed embedding vectors are held in
   * memory. This cap is intentionally conservative so the cache remains safe
   * on memory-constrained runtimes (e.g., mobile/Expo).
   */
  private static readonly MAX_VECTOR_CACHE_ENTITIES = 16;

  /**
   * Maximum number of fact vectors cached per entity. Keep this high enough to
   * preserve the parsed-embedding reuse optimization for common mid-sized
   * entities while still maintaining a bounded memory footprint.
   */
  private static readonly MAX_VECTOR_CACHE_FACTS_PER_ENTITY = 500;

  private miniSearch: MiniSearch<{ id: string; entity_id: string; title: string; body: string; tags: string }>;
  private miniSearchEntryIdsByEntity = new Map<string, Set<string>>();
  private vectorCache: Map<string, Map<string, Float32Array>> = new Map();

  /**
   * Serializes rebuilds. `rebuildIndex` awaits a repository read between
   * snapshotting the previous id set and discarding it, so two concurrent
   * sync() calls for one entity can interleave: a slow, stale read lands last
   * and discards documents the fresh read just added. Chaining also keeps
   * discard()/addAll() out of each other's way, which is what accrued the
   * auto-vacuum debt behind the TypeError in #64.
   */
  private syncChain: Promise<void> = Promise.resolve();

  /**
   * Entities whose index may have drifted from SQLite: an incremental update
   * failed part-way, or core wrote rows it could not index (upsertGraph runs in
   * the host's transaction). Their next syncEntries rebuilds the entity in full.
   * See spec 2026-09-28 §5.
   */
  private staleEntities = new Set<string>();

  constructor(private entryRepo: EntryRepository) {
    this.miniSearch = this.createMiniSearch();
  }

  /**
   * A fresh index with the production options. clearAll() swaps one in because
   * MiniSearch.removeAll() empties the index but leaves dirtCount (and its
   * vacuum bookkeeping) at its old value, which would trip syncEntries'
   * conditional vacuum early after a clear.
   */
  private createMiniSearch() {
    return new MiniSearch({
      fields: ['title', 'body', 'tags'],
      storeFields: ['entity_id'],
      // Vacuuming is driven explicitly at the end of each serialized rebuild
      // (see sync). Auto-vacuum fires on its own schedule, asynchronously with
      // respect to the caller, and traversing the tree mid-rebuild is what
      // threw the uncaught TypeError in MiniSearch.performVacuuming (#64).
      autoVacuum: false,
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  /**
   * Rebuilds the search index and clears the vector cache for a given entity.
   * A direct replacement for manually syncing state after a DB transaction.
   *
   * Rebuilds are serialized per instance and never reject: the MiniSearch index
   * is a rebuildable cache over SQLite, so degraded keyword search is the
   * correct failure mode and killing the host process is not.
   */
  async sync(entityId?: string): Promise<void> {
    const work = this.syncChain.then(async () => {
      try {
        // evictCache is inside the guard, not after it: a throw escaping here
        // would reject `work`, and since the next sync() chains off `work`,
        // every later rebuild would reject too — the poisoned-chain form of
        // exactly the unhandled rejection this method exists to prevent. The
        // inner finally keeps eviction unconditional, as it was before.
        try {
          await this.rebuildIndex(entityId);
          if (entityId) this.staleEntities.delete(entityId);
          else this.staleEntities.clear();
          await this.miniSearch.vacuum();
        } finally {
          this.evictCache(entityId);
        }
      } catch (err) {
        console.warn(`[WikiMemory] search index rebuild failed for ${entityId ?? '*'}:`, err);
      }
    });
    this.syncChain = work;
    return work;
  }

  /**
   * Re-indexes only `ids` for `entityId`: drops each from the index, then
   * re-adds the ones still live in SQLite, so soft-deleted or missing ids end
   * up absent. Costs O(ids), where sync(entityId) costs O(entity) — callers that
   * know what a write touched use this so chunked imports stay linear (#232).
   *
   * Serialized with sync() on the same chain and, like it, never rejects. An
   * entity that is stale or has never been indexed gets a full rebuild instead
   * — including on an empty `ids` list, which is a no-op only for an entity
   * the index already tracks.
   */
  async syncEntries(entityId: string, ids: Iterable<string>): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    // The fast path requires a tracked entity, matching needsRebuild() below:
    // otherwise an empty id set on a never-indexed entity would skip the
    // full rebuild that registers it (#232 review finding).
    if (
      uniqueIds.length === 0 &&
      !this.staleEntities.has(entityId) &&
      this.miniSearchEntryIdsByEntity.has(entityId)
    ) {
      return;
    }

    const work = this.syncChain.then(async () => {
      try {
        try {
          const needsRebuild = () =>
            this.staleEntities.has(entityId) || !this.miniSearchEntryIdsByEntity.has(entityId);

          if (!needsRebuild()) {
            // Read before mutating, so a failed read leaves the index as it was.
            const rows = await this.entryRepo.findMiniSearchRowsByIds(entityId, uniqueIds);
            // Re-check: clearAll() or markStale() may have run during the read.
            const tracked = this.miniSearchEntryIdsByEntity.get(entityId);
            if (tracked && !this.staleEntities.has(entityId)) {
              // No await from here to addAll: the index never shows a half-applied
              // update. Only ids tracked under this entity are discarded — each is
              // in the index, so discard() cannot throw, and other entities'
              // documents are never touched.
              for (const id of uniqueIds) {
                if (tracked.delete(id)) this.miniSearch.discard(id);
              }
              const documents = rows.map((row) => this.normalizeMiniSearchRow(row));
              if (documents.length > 0) this.miniSearch.addAll(documents);
              for (const document of documents) tracked.add(document.id);

              // A turn that discarded must vacuum before returning: in
              // minisearch 7.2.0, a single un-vacuumed discard inverts the
              // relative scores of term-sharing documents — ids indexed before
              // the discarded one drop below ids indexed after, at any index
              // size — silently reordering truncated search results. The
              // vacuum is O(index), but only discard-bearing turns pay it:
              // add-only turns (chunked merge imports) accrue no dirt and
              // never vacuum, which is where #232's win lives.
              if (this.miniSearch.dirtCount > 0) {
                await this.miniSearch.vacuum();
              }
              return;
            }
          }

          await this.rebuildIndex(entityId);
          this.staleEntities.delete(entityId);
          await this.miniSearch.vacuum();
        } finally {
          this.evictCache(entityId);
        }
      } catch (err) {
        this.staleEntities.add(entityId);
        console.warn(`[WikiMemory] search index incremental sync failed for ${entityId}:`, err);
      }
    });
    this.syncChain = work;
    return work;
  }

  /**
   * Forces the entity's next syncEntries to rebuild it in full. For writes core
   * cannot index itself, such as upsertGraph inside a host transaction.
   */
  markStale(entityId: string): void {
    this.staleEntities.add(entityId);
  }

  /**
   * Clears the parsed vector cache. Useful for mid-loop flush guarantees
   * or memory pressure evictions.
   */
  evictCache(entityId?: string): void {
    if (entityId) {
      this.vectorCache.delete(entityId);
    } else {
      this.vectorCache.clear();
    }
  }

  /**
   * Fully resets the search service.
   */
  clearAll(): void {
    this.vectorCache.clear();
    // A fresh instance, not removeAll(): that empties the index but keeps
    // dirtCount and vacuum bookkeeping (minisearch 7.2.0).
    this.miniSearch = this.createMiniSearch();
    this.miniSearchEntryIdsByEntity.clear();
    this.staleEntities.clear();
  }

  /**
   * Executes a keyword search against the active MiniSearch index.
   */
  searchKeyword(query: string, entityIds: string[], limit: number): SearchResult[] {
    const entityIdSet = new Set(entityIds);
    const results = this.miniSearch.search(query, {
      filter: (r) => entityIdSet.has(r.entity_id as string),
      combineWith: 'OR',
    });
    return results.sort((a, b) => this._compareSearchResults(a, b)).slice(0, limit);
  }

  /**
   * Pre-fetches MiniSearch scores for candidate hydration, used during hybrid weighting.
   */
  getMiniSearchScores(query: string, entityIds: string[], preFilterLimit?: number): Map<string, number> {
    const entityIdSet = new Set(entityIds);
    let results = this.miniSearch.search(query, {
      filter: (r) => entityIdSet.has(r.entity_id as string),
      combineWith: 'OR',
    }).sort((a, b) => this._compareSearchResults(a, b));

    if (preFilterLimit !== undefined) {
      results = results.slice(0, preFilterLimit);
    }

    if (results.length === 0) return new Map();

    const maxMsScore = Math.max(1, results[0]?.score ?? 1);
    return new Map(results.map((r) => [r.id, r.score / maxMsScore]));
  }

  /**
   * Score candidate rows using in-process JS cosine similarity.
   * Applies hybrid blending (if weight set) and tie-break sorting before returning.
   */
  async rankSemantic(args: RankSemanticArgs): Promise<ScoredRow[]> {
    const queryVec = args.queryVec instanceof Float32Array ? args.queryVec.slice() : Array.from(args.queryVec);
    const { entityId, candidateRows, weight, miniSearchScores, populateCache, limit, skipSort } = args;

    let entityCache = this.vectorCache.get(entityId);
    const tooLarge = populateCache && candidateRows.length > SearchService.MAX_VECTOR_CACHE_FACTS_PER_ENTITY;

    if (tooLarge && entityCache) {
      this.vectorCache.delete(entityId);
      entityCache = undefined;
    }

    const canCache = populateCache && !tooLarge;
    if (canCache && !entityCache) {
      entityCache = new Map<string, Float32Array>();
    }

    const scored = candidateRows.map((row) => {
      let vector = entityCache?.get(row.id) ?? parseEmbedding(row.embedding_blob, row.embedding);

      if (vector && canCache && entityCache && !entityCache.has(row.id)) {
        entityCache.set(row.id, vector);
      }

      let score = 0;
      if (vector && vector.length === queryVec.length) {
        const cosSim = cosineSimilarity(queryVec, vector);
        if (weight !== undefined) {
          const kwScore = miniSearchScores?.get(row.id) ?? 0;
          score = weight * Math.max(0, cosSim) + (1 - weight) * kwScore;
        } else {
          score = cosSim;
        }
      } else if (weight !== undefined && weight < 1) {
        const kwScore = miniSearchScores?.get(row.id) ?? 0;
        score = (1 - weight) * kwScore;
      } else {
        score = -2;
      }

      return {
        id: row.id,
        entity_id: row.entity_id,
        score,
        updated_at: row.updated_at,
        access_count: row.access_count,
      };
    });

    if (canCache && entityCache && entityCache.size > 0) {
      if (!this.vectorCache.has(entityId)) {
        if (this.vectorCache.size >= SearchService.MAX_VECTOR_CACHE_ENTITIES) {
          const oldestKey = this.vectorCache.keys().next().value as string | undefined;
          if (oldestKey !== undefined) this.vectorCache.delete(oldestKey);
        }
        this.vectorCache.set(entityId, entityCache);
      }
    }

    if (!skipSort) {
      this._tieBreakSort(scored);
    }

    return scored.slice(0, limit);
  }

  // --- Internal Index Management ---

  private async rebuildIndex(entityId?: string): Promise<void> {
    if (entityId) {
      const rows = await this.entryRepo.findMiniSearchRows(entityId);
      const previousIds = this.miniSearchEntryIdsByEntity.get(entityId);

      if (previousIds) {
        for (const id of previousIds) {
          this.miniSearch.discard(id);
        }
      }

      const documents = rows.map((row) => this.normalizeMiniSearchRow(row));
      if (documents.length > 0) {
        this.miniSearch.addAll(documents);
      }

      this.miniSearchEntryIdsByEntity.set(
        entityId,
        new Set(documents.map((document) => document.id))
      );
      return;
    }

    const rows = await this.entryRepo.findMiniSearchRows();
    this.miniSearch.removeAll();
    this.miniSearchEntryIdsByEntity.clear();

    const documents = rows.map((row) => this.normalizeMiniSearchRow(row));
    if (documents.length > 0) {
      this.miniSearch.addAll(documents);
    }

    for (const document of documents) {
      const ids = this.miniSearchEntryIdsByEntity.get(document.entity_id) ?? new Set<string>();
      ids.add(document.id);
      this.miniSearchEntryIdsByEntity.set(document.entity_id, ids);
    }
  }

  private normalizeMiniSearchRow(row: {
    id: string;
    entity_id: string;
    title: string;
    body: string;
    tags: string;
  }): { id: string; entity_id: string; title: string; body: string; tags: string } {
    return {
      id: row.id,
      entity_id: row.entity_id,
      title: row.title,
      body: row.body,
      tags: (() => {
        try {
          const parsed = JSON.parse(row.tags);
          return Array.isArray(parsed) ? parsed.join(' ') : row.tags;
        } catch {
          return row.tags;
        }
      })(),
    };
  }

  private _tieBreakSort(items: ScoredRow[]): void {
    items.sort((a, b) => this._compareScoredRows(a, b));
  }

  private _compareScoredRows(a: ScoredRow, b: ScoredRow): number {
    const scoreDiff = b.score - a.score;
    if (!Number.isNaN(scoreDiff) && scoreDiff !== 0) return scoreDiff;

    const accessCountDiff = (b.access_count ?? 0) - (a.access_count ?? 0);
    if (accessCountDiff !== 0) return accessCountDiff;

    const updatedAtDiff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
    if (updatedAtDiff !== 0) return updatedAtDiff;

    return a.id.localeCompare(b.id);
  }

  /**
   * MiniSearch breaks equal-score ties by internal insertion order, which
   * syncEntries changes: a discarded-and-re-added id moves to the end. Every
   * caller truncates these results to a limit, so which ids survive a tie at
   * the boundary must not depend on write history. Re-sort exact score ties
   * by id — the same final tie-break _compareScoredRows applies.
   */
  private _compareSearchResults(a: SearchResult, b: SearchResult): number {
    const scoreDiff = b.score - a.score;
    if (!Number.isNaN(scoreDiff) && scoreDiff !== 0) return scoreDiff;
    return a.id.localeCompare(b.id);
  }
}
