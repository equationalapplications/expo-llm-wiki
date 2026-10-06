import { EntryRepository } from '../repositories/EntryRepository';
import { cosineSimilarity } from '../utils/cosine';
import { parseEmbedding } from '../utils/embedding';
import { toIndexDoc } from '../utils/indexDoc';
import type {
  IndexSearchOptions,
  IndexSearchResult,
  IndexStrategy,
} from './search/IndexStrategy';

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

  private indexStrategy: IndexStrategy;
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

  /**
   * Per-entity count of markStale() calls. A rebuild clears an entity's stale
   * flag only when the count it snapshotted before its read still holds
   * afterwards: markStale() runs inside the host's still-open transaction, so
   * a call landing mid-read belongs to rows the read cannot have seen, and
   * its flag must outlive the turn (#233 review).
   */
  private staleEpochs = new Map<string, number>();

  constructor(
    private entryRepo: EntryRepository,
    indexStrategy: IndexStrategy,
  ) {
    this.indexStrategy = indexStrategy;
  }

  /**
   * Rebuilds the search index and clears the vector cache for a given entity.
   * A direct replacement for manually syncing state after a DB transaction.
   *
   * Rebuilds are serialized per instance and never reject: the keyword index
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
          const epochsBefore = new Map(this.staleEpochs);
          if (entityId === undefined) {
            // Global rebuild: read all live rows, replace the strategy's contents.
            const rows = await this.entryRepo.findMiniSearchRows();
            await this.indexStrategy.replaceAll(rows.map(toIndexDoc));
            for (const id of [...this.staleEntities]) {
              if ((this.staleEpochs.get(id) ?? 0) === (epochsBefore.get(id) ?? 0)) {
                this.staleEntities.delete(id);
              }
            }
          } else {
            await this.rebuildIndex(entityId);
            if ((this.staleEpochs.get(entityId) ?? 0) === (epochsBefore.get(entityId) ?? 0)) {
              this.staleEntities.delete(entityId);
            }
          }
          await this.indexStrategy.vacuum?.();
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
   * the index already tracks, and even then one that waits for rebuilds
   * already queued on the chain.
   */
  async syncEntries(entityId: string, ids: Iterable<string>): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    // The fast path requires an indexed entity, matching needsRebuild() below:
    // otherwise an empty id set on a never-indexed entity would skip the
    // full rebuild that registers it (#232 review finding).
    const indexed = this.indexStrategy.hasIndexedEntity?.(entityId);
    if (
      uniqueIds.length === 0 &&
      !this.staleEntities.has(entityId) &&
      indexed === true
    ) {
      // Nothing to do, but still wait for rebuilds already on the chain: the
      // sync(entityId) this call replaced awaited its own chained turn, so a
      // host that writes (and dedups down to nothing) while a forget() or
      // global sync() is mid-rebuild must not read a pre-rebuild index on
      // its next search.
      return this.syncChain;
    }

    const work = this.syncChain.then(async () => {
      try {
        try {
          const epochsBefore = new Map(this.staleEpochs);
          const needsRebuild = () =>
            this.staleEntities.has(entityId) ||
            this.indexStrategy.hasIndexedEntity?.(entityId) !== true;

          if (!needsRebuild()) {
            // Read before mutating, so a failed read leaves the index as it was.
            const rows = await this.entryRepo.findMiniSearchRowsByIds(entityId, uniqueIds);
            // Re-check: clearAll() or markStale() may have run during the read.
            if (!this.staleEntities.has(entityId)) {
              // The strategy scopes the discard by entityId, so we hand it
              // every id we touched; ids it never tracked are silently ignored.
              await this.indexStrategy.replace(entityId, uniqueIds, rows.map(toIndexDoc));
              await this.indexStrategy.vacuum?.();
              return;
            }
          }

          await this.rebuildIndex(entityId);
          // Clear only if no markStale() landed during the rebuild's read
          // (see staleEpochs) — one that did belongs to rows this rebuild's
          // read could not have seen.
          if ((this.staleEpochs.get(entityId) ?? 0) === (epochsBefore.get(entityId) ?? 0)) {
            this.staleEntities.delete(entityId);
          }
          await this.indexStrategy.vacuum?.();
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
    this.staleEpochs.set(entityId, (this.staleEpochs.get(entityId) ?? 0) + 1);
  }

  /**
   * Runs syncEntries(id, []) for each entity marked stale when this is called,
   * so only those entities are rebuilt. Each rebuild still takes its own turn
   * on the sync chain, and like syncEntries this never rejects. With nothing
   * stale it resolves at once, without waiting on work already on the chain.
   */
  async syncStale(): Promise<void> {
    const ids = [...this.staleEntities];
    await Promise.all(ids.map((id) => this.syncEntries(id, [])));
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
  async clearAll(): Promise<void> {
    this.vectorCache.clear();
    await this.indexStrategy.replaceAll([]);
    this.staleEntities.clear();
    this.staleEpochs.clear();
  }

  /**
   * Executes a keyword search against the active index strategy.
   */
  async searchKeyword(
    query: string,
    entityIds: string[],
    limit: number,
  ): Promise<IndexSearchResult[]> {
    const results = finiteResults(await this.indexStrategy.search(query, { entityIds, limit }));
    return results
      .sort((a, b) => this._compareSearchResults(a, b))
      .slice(0, limit);
  }

  /**
   * Pre-fetches keyword scores for candidate hydration, used during hybrid weighting.
   */
  async getKeywordScores(
    query: string,
    entityIds: string[],
    preFilterLimit?: number,
  ): Promise<Map<string, number>> {
    // When `preFilterLimit` is undefined (full-scan hybrid path), match the
    // pre-refactor behavior: do not impose a strategy-side cap. The original
    // `getMiniSearchScores` returned every keyword hit so `rankSemantic`'s
    // hybrid blend could weight every candidate; the PR-1 draft's
    // `?? 100` default capped at 100 and silently zeroed out keyword weight
    // for everything past rank 100 (CodeRabbit Minor #258).
    const opts: IndexSearchOptions = preFilterLimit !== undefined
      ? { entityIds, limit: preFilterLimit, preFilterLimit }
      : { entityIds, limit: Number.MAX_SAFE_INTEGER };
    const results = finiteResults(await this.indexStrategy.search(query, opts));
    if (results.length === 0) return new Map();
    // Pre-refactor scaling: a raw top score below 1 is left as-is rather
    // than inflated to 1, so a weak keyword match stays weak in the blend.
    const maxScore = Math.max(1, results[0]?.score ?? 1);
    return new Map(results.map((r) => [r.id, r.score / maxScore]));
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

  /**
   * Rebuild a single entity's index from scratch. Reads every row for
   * `entityId` from the repository (already filtered by `deleted_at IS NULL`)
   * and hands the lot to `indexStrategy.replaceEntity`, which owns the
   * drop-then-add bookkeeping so callers don't need to know the strategy's
   * id-tracking shape.
   */
  private async rebuildIndex(entityId: string): Promise<void> {
    const rows = await this.entryRepo.findMiniSearchRows(entityId);
    await this.indexStrategy.replaceEntity(entityId, rows.map(toIndexDoc));
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
   * The keyword index breaks equal-score ties by internal insertion order,
   * which syncEntries changes: a discarded-and-re-added id moves to the end.
   * Every caller truncates these results to a limit, so which ids survive a
   * tie at the boundary must not depend on write history. Re-sort exact
   * score ties by id — the same final tie-break _compareScoredRows applies.
   */
  private _compareSearchResults(a: IndexSearchResult, b: IndexSearchResult): number {
    const scoreDiff = b.score - a.score;
    if (!Number.isNaN(scoreDiff) && scoreDiff !== 0) return scoreDiff;
    return a.id.localeCompare(b.id);
  }
}

/**
 * The strategy contract requires finite scores; drop any that are not, so a
 * NaN or Infinity cannot become getKeywordScores' divisor or reach the
 * hybrid blend in rankSemantic.
 */
function finiteResults(results: IndexSearchResult[]): IndexSearchResult[] {
  return results.every((r) => Number.isFinite(r.score))
    ? results
    : results.filter((r) => Number.isFinite(r.score));
}
