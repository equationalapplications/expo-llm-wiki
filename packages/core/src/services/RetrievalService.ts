import type { SQLiteAdapter } from '../types';
import type { WikiOptions, MemoryBundle, WikiFact, ReadOptions } from '../types';
import { EntryRepository, EntryRowMetadata, EntryRowWithEmbeddings } from '../repositories/EntryRepository';
import type { TaskRepository } from '../repositories/TaskRepository';
import type { EventRepository } from '../repositories/EventRepository';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import type { SearchService } from './SearchService';
import { applyTierWeight, normalizeEntityIds, sanitizeTierWeights, shouldExposeReadMetadata } from '../readOptions';
import { sanitizeRankerError } from '../utils/pure';

type ReadCandidateRowMetadata = EntryRowMetadata;
type ReadCandidateRowWithEmbeddings = EntryRowWithEmbeddings;

export class RetrievalService {
  constructor(
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private taskRepo: TaskRepository,
    private eventRepo: EventRepository,
    private metadataRepo: MetadataRepository,
    private searchService: SearchService,
  ) {}

  async read(entityId: string | string[], query: string, options?: ReadOptions): Promise<MemoryBundle> {
    const config = this.options.config;
    const entityIds = normalizeEntityIds(entityId);
    const sanitizedTierWeights = shouldExposeReadMetadata(entityId)
      ? sanitizeTierWeights(entityIds, options?.tierWeights)
      : undefined;
    const exposeMetadata = shouldExposeReadMetadata(entityId);

    if (entityIds.length === 0) {
      const empty: MemoryBundle = { facts: [], tasks: [], events: [], edges: [] };
      if (exposeMetadata) {
        empty.metadata = { query, entityIds: [] };
        if (sanitizedTierWeights && Object.keys(sanitizedTierWeights).length > 0) empty.metadata.tierWeights = sanitizedTierWeights;
      }
      return empty;
    }

    const MAX_ENTITY_IDS = 100;
    if (entityIds.length > MAX_ENTITY_IDS) {
      throw new RangeError(`read() accepts at most ${MAX_ENTITY_IDS} entity IDs; received ${entityIds.length}`);
    }
    const nullByteId = entityIds.find(id => id.includes('\x00'));
    if (nullByteId !== undefined) {
      throw new TypeError(`entity_id values must not contain the null byte (\\x00); got "${nullByteId}"`);
    }

    const rawMaxResults = options?.maxResults ?? config?.maxResults ?? config?.maxFtsResults ?? 10;
    const maxResults = Number.isFinite(rawMaxResults)
      ? Math.max(0, Math.trunc(rawMaxResults))
      : 10;
    const rawPreFilterLimit =
      options?.preFilterLimit === null
        ? undefined
        : (options?.preFilterLimit ?? config?.preFilterLimit);
    const effectivePreFilterLimit =
      rawPreFilterLimit === undefined
        ? undefined
        : Number.isFinite(rawPreFilterLimit)
          ? Math.max(0, Math.trunc(rawPreFilterLimit))
          : undefined;
    const hybridWeight = options?.hybridWeight ?? config?.hybridWeight;
    const weight = hybridWeight !== undefined && !Number.isNaN(hybridWeight)
      ? Math.max(0, Math.min(1, hybridWeight))
      : undefined;
    const skipEmbed = weight === 0;
    const embedFn = this.options.llmProvider.embed;
    const trimmedQuery = query.trim();

    let facts: WikiFact[] = [];
    let scoreByFactId: Map<string, number> | undefined;

    if (maxResults === 0) {
      // Fast-path: a zero-capacity result window can never return any facts.
      // Skip embed(), DB scan, and sort — fall through to tasks/events fetch below.
    } else if (trimmedQuery) {
      let usedEmbed = false;
      const scoredEntityIds = this._filterScoredEntities(entityIds, sanitizedTierWeights, options?.includeZeroWeightEntities);

      // Fast-path: all entities zero-weight — skip embedFn, DB mismatch query, and
      // cosine work entirely. usedEmbed=true suppresses the keyword fallback below.
      if (scoredEntityIds.length === 0) {
        usedEmbed = true;
      } else if (!skipEmbed && embedFn) {
        let rankerShouldRethrow = false;
        let pendingRankerFallbackError: Error | undefined;
        try {
          const queryVec = await embedFn(trimmedQuery);

          // Validate that the provider returned a well-formed vector. An empty vector
          // would cause all facts to score 0 (silently bypassing the fallback), and
          // non-finite values (NaN, Infinity) make the sort comparator unstable.
          if (queryVec.length === 0 || !queryVec.every(v => typeof v === 'number' && isFinite(v))) {
            throw new Error(
              'embed() returned an empty or non-finite vector. Falling back to keyword search.'
            );
          }

          // Detect embedding dimension mismatch: if stored dimension differs from the
          // query vector, existing fact embeddings were built with a different model and
          // cosine scoring would silently produce misleading rankings. Fall back to
          // MiniSearch until the caller runs runReembed().
          const storedDimValue = await this.metadataRepo.getMeta('embedding_dimension');
          if (storedDimValue) {
            const storedDim = parseInt(storedDimValue, 10);
            if (storedDim !== queryVec.length) {
              throw new Error(
                `Embedding dimension mismatch: stored ${storedDim}, query has ${queryVec.length}. ` +
                `Call runReembed() to rebuild embeddings with the new model.`
              );
            }
          }

          // Check whether any non-deleted fact for any scored entity has a blob whose
          // dimension differs from the query vector. Uses scoredEntityIds so zero-weight
          // (skipped) entities with stale embeddings do not force keyword fallback.
          const mismatchedCount = await this.entryRepo.countDimensionMismatched(scoredEntityIds, queryVec.length);
          if (mismatchedCount > 0) {
            throw new Error(
              `Some facts have embeddings that do not match the current model dimension. ` +
              `Call runReembed() to rebuild all embeddings consistently.`
            );
          }

          const useRanker = Boolean(this.options.vectorRanker);
          let candidateRows: ReadCandidateRowMetadata[] | ReadCandidateRowWithEmbeddings[] | null; // null = pre-filter returned 0 results
          // Composite cache keys (multi-entity join strings) are never invalidated by write/reembed paths.
          let populateCache = entityIds.length === 1;
          let miniSearchScores: Map<string, number> | undefined;

          if (effectivePreFilterLimit !== undefined) {
            populateCache = false; // partial scan — do not populate cache
            const preResults = this.searchService.searchKeyword(trimmedQuery, scoredEntityIds, Number.MAX_SAFE_INTEGER);
            if (preResults.length === 0) {
              candidateRows = null; // empty pre-filter
            } else {
              const topKResults = preResults.slice(0, effectivePreFilterLimit);
              if (topKResults.length === 0) {
                // effectivePreFilterLimit is 0 — treat the same as no candidates
                // (avoids constructing an invalid "WHERE id IN ()" SQL clause)
                candidateRows = null;
              } else {
                const topKIds = topKResults.map(r => r.id);
                if (useRanker) {
                  candidateRows = await this.entryRepo.findMetadataByIds(topKIds);
                } else {
                  candidateRows = await this.entryRepo.findWithEmbeddingsByIds(topKIds);
                }
                if (weight !== undefined && weight < 1) {
                  const maxMsScore = Math.max(1, topKResults[0]?.score ?? 1);
                  miniSearchScores = new Map(topKResults.map(r => [r.id, r.score / maxMsScore]));
                }
              }
            }
          } else {
            // Full scan of scored entities
            // If vectorRanker is configured, skip embedding load for now (ranker will provide ranking)
            // Otherwise fetch embeddings for JS cosine ranking
            if (useRanker) {
              candidateRows = await this.entryRepo.findMetadataByEntityIds(scoredEntityIds);
            } else {
              candidateRows = await this.entryRepo.findWithEmbeddingsByEntityIds(scoredEntityIds);
            }
            // Collect MiniSearch scores for hybrid blend if weight is set and <1
            if (weight !== undefined && weight < 1) {
              miniSearchScores = this.searchService.getMiniSearchScores(trimmedQuery, scoredEntityIds);
            }
          }

          if (candidateRows === null) {
            // pre-filter returned 0 candidates — facts = [], skip phase 2, skip access tracking
            usedEmbed = true;
          } else {
            // Rank candidates: use vectorRanker if present, otherwise use JS cosine
            const entityCacheKey = entityIds.length === 1 ? entityIds[0] : entityIds.join('\x00');
            let scored: Array<{ id: string; entity_id: string; score: number; updated_at?: number | null; access_count?: number | null }>;

            if (useRanker) {
              // Build per-entity candidate maps so each ranker call receives one entityId.
              const candidateRowsByEntity = new Map<string, ReadCandidateRowMetadata[]>();
              for (const row of candidateRows as ReadCandidateRowMetadata[]) {
                const rows = candidateRowsByEntity.get(row.entity_id) ?? [];
                rows.push(row);
                candidateRowsByEntity.set(row.entity_id, rows);
              }

              try {
                const rankerResultsByEntity = await Promise.all(
                  scoredEntityIds.filter(id => (candidateRowsByEntity.get(id)?.length ?? 0) > 0).map(async scopedEntityId => {
                    const rowsForEntity = candidateRowsByEntity.get(scopedEntityId) ?? [];
                    const candidateIds = effectivePreFilterLimit !== undefined
                      ? rowsForEntity.map(row => row.id)
                      : undefined;
                    const ranked = await this._rankWithVectorRanker({
                      entityId: scopedEntityId,
                      queryVec,
                      candidateIds,
                      candidateRows: rowsForEntity,
                      weight,
                      miniSearchScores,
                      limit: Math.max(maxResults * 2, maxResults + 50),
                    });
                    return ranked.map(row => ({ ...row, entity_id: scopedEntityId }));
                  }),
                );

                scored = rankerResultsByEntity.flat();

                // Build metadata map only for IDs returned by the ranker (not all candidates)
                // to keep memory proportional to the oversampled result size on constrained runtimes.
                const scoredIds = new Set(scored.map(s => s.id));
                const metadataById = new Map(
                  (candidateRows as ReadCandidateRowMetadata[])
                    .filter(row => scoredIds.has(row.id))
                    .map(row => [row.id, row])
                );
                scored = scored.map(row => {
                  const metadata = metadataById.get(row.id);
                  return {
                    ...row,
                    updated_at: metadata?.updated_at ?? null,
                    access_count: metadata?.access_count ?? null,
                  };
                });

                // Backfill ranker-omitted rows per VectorRanker contract:
                // treat missing ids as "no embedding" (pure semantic: -2, hybrid: keyword-only)

                // Compute backfill budget up-front.
                // Hybrid mode: allow up to maxResults keyword-only rows to compete.
                // Pure semantic: only fill the remaining result slots.
                const isHybrid = weight !== undefined && weight < 1;
                const maxBackfill = isHybrid
                  ? maxResults
                  : Math.max(0, maxResults - scored.length);

                if (maxBackfill > 0) {
                  if (isHybrid) {
                    // Hybrid mode: prioritize by keyword score using O(N log K) top-K selection
                    // instead of O(N log N) full sort, since K (maxBackfill) is typically << N.
                    type CandidateRow = typeof candidateRows[number];
                    const topK: Array<{ row: CandidateRow; kwScore: number }> = [];

                    for (const row of candidateRows) {
                      if (scoredIds.has(row.id)) continue;
                      const kwScore = miniSearchScores?.get(row.id) ?? 0;
                      const candidate = { row, kwScore };

                      if (topK.length < maxBackfill) {
                        // Array not full yet - insert in sorted position (descending order)
                        let insertIdx = topK.length;
                        for (let i = 0; i < topK.length; i++) {
                          const cmp = this._compareScoredRows(
                            {
                              id: candidate.row.id,
                              score: candidate.kwScore,
                              updated_at: candidate.row.updated_at,
                              access_count: candidate.row.access_count,
                            },
                            {
                              id: topK[i].row.id,
                              score: topK[i].kwScore,
                              updated_at: topK[i].row.updated_at,
                              access_count: topK[i].row.access_count,
                            }
                          );
                          if (cmp < 0) {
                            insertIdx = i;
                            break;
                          }
                        }
                        topK.splice(insertIdx, 0, candidate);
                      } else {
                        const cmpWorst = this._compareScoredRows(
                          {
                            id: candidate.row.id,
                            score: candidate.kwScore,
                            updated_at: candidate.row.updated_at,
                            access_count: candidate.row.access_count,
                          },
                          {
                            id: topK[maxBackfill - 1].row.id,
                            score: topK[maxBackfill - 1].kwScore,
                            updated_at: topK[maxBackfill - 1].row.updated_at,
                            access_count: topK[maxBackfill - 1].row.access_count,
                          }
                        );
                        if (cmpWorst < 0) {
                          // Found better candidate than current worst - replace worst and re-insert
                          let insertIdx = maxBackfill - 1;
                          for (let i = 0; i < topK.length; i++) {
                            const cmp = this._compareScoredRows(
                              {
                                id: candidate.row.id,
                                score: candidate.kwScore,
                                updated_at: candidate.row.updated_at,
                                access_count: candidate.row.access_count,
                              },
                              {
                                id: topK[i].row.id,
                                score: topK[i].kwScore,
                                updated_at: topK[i].row.updated_at,
                                access_count: topK[i].row.access_count,
                              }
                            );
                            if (cmp < 0) {
                              insertIdx = i;
                              break;
                            }
                          }
                          topK.splice(insertIdx, 0, candidate);
                          topK.pop(); // Remove worst element
                        }
                      }
                    }

                    for (const { row, kwScore } of topK) {
                      scored.push({
                        id: row.id,
                        entity_id: row.entity_id,
                        score: (1 - weight) * kwScore,
                        updated_at: row.updated_at,
                        access_count: row.access_count,
                      });
                    }
                  } else {
                    // Pure semantic: all omitted rows share score -2.
                    // Tie-break omitted rows deterministically before truncating.
                    const omitted: Array<{ id: string; entity_id: string; score: number; updated_at: number | null; access_count: number | null }> = [];
                    for (const row of candidateRows) {
                      if (scoredIds.has(row.id)) continue;
                      omitted.push({ id: row.id, entity_id: row.entity_id, score: -2, updated_at: row.updated_at, access_count: row.access_count });
                    }
                    if (omitted.length > 0) {
                      this._tieBreakSort(omitted);
                      scored.push(...omitted.slice(0, maxBackfill));
                    }
                  }
                }
              } catch (rankerErr) {
                // `rankerErr instanceof Error` invokes the getPrototypeOf
                // trap on rankerErr. A hostile VectorRanker plugin could
                // return one whose trap rejects — treat as non-Error and
                // wrap in a synthetic Error so the fallback callback still
                // receives an Error instance.
                let isErrorLike = false;
                try {
                  isErrorLike = rankerErr instanceof Error;
                } catch {
                  // hostile Proxy — fall through
                }
                const rankerError = isErrorLike ? rankerErr : new Error(String(rankerErr));
                const policy = this.options.vectorRankerFallback ?? 'js-cosine';

                this.options.onVectorRankerFallback?.({
                  error: this._sanitizeRankerError(rankerError),
                  policy,
                });

                if (policy === 'throw') {
                  rankerShouldRethrow = true;
                  throw rankerError;
                } else if (policy === 'js-cosine') {
                  // If embeddings were skipped (vectorRanker was configured), fetch them now for fallback
                  let fallbackRows = candidateRows;
                  if (fallbackRows && fallbackRows.length > 0 && !('embedding_blob' in fallbackRows[0])) {
                    const rowIds = fallbackRows.map(r => r.id);
                    const embeddingRows = await this.entryRepo.findEmbeddingsByIds(rowIds);
                    const embeddingsMap = new Map(embeddingRows.map(row => [row.id, row]));
                    fallbackRows = fallbackRows.map(r => ({
                      ...r,
                      embedding_blob: embeddingsMap.get(r.id)?.embedding_blob ?? null,
                      embedding: embeddingsMap.get(r.id)?.embedding ?? null,
                    })) as ReadCandidateRowWithEmbeddings[];
                  }
                  scored = await this.searchService.rankSemantic({
                    entityId: entityCacheKey,
                    queryVec,
                    candidateRows: fallbackRows as ReadCandidateRowWithEmbeddings[],
                    weight,
                    miniSearchScores,
                    populateCache,
                    limit: fallbackRows.length,
                    skipSort: true, // read() re-sorts after applying tier weights
                  });
                } else if (policy === 'keyword') {
                  // Fall back to keyword-only results from MiniSearch
                  const keywordOversampledLimit = Math.max(maxResults * 2, maxResults + 50);
                  const topResults = this.searchService.searchKeyword(trimmedQuery, scoredEntityIds, keywordOversampledLimit);
                  const topResultIds = new Set(topResults.map(r => r.id));
                  const candidateMap = new Map(candidateRows.filter(r => topResultIds.has(r.id)).map(row => [row.id, row]));
                  scored = topResults.map(result => {
                    const metadata = candidateMap.get(result.id);
                    const entityForScore = metadata?.entity_id
                      ?? (result as unknown as { entity_id: string }).entity_id
                      ?? '';
                    return {
                      id: result.id,
                      entity_id: entityForScore,
                      score: result.score ?? 0,
                      access_count: metadata?.access_count ?? null,
                      updated_at: metadata?.updated_at ?? null,
                    };
                  });
                } else {
                  // policy === 'empty'
                  scored = [];
                }

                if (this.options.propagateRankerFailureToRetrievalFallback) {
                  const mirrored = new Error('Vector ranker failed, falling back', {
                    cause: this._sanitizeRankerError(rankerErr),
                  });
                  pendingRankerFallbackError = mirrored;
                }
              }
            } else {
              // Use in-process JS cosine similarity
              // At this point candidateRows must have embeddings (we fetched them because vectorRanker is not configured)
              // Materialize all candidates only when tier weights will actually change ranking —
              // i.e., at least one entity has a weight other than 1. A no-op weights object
              // (all values === 1, or empty after sanitization) preserves the hot-path behavior.
              const jsCosineNeedsTierSort = sanitizedTierWeights !== undefined &&
                Object.values(sanitizedTierWeights).some(w => w !== 1);
              scored = await this.searchService.rankSemantic({
                entityId: entityCacheKey,
                queryVec,
                candidateRows: candidateRows as ReadCandidateRowWithEmbeddings[],
                weight,
                miniSearchScores,
                populateCache,
                limit: jsCosineNeedsTierSort ? candidateRows.length : maxResults,
                skipSort: jsCosineNeedsTierSort, // read() re-sorts after applying tier weights
              });
            }

            if (scored.length > 0) {
              // Apply tier weights before global sort and slice
              scored = scored.map(row => ({
                ...row,
                score: applyTierWeight(row.score, row.entity_id, sanitizedTierWeights),
              }));

              // Re-apply tie-break sorting after tier-weight application (applies to all paths including
              // vectorRankerFallback='keyword': applyTierWeight mutates scores so MiniSearch ordering is no longer valid)
              this._tieBreakSort(scored);

              // Phase 2: fetch full rows only for the top results
              const selectedScored = scored.slice(0, maxResults);
              const topIds = selectedScored.map(s => s.id);

              // Capture scores for exposure in metadata
              if (exposeMetadata && trimmedQuery) {
                scoreByFactId = new Map(selectedScored.map(s => [s.id, Number.isFinite(s.score) ? s.score : 0]));
              }

              if (topIds.length > 0) {
                const facts2 = await this._hydrateFactsByIds(topIds, entityIds);

                // Hydration can return fewer rows than ranked IDs when rows were concurrently
                // soft-deleted or filtered by deleted_at before phase 2 hydration completes.
                if (facts2.length < topIds.length) {
                  const hydrationById = new Set(facts2.map(f => f.id));
                  const missingIds = topIds.filter(id => !hydrationById.has(id));
                  const missingCount = missingIds.length;
                  const sample = missingIds.slice(0, 5);
                  const sampleSuffix = sample.length > 0
                    ? ` Missing ID sample: ${sample.join(', ')}${missingIds.length > sample.length ? ', ...' : ''}.`
                    : '';
                  const error = new Error(
                    `Phase 2 fact hydration returned ${missingCount} fewer row(s) than ranked IDs. ` +
                    `Rows may have been concurrently soft-deleted or filtered by deleted_at during hydration, ` +
                    `or vector ranker output may include IDs that do not exist in requested entities.` +
                    sampleSuffix
                  );
                  this.options.onRetrievalFallback?.(error);
                }
                facts = facts2;
              }
              // Ranker path completed — notify of any prior fallback now that hydration is done.
              // Fires outside the topIds.length>0 guard since scored.length>0 && maxResults>0
              // means topIds is always non-empty here, but the notification is harmless either way.
              if (pendingRankerFallbackError) {
                this.options.onRetrievalFallback?.(pendingRankerFallbackError);
                pendingRankerFallbackError = undefined;
              }
              usedEmbed = true;
            } else {
              // Empty scored results (ranker returned no matches)
              if (pendingRankerFallbackError) {
                this.options.onRetrievalFallback?.(pendingRankerFallbackError);
                pendingRankerFallbackError = undefined;
              }
              usedEmbed = true;
            }
          } // closes the candidateRows !== null else block
        } catch (err) {
          // `err instanceof Error` invokes the getPrototypeOf trap on err.
          // A hostile Proxy (e.g. from a VectorRanker plugin or a wrapped
          // inner-call result) whose trap rejects must not throw out of
          // this catch — it would tear down the entire retrieval operation.
          let isErrorLike = false;
          try {
            isErrorLike = err instanceof Error;
          } catch {
            // hostile Proxy — fall through
          }
          // Narrowed view: only valid when `isErrorLike` is true (guaranteed
          // by the try/catch above). Cast captures that runtime invariant
          // for the typechecker; the runtime is already proven correct.
          const error = isErrorLike ? (err as Error) : new Error(String(err));
          if (rankerShouldRethrow) {
            throw error;
          }
          // If Phase 2 failed and there's a pending ranker error, include it as cause
          if (pendingRankerFallbackError) {
            (error as any).cause = pendingRankerFallbackError;
            pendingRankerFallbackError = undefined;
          }
          // Always notify of Phase 2 errors (ranker error attached as cause if present)
          this.options.onRetrievalFallback?.(error);
        }
      }

      if (!usedEmbed && scoredEntityIds.length > 0) {
        // embed absent or threw — fall back to MiniSearch with tier weight application
        const fallbackOversampledLimit = Math.max(maxResults * 2, maxResults + 50);
        const results = this.searchService.searchKeyword(trimmedQuery, scoredEntityIds, fallbackOversampledLimit);
        const candidates = results.map(r => ({
          id: r.id as string,
          entity_id: (r as unknown as { entity_id: string }).entity_id,
          score: applyTierWeight(r.score ?? 0, (r as unknown as { entity_id: string }).entity_id, sanitizedTierWeights),
          updated_at: null as number | null,
          access_count: null as number | null,
        }));
        this._tieBreakSort(candidates);
        const topCandidates = candidates.slice(0, maxResults);
        const topIds = topCandidates.map(c => c.id);
        if (topIds.length > 0) {
          facts = await this._hydrateFactsByIds(topIds, entityIds);
          if (exposeMetadata) {
            scoreByFactId = new Map(topCandidates.map(c => [c.id, Number.isFinite(c.score) ? c.score : 0]));
          }
        }
      }

      if (facts.length > 0) {
        const ids = facts.map(f => f.id);
        const now = Date.now();
        await this.entryRepo.trackAccess(ids, now);
      }
    } else {
      // Empty query: use global recency ordering, ignore tier weights.
      facts = await this.entryRepo.findRecentByEntityIds(entityIds, maxResults);
    }

    const eventsLimit = Math.min(10 * entityIds.length, 100);
    const [tasks, events] = await Promise.all([
      this.taskRepo.findAllPending(entityIds as string[], entityIds.length === 1 ? undefined : Math.min(20 * entityIds.length, 200)),
      entityIds.length === 1
        ? this.eventRepo.getRecent(entityIds[0], eventsLimit)
        : this.eventRepo.getRecentForEntities(entityIds as string[], eventsLimit),
    ]);

    // Build factScores from captured scores
    let factScores: Record<string, number> | undefined;
    if (exposeMetadata && trimmedQuery && scoreByFactId) {
      factScores = Object.fromEntries(facts.map(fact => [fact.id, scoreByFactId!.get(fact.id) ?? 0]));
    }

    const bundle: MemoryBundle = { facts, tasks, events: events.reverse(), edges: [] };

    if (exposeMetadata) {
      bundle.metadata = { query, entityIds };
      if (sanitizedTierWeights && Object.keys(sanitizedTierWeights).length > 0) bundle.metadata.tierWeights = sanitizedTierWeights;
      if (factScores && Object.keys(factScores).length > 0) bundle.factScores = factScores;
    }

    return bundle;
  }

  /**
   * Returns entity IDs that will participate in scored retrieval.
   * Excludes zero-weight entities unless includeZeroWeightEntities is true.
   */
  private _filterScoredEntities(
    entityIds: readonly string[],
    sanitizedTierWeights: Record<string, number> | undefined,
    includeZeroWeightEntities?: boolean,
  ): string[] {
    return entityIds.filter(id => {
      const w = sanitizedTierWeights?.[id] ?? 1;
      return includeZeroWeightEntities === true || w !== 0;
    });
  }

  /**
   * Stable tie-break sort: score desc → access_count desc → updated_at desc → id asc.
   */
  private _tieBreakSort<T extends { id: string; score: number; updated_at?: number | null; access_count?: number | null }>(items: T[]): void {
    items.sort((a, b) => this._compareScoredRows(a, b));
  }

  /**
   * Comparator for score + deterministic tie-break fields.
   * Negative return means "a ranks ahead of b" for descending score order.
   */
  private _compareScoredRows(
    a: { id: string; score: number; updated_at?: number | null; access_count?: number | null },
    b: { id: string; score: number; updated_at?: number | null; access_count?: number | null },
  ): number {
    const scoreDiff = b.score - a.score;
    // isNaN guard: -Infinity - (-Infinity) = NaN; fall through to tie-break
    if (!Number.isNaN(scoreDiff) && scoreDiff !== 0) return scoreDiff;
    const accessCountDiff = (b.access_count ?? 0) - (a.access_count ?? 0);
    if (accessCountDiff !== 0) return accessCountDiff;
    const updatedAtDiff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
    if (updatedAtDiff !== 0) return updatedAtDiff;
    return a.id.localeCompare(b.id);
  }

  /**
   * Hydrate full facts by ID. Pass scopedEntityIds to restrict to requested namespaces in SQL
   * (defense-in-depth against a rogue VectorRanker returning cross-entity IDs).
   */
  private async _hydrateFactsByIds(ids: readonly string[], scopedEntityIds?: readonly string[], tx?: SQLiteAdapter): Promise<WikiFact[]> {
    return this.entryRepo.findByIds(ids, scopedEntityIds, tx);
  }

  private _sanitizeRankerError(err: unknown): Error {
    return sanitizeRankerError(err, this.options.sanitizeRankerErrors);
  }

  /**
   * Delegate semantic ranking to the injected VectorRanker.
   * Caller should pass an oversampledLimit to preserve recall after re-ranking.
   * Returns scored results ready for hybrid blending and tie-break sorting.
   */
  private async _rankWithVectorRanker(args: {
    entityId: string;
    queryVec: Float32Array | number[];
    candidateIds: readonly string[] | undefined;
    candidateRows: ReadCandidateRowMetadata[];
    weight: number | undefined;
    miniSearchScores: Map<string, number> | undefined;
    limit: number;
  }): Promise<Array<{ id: string; entity_id: string; score: number }>> {
    const { entityId, candidateIds, candidateRows, weight, miniSearchScores, limit } = args;

    const ranker = this.options.vectorRanker;
    if (!ranker) {
      throw new Error('vectorRanker not configured');
    }

    const queryVecCopy = args.queryVec instanceof Float32Array
      ? args.queryVec.slice()
      : Array.from(args.queryVec);

    const rankerResults = await ranker.rankBySimilarity({
      entityId,
      queryVec: queryVecCopy,
      candidateIds,
      limit,
    });

    // Normalize ranker output: filter to allowed ids, drop non-finite scores, deduplicate
    // Stop collecting once limit valid results are found to protect against huge result sets
    const allowedIds = new Set(candidateRows.map(row => row.id));
    const seen = new Set<string>();
    const normalized: typeof rankerResults = [];

    for (const r of rankerResults) {
      if (normalized.length >= limit) break; // Early termination once limit reached
      if (seen.has(r.id)) continue;
      if (allowedIds && !allowedIds.has(r.id)) continue;
      if (!Number.isFinite(r.semanticScore)) continue;
      seen.add(r.id);
      normalized.push(r);
    }

    const entityIdByCandidateId = new Map(candidateRows.map(row => [row.id, row.entity_id]));

    // Convert ranker results to scored format, applying hybrid blending if weight is set
    const scored = normalized.map(r => {
      let score = r.semanticScore;
      if (weight !== undefined) {
        // Hybrid blending: floor semantic score at 0 for predictable weighted sum (no upper clamp)
        const kwScore = miniSearchScores?.get(r.id) ?? 0;
        score = weight * Math.max(0, r.semanticScore) + (1 - weight) * kwScore;
      }
      return {
        id: r.id,
        entity_id: entityIdByCandidateId.get(r.id)!, // allowedIds filter above guarantees membership
        score,
      };
    });

    // Caller handles backfill, metadata attachment, tie-break sorting, and final slice
    return scored;
  }
}
