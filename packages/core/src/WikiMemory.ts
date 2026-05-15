import type { SQLiteAdapter } from './types';
import { setupDatabase } from './db/schema';
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from './db/migrations';
import { WikiOptions, MemoryBundle, MemoryDump, WikiEvent, WikiFact, WikiBusyError, PrunePartialFailureError, EntityStatus, ReadOptions } from './types';
import { EntryRepository, EntryRowMetadata, EntryRowWithEmbeddings } from './repositories/EntryRepository';
import { OutboxRepository } from './repositories/OutboxRepository';
import { TaskRepository } from './repositories/TaskRepository';
import { EventRepository } from './repositories/EventRepository';
import { MetadataRepository } from './repositories/MetadataRepository';
import { SearchService } from './services/SearchService';
import { JobManager } from './services/JobManager';
import { generateId } from './utils/ids';
import { applyTierWeight, normalizeEntityIds, sanitizeTierWeights, shouldExposeReadMetadata } from './readOptions';
import { chunkText, clip, validateFact, validateTask, normalizeSourceRef, normalizeSourceHash } from './utils/pure';
import { IngestionService } from './services/IngestionService';
import { MaintenanceService } from './services/MaintenanceService';

export { WikiBusyError, PrunePartialFailureError, HOOK_TIMEOUT_MARKER } from './types';
import { HOOK_TIMEOUT_MARKER } from './types';

type ReadCandidateRowMetadata = EntryRowMetadata;
type ReadCandidateRowWithEmbeddings = EntryRowWithEmbeddings;

export class WikiMemory {
  private db: SQLiteAdapter;
  private prefix: string;
  private options: WikiOptions;
  private entryRepo: EntryRepository;
  private outboxRepo: OutboxRepository;
  private taskRepo: TaskRepository;
  private eventRepo: EventRepository;
  private metadataRepo: MetadataRepository;
  private searchService: SearchService;
  private jobManager: JobManager;
  private ingestionService: IngestionService;
  private maintenanceService: MaintenanceService;

  private async storeEmbeddingDimension(dim: number): Promise<void> {
    const existing = await this.metadataRepo.getMeta('embedding_dimension');
    if (existing) {
      const storedDim = parseInt(existing, 10);
      if (storedDim !== dim) {
        console.warn(
          `[WikiMemory] Embedding dimension mismatch: stored ${storedDim}, got ${dim}. ` +
          `Call runReembed() to rebuild embeddings with the new model.`
        );
        await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(dim), this.db);
      }
      // Do NOT clear 'embedding_dimension_mismatch' here: other facts may still hold
      // old-dimension blobs written during a previous model. Only _reconcileEmbeddingDimension()
      // (called after a full runReembed) may clear the flag once it confirms all stored
      // blobs match the new canonical dimension.
    } else {
      await this.metadataRepo.setMeta('embedding_dimension', String(dim), this.db);
    }
  }

  /**
   * After a successful runReembed(), promote the pending `embedding_dimension_mismatch`
   * value to the canonical `embedding_dimension` key and clear the mismatch flag.
   * This ensures future read() calls use embedding-based retrieval rather than staying
   * stuck on the MiniSearch fallback.
   */
  private async _reconcileEmbeddingDimension(): Promise<void> {
    const mismatchValue = await this.metadataRepo.getMeta('embedding_dimension_mismatch');
    if (!mismatchValue) return;

    const newDim = parseInt(mismatchValue, 10);
    // Check whether any non-deleted fact still stores a blob with a different byte
    // length. If so, those facts haven't been re-embedded yet and the mismatch flag
    // must stay in place so read() keeps falling back to MiniSearch for them.
    // A row blocks mismatch-flag removal if:
    //   (a) it has a BLOB whose dimension differs from the new model, OR
    //   (b) it has only a TEXT vector (embedding_blob IS NULL) — TEXT rows were
    //       written by an older model and must be converted by runReembed() before
    //       they are safe to score against the new query dimension.
    const residualCount = await this.entryRepo.countStaleEmbeddings(newDim);
    // Only promote and clear once every stored vector uses the new dimension.
    // Promoting before all rows are converted would leave read() in an inconsistent
    // state: the canonical dim would point at the new model while TEXT-only or
    // wrong-dim blobs still exist, causing those rows to score silently as 0.
    if (residualCount === 0) {
      await this.metadataRepo.setMeta('embedding_dimension', mismatchValue, this.db);
      await this.metadataRepo.clearDimensionMismatch(this.db);
    }
  }

  private async embedFact(fact: { id: string; entity_id: string; title: string; body: string; tags: string | string[] }): Promise<boolean> {
    const embedFn = this.options.llmProvider.embed;
    if (!embedFn) return false;
    let tagsStr: string;
    if (Array.isArray(fact.tags)) {
      tagsStr = fact.tags.join(' ');
    } else {
      try {
        const parsed = JSON.parse(fact.tags);
        tagsStr = Array.isArray(parsed) ? parsed.join(' ') : fact.tags;
      } catch {
        tagsStr = fact.tags;
      }
    }
    const text = `${fact.title} ${fact.body} ${tagsStr}`.trim();
    try {
      const vector = await embedFn(text);
      // Validate before persisting: an empty or non-finite vector would poison
      // embedding_dimension and write unusable data to embedding_blob.
      if (vector.length === 0 || !vector.every(v => typeof v === 'number' && isFinite(v))) {
        console.warn(`[WikiMemory] embedFact: embed() returned an invalid vector for ${fact.id}; skipping.`);
        return false;
      }
      const float32Vector = new Float32Array(vector);
      let hasNonFinite = false;
      for (let i = 0; i < float32Vector.length; i++) {
        if (!isFinite(float32Vector[i])) { hasNonFinite = true; break; }
      }
      if (hasNonFinite) {
        console.warn(`[WikiMemory] embedFact: embed() returned values that overflow float32 for ${fact.id}; skipping.`);
        return false;
      }
      await this.storeEmbeddingDimension(float32Vector.length);
      const blob = new Uint8Array(float32Vector.buffer);
      await this.entryRepo.updateEmbeddingBlob(fact.id, blob);
      // Isolate hook failure: embedding was persisted successfully even if external index sync fails
      try {
        await this._notifyEmbeddingPersisted(fact.entity_id, fact.id, float32Vector);
      } catch (hookErr) {
        console.warn(`[WikiMemory] onEmbeddingPersisted hook failed for ${fact.id}:`, hookErr);
      }
      return true;
    } catch (err) {
      console.warn(`[WikiMemory] embedFact failed for ${fact.id}:`, err);
      return false;
    }
  }

  private _warnCrossEntityCollision(type: 'entry' | 'task', id: string, existingEntityId: string, targetEntityId: string): void {
    console.warn(`[WikiMemory] importDump: ${type} id "${id}" already belongs to entity "${existingEntityId}"; skipping for entity "${targetEntityId}"`);
  }

  /** Maps pre-rename enum strings from older dumps to current source_type values. */
  private _normalizeImportedSourceType(
    raw: string,
    ctx?: { entityId: string; factId: string },
  ): WikiFact['source_type'] {
    if (raw === 'user_document') return 'immutable_document';
    if (raw === 'agent_inferred') return 'librarian_inferred';
    const allowed: WikiFact['source_type'][] = ['user_stated', 'librarian_inferred', 'user_confirmed', 'immutable_document'];
    if ((allowed as string[]).includes(raw)) return raw as WikiFact['source_type'];
    const where =
      ctx !== undefined ? ` for entity "${ctx.entityId}" fact "${ctx.factId}"` : '';
    throw new Error(
      `importDump: invalid source_type "${raw}"${where} (expected one of: ${allowed.join(', ')}, or legacy aliases user_document / agent_inferred)`
    );
  }

  private async assertNoLegacySourceTypes(): Promise<void> {
    if (!(await this.entryRepo.hasLegacySourceTypes())) return;

    const count = await this.entryRepo.countLegacySourceTypes();
    throw new Error(
      `Database contains ${count} entries with legacy source_type values ('user_document' or 'agent_inferred'). ` +
      `These enum values were renamed in this release. Running without migration would allow legacy 'user_document' facts to bypass ` +
      `immutability guards, causing data corruption.\n\n${this.entryRepo.getLegacyMigrationSQL()}\n\n` +
      `After running the migration SQL, restart your application.`
    );
  }

  private async _notifyEmbeddingPersisted(
    entityId: string,
    factId: string,
    vector: Float32Array | null,
  ): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
    // Defensive copy prevents hooks from mutating cache/fallback/persisted-blob vectors.
    // .slice() on Float32Array allocates a fresh ArrayBuffer (not a view).
    const vectorCopy = vector ? vector.slice() : null;
    await this.options.vectorRanker.onEmbeddingPersisted({
      entityId,
      factId,
      vector: vectorCopy,
    });
  }

  /**
   * GDPR-critical variant: awaits the hook with a timeout and rethrows failures.
   * Use ONLY on deletion paths. forget() calls after soft-delete UPDATE; runPrune()
   * calls before hard DELETE. For best-effort sync, use _notifyEmbeddingPersisted.
   */
  private async _notifyEmbeddingPersistedOrThrow(
    entityId: string,
    factId: string,
    vector: Float32Array | null,
  ): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
    if (this.options.forceDeleteIgnoreRankerHook === true) return;

    const vectorCopy = vector ? vector.slice() : null;
    const rawTimeout = this.options.deletionHookTimeoutMs ?? 30_000;
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error('Invalid deletionHookTimeoutMs: must be a positive finite number');
    }
    const timeoutMs = rawTimeout;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => {
          const timeoutError = new Error(`onEmbeddingPersisted timed out after ${timeoutMs}ms`);
          (timeoutError as any)[HOOK_TIMEOUT_MARKER] = true;
          reject(timeoutError);
        },
        timeoutMs,
      );
    });

    const hookPromise = Promise.resolve(
      this.options.vectorRanker.onEmbeddingPersisted({
        entityId,
        factId,
        vector: vectorCopy,
      }),
    );

    try {
      await Promise.race([hookPromise, timeoutPromise]);
    } catch (err) {
      // Suppress late rejections from hook if timeout won
      hookPromise.catch(() => {});
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  constructor(db: SQLiteAdapter, options: WikiOptions) {
    this.db = db;
    this.options = options;
    this.prefix = options.config?.tablePrefix || 'llm_wiki_';
    this.outboxRepo = new OutboxRepository(db, this.prefix);
    this.entryRepo = new EntryRepository(db, this.prefix, this.outboxRepo);
    this.taskRepo = new TaskRepository(db, this.prefix, this.outboxRepo);
    this.eventRepo = new EventRepository(db, this.prefix);
    this.metadataRepo = new MetadataRepository(db, this.prefix);
    this.searchService = new SearchService(this.entryRepo);
    this.jobManager = new JobManager(this.prefix);
    this.ingestionService = new IngestionService(
      this.db, this.prefix, this.options, this.entryRepo, this.searchService, this.jobManager,
      this.embedFact.bind(this), this._notifyEmbeddingPersisted.bind(this)
    );
    this.maintenanceService = new MaintenanceService(
      this.db, this.prefix, this.options, this.entryRepo, this.taskRepo, this.eventRepo, this.metadataRepo, this.searchService, this.jobManager,
      this.embedFact.bind(this), this._notifyEmbeddingPersisted.bind(this), this._notifyEmbeddingPersistedOrThrow.bind(this), this._reconcileEmbeddingDimension.bind(this)
    );
  }

  async setup() {
    // Probe entries-table existence BEFORE creating any tables.  setupDatabase()
    // uses IF NOT EXISTS throughout, so once it has run the entries table always
    // exists and the fresh-install branch would be unreachable.  Future migrations
    // that ALTER TABLE would also fail if run against a schema already at the
    // target version but inferred as legacy because the probe ran too late.
    const entriesExistedBeforeSetup = await this.metadataRepo.tableExists(`${this.prefix}entries`);

    await setupDatabase(this.db, this.prefix);

    let currentVersion: number;

    if (!entriesExistedBeforeSetup) {
      // Fresh install — all tables just created at current schema; no migrations needed.
      await this.metadataRepo.setMeta('schema_version', String(CURRENT_SCHEMA_VERSION), this.db);
      currentVersion = CURRENT_SCHEMA_VERSION;
    } else {
      // Existing install — check meta for schema version.
      const schemaVersionValue = await this.metadataRepo.getMeta('schema_version');

      if (schemaVersionValue) {
        currentVersion = parseInt(schemaVersionValue, 10);
        if (!Number.isFinite(currentVersion)) currentVersion = 0;
      } else {
        // Legacy install without meta row — infer version from porter probe.
        const ftsDdl = await this.metadataRepo.getTableDdl(`${this.prefix}entries_fts`);
        const hasPorter = /tokenize\s*=\s*['"]porter\s+unicode61['"]/i.test(ftsDdl ?? '');
        currentVersion = hasPorter ? 1 : 0;
      }
    }

    // Run pending migrations in order.
    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        await migration.run(this.db, this.prefix);
        await this.metadataRepo.setMeta('schema_version', String(migration.version), this.db);
        currentVersion = migration.version;
      }
    }

    // Ensure meta row exists for legacy installs already at current version
    // (porter present, no meta row) — the migration loop may not have written it.
    if (entriesExistedBeforeSetup) {
      const schemaVersionCheck = await this.metadataRepo.getMeta('schema_version');
      if (!schemaVersionCheck) {
        await this.metadataRepo.setMeta('schema_version', String(currentVersion), this.db);
      }
    }

    // Fail before any other mutating passes (e.g. source_ref normalization) so we never
    // partially "repair" a DB that is still on legacy source_type strings.
    if (entriesExistedBeforeSetup) {
      await this.assertNoLegacySourceTypes();
    }

    // Migration: normalize any existing source_ref values that were stored before the
    // allowlist rule ([^A-Za-z0-9._\- ] → strip) was introduced.  Read-then-update in
    // JS so the normalization is guaranteed to match what normalizeSourceRef() produces,
    // regardless of which characters the old normalization left behind.
    // The WHERE clause pre-filters to rows that contain any character outside the
    // allowlist (checking leading/trailing whitespace, slashes, backslashes, NUL, and
    // the full ASCII non-allowlist range via GLOB) so that already-normalized
    // rows are never fetched.  Idempotent: after the first run no rows match the filter.
    const rows = await this.entryRepo.findRowsForSourceRefMigration();
    await this.db.withTransactionAsync(async (tx) => {
      for (const row of rows) {
        const normalized = normalizeSourceRef(row.source_ref);
        if (normalized !== row.source_ref) {
          await this.entryRepo.updateSourceRefByRowid(row.rowid, normalized, tx);
        }
      }
    });

    await this.searchService.sync();
  }

  async hasChanged(entityId: string, sourceRef: string, sourceHash: string): Promise<boolean> {
    const normalizedRef = normalizeSourceRef(sourceRef);
    if (!normalizedRef) {
      throw new Error(`Invalid sourceRef: "${sourceRef}"`);
    }
    const normalizedHash = normalizeSourceHash(sourceHash);
    if (!normalizedHash) {
      throw new Error(`Invalid sourceHash: must be a 64-character hex string (normalized to lowercase)`);
    }
    const storedHash = await this.entryRepo.findLatestSourceHash(entityId, normalizedRef);
    if (storedHash === null) return true;
    const normalizedStoredHash = normalizeSourceHash(storedHash);
    return normalizedStoredHash !== normalizedHash;
  }

  async runPrune(
    entityId: string,
    options?: {
      retainSoftDeletedFor?: number | null;
      retainEventsFor?: number | null;
      vacuum?: boolean;
    }
  ): Promise<{ entries: number; tasks: number; events: number }> {
    return this.maintenanceService.runPrune(entityId, options);
  }

  async read(entityId: string | string[], query: string, options?: ReadOptions): Promise<MemoryBundle> {
    const config = this.options.config;
    const entityIds = normalizeEntityIds(entityId);
    const sanitizedTierWeights = shouldExposeReadMetadata(entityId)
      ? sanitizeTierWeights(entityIds, options?.tierWeights)
      : undefined;
    const exposeMetadata = shouldExposeReadMetadata(entityId);

    if (entityIds.length === 0) {
      const empty: MemoryBundle = { facts: [], tasks: [], events: [] };
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
                const rankerError = rankerErr instanceof Error ? rankerErr : new Error(String(rankerErr));
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
          const error = err instanceof Error ? err : new Error(String(err));
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

    const bundle: MemoryBundle = { facts, tasks, events: events.reverse() };

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

  /**
   * Strip potentially sensitive data from ranker errors before exposing to host callbacks.
   * Preserves error type for debugging but removes message/stack that may contain credentials.
   * Recursively sanitizes one level of .cause; deeper chains collapse to type only.
   */
  private _sanitizeRankerError(err: unknown): Error {
    if (this.options.sanitizeRankerErrors === false) {
      return err instanceof Error ? err : new Error(String(err));
    }

    const typeName =
      err instanceof Error
        ? (err.constructor?.name ?? 'Error')
        : typeof err;

    const innerCause =
      err instanceof Error && err.cause !== undefined
        ? new Error(`Caused by: ${(err.cause as Error)?.constructor?.name ?? typeof err.cause}`)
        : undefined;

    const sanitized = new Error(
      `VectorRanker ${typeName} (message scrubbed for security)`,
      innerCause ? { cause: innerCause } : undefined,
    );
    sanitized.name = typeName;
    return sanitized;
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

  async getMemoryBundle(entityId: string): Promise<MemoryBundle> {
    return this._getFullBundle(entityId, { maxEvents: 10 });
  }

  async write(entityId: string, event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>): Promise<void> {
    const id = generateId('evt_');
    const now = Date.now();

    let eventType = event.event_type;
    if (!['observation', 'decision', 'action', 'outcome'].includes(eventType)) {
      eventType = 'observation';
    }

    const newEvent: WikiEvent = {
      id,
      entity_id: entityId,
      event_type: eventType,
      summary: event.summary,
      related_entry_id: event.related_entry_id || null,
      created_at: now,
    };

    // Wrap in transaction to ensure Event + Checkpoint logic is atomic
    let shouldRunLibrarian = false;
    let librarianCount = 0;
    let prevMemoryCheckpoint = 0;

    await this.db.withTransactionAsync(async (tx) => {
      await this.eventRepo.add(newEvent, tx);

      const threshold = this.options.config?.autoLibrarianThreshold || 20;

      const [count, cp] = await Promise.all([
        this.eventRepo.count(entityId, tx),
        this.metadataRepo.getCheckpoint(entityId, tx),
      ]);

      let memoryCheckpoint = cp.memory ?? 0;
      if (memoryCheckpoint > count) memoryCheckpoint = 0;

      if (count - memoryCheckpoint >= threshold) {
        if (!this.jobManager.isBlocked('librarian', entityId)) {
          shouldRunLibrarian = true;
          librarianCount = count;
          prevMemoryCheckpoint = memoryCheckpoint;
          await this.metadataRepo.updateCheckpoint(entityId, { memory: count }, tx);
        }
      }
    });

    if (shouldRunLibrarian) {
      try {
        this.jobManager.acquireLock('librarian', entityId);
        this.runLibrarianThenMaybeHeal(entityId, librarianCount)
          .catch(console.error)
          .finally(() => {
            this.jobManager.releaseLock('librarian', entityId);
          });
      } catch (e) {
        if (!(e instanceof WikiBusyError)) throw e;
        // Race: lock acquired between isBlocked check and acquireLock — roll back
        // checkpoint so the next event batch can retrigger librarian.
        await this.metadataRepo.updateCheckpoint(entityId, { memory: prevMemoryCheckpoint }, this.db);
      }
    }
  }

  private async runLibrarianThenMaybeHeal(entityId: string, currentEventCount: number) {
    await this.maintenanceService._doRunLibrarian(entityId);

    const autoHealThreshold = this.options.config?.autoHealThreshold || 100;

    // Read the latest heal checkpoint after librarian work finishes so the heal
    // decision reflects any concurrent checkpoint changes (e.g. from forget).
    const cp = await this.metadataRepo.getCheckpoint(entityId, this.db);
    let healCheckpoint = cp.heal ?? 0;
    if (healCheckpoint > currentEventCount) healCheckpoint = 0;
    const shouldRunHeal = currentEventCount - healCheckpoint >= autoHealThreshold;

    if (shouldRunHeal && this.jobManager.tryAcquireAutoHealLock(entityId)) {
      try {
        await this.maintenanceService._doRunHeal(entityId);
        await this.metadataRepo.updateCheckpoint(entityId, { heal: currentEventCount }, this.db);
      } finally {
        this.jobManager.releaseLock('heal', entityId);
      }
    }
  }

  async runLibrarian(entityId: string): Promise<void> {
    return this.maintenanceService.runLibrarian(entityId);
  }

  async runHeal(entityId: string): Promise<void> {
    return this.maintenanceService.runHeal(entityId);
  }

  async runReembed(entityId?: string, opts?: { force?: boolean; skipExisting?: boolean }): Promise<{ embedded: number; skipped: number; failed: number }> {
    return this.maintenanceService.runReembed(entityId, opts);
  }

  getEntityStatus(entityId: string): EntityStatus {
    return this.jobManager.getEntityStatus(entityId);
  }

  /**
   * Subscribe to {@link EntityStatus} changes for a single entity. The callback
   * is invoked synchronously once with the current status before this method
   * returns, then again on every transition where any of `ingesting`,
   * `librarian`, or `heal` flips. No polling, no duplicate snapshots.
   *
   * Returns an idempotent unsubscribe function.
   *
   * See also {@link getEntityStatus} for a synchronous point-in-time read.
   */
  subscribeEntityStatus(
    entityId: string,
    callback: (status: EntityStatus) => void
  ): () => void {
    return this.jobManager.subscribeEntityStatus(entityId, callback);
  }

  public clearVectorCache(): void {
    this.searchService.evictCache();
  }

  private async _getFullBundle(entityId: string, opts?: { maxEvents?: number; includeBlobs?: boolean }): Promise<MemoryBundle> {
    const [factsRaw, tasks, events] = await Promise.all([
      this.entryRepo.findAllByEntityId(entityId),
      this.taskRepo.findAllByEntityId(entityId),
      this.eventRepo.getByEntityId(entityId, opts?.maxEvents),
    ]);
    const facts = factsRaw.map(f => {
      // Always strip the legacy text embedding column — never useful to callers.
      const { embedding: _embedding, embedding_blob, ...rest } =
        f as WikiFact & { embedding?: unknown; embedding_blob?: Uint8Array };
      // Include the BLOB only on the export path so importDump() can round-trip
      // embeddings without re-calling the embed provider. Strip it on the LLM
      // prompt / formatMemoryDump paths to keep payloads small.
      // Copy blob bytes before returning: some SQLite drivers (better-sqlite3)
      // back Buffer objects with pooled native memory that can be reused by a
      // subsequent query, silently corrupting the already-returned MemoryDump.
      const safeBlobCopy = opts?.includeBlobs && embedding_blob
        ? (() => { const c = new ArrayBuffer(embedding_blob.byteLength); new Uint8Array(c).set(embedding_blob); return new Uint8Array(c); })()
        : undefined;
      const factBase = safeBlobCopy
        ? { ...rest, embedding_blob: safeBlobCopy }
        : rest;
      return {
        ...factBase,
        tags: typeof factBase.tags === 'string' ? JSON.parse(factBase.tags) : factBase.tags,
      };
    });
    return { facts, tasks, events };
  }

  async exportDump(entityIds?: string[]): Promise<MemoryDump> {
    let ids: string[];
    if (entityIds && entityIds.length > 0) {
      ids = Array.from(new Set(entityIds));
    } else {
      ids = await this.metadataRepo.getDistinctEntityIds();
    }

    const entities: Record<string, MemoryBundle> = {};
    const BATCH = 3;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(async (id): Promise<[string, MemoryBundle]> => [id, await this._getFullBundle(id, { includeBlobs: true })])
      );
      for (const [id, bundle] of batchResults) {
        entities[id] = bundle;
      }
    }

    return { generatedAt: Date.now(), entities };
  }

  async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
    const merge = opts?.merge ?? false;
    const entityIds = Object.keys(dump.entities);

    // acquireImportLocks validates all per-entity conflicts, then the global lock,
    // then acquires global + per-entity atomically (same semantics as before).
    this.jobManager.acquireImportLocks(entityIds);
    try {
      // Fail before any writes so we never partially commit an import and then reject
      // with a migration error — same probe as setup().
      await this.assertNoLegacySourceTypes();

      for (const [entityId, bundle] of Object.entries(dump.entities)) {
        await this._doImportEntity(entityId, bundle, merge);
      }
    } finally {
      this.jobManager.releaseImportLocks(entityIds);
    }
  }

  private async _doImportEntity(entityId: string, bundle: MemoryBundle, merge: boolean): Promise<void> {
      // Track which fact IDs were actually inserted/updated inside the transaction.
      // Skipped rows (cross-entity collisions or merge LWW losers) must not be
      // re-embedded — doing so would corrupt the winning row's vector with the
      // losing fact's title/body.
      const upsertedFactIds = new Set<string>();
      // Track upserted facts whose incoming row is soft-deleted. In replace mode,
      // these IDs still need vector=null notifications because they remain deleted.
      const upsertedDeletedFactIds = new Set<string>();
      // Track which upserted facts already carry a valid BLOB so we can skip
      // embedFact() for them. BLOBs are reconstructed from three serialization
      // forms: in-memory Uint8Array/Buffer, Node.js Buffer JSON shape, and
      // numeric-keyed plain objects produced by JSON.stringify(Uint8Array).
      // Store the blob data so we can notify the external vector index after the transaction.
      const factsWithPreservedBlob = new Map<string, Uint8Array>();
      // Track every unique dimension seen in preserved BLOBs. A dump may contain
      // blobs from multiple models (e.g. an intermediate mixed-model migration),
      // so we call storeEmbeddingDimension() for each unique dimension found to
      // ensure the mismatch flag is set whenever any two stored blobs disagree.
      const preservedBlobDims = new Set<number>();
      // In replace mode, collect IDs of facts that will be soft-deleted so we can
      // notify the external vector index with vector=null after the transaction.
      // Without this, external indexes retain stale embeddings and keep returning
      // deleted fact IDs in ranking results.
      const softDeletedFactIds: string[] = [];
      await this.db.withTransactionAsync(async (tx) => {
        if (!merge) {
          const deletedLiveFactIds = await this.entryRepo.findIdsBySource(entityId, null, null, tx, false);
          softDeletedFactIds.push(...deletedLiveFactIds);
          await this.entryRepo.bulkSoftDeleteByEntityId(entityId, tx);
          await this.taskRepo.bulkSoftDeleteByEntityId(entityId, tx);
          await this.metadataRepo.deleteCheckpoint(entityId, tx);
        }

        const factIds = bundle.facts.map((fact) => fact.id);
        const existingFactsById = new Map<string, { id: string; entity_id: string; updated_at: number }>();
        const existingFacts = await this.entryRepo.findExistingMetadataByIds(factIds, tx);
        for (const existingFact of existingFacts) {
          existingFactsById.set(existingFact.id, existingFact);
        }

        for (const fact of bundle.facts) {
          const sourceType = this._normalizeImportedSourceType(String(fact.source_type), {
            entityId,
            factId: fact.id,
          });
          const tagsJson = JSON.stringify(Array.isArray(fact.tags) ? fact.tags : []);
          // Normalize once: non-finite (undefined/null/NaN) → 0 so we never persist an
          // invalid value to the DB and ORDER BY updated_at remains meaningful.
          const safeUpdatedAt = Number.isFinite(fact.updated_at) ? fact.updated_at : 0;
          const existing = existingFactsById.get(fact.id);

          // Extract a valid BLOB from the incoming fact.
          // Three serialization forms are normalised to Uint8Array:
          //   1. Real Uint8Array / Buffer (in-memory dump)
          //   2. Node.js Buffer JSON shape { type:'Buffer', data:[...] }
          //      (produced by JSON.stringify(buffer))
          //   3. Numeric-keyed plain object {0:byte, 1:byte, ...}
          //      (produced by JSON.stringify(Uint8Array))
          const rawBlobRaw = (fact as WikiFact & { embedding_blob?: unknown }).embedding_blob;
          let rawBlob: Uint8Array | null = null;
          if (rawBlobRaw instanceof Uint8Array) {
            rawBlob = rawBlobRaw;
          } else if (
            rawBlobRaw !== null &&
            rawBlobRaw !== undefined &&
            typeof rawBlobRaw === 'object'
          ) {
            const obj = rawBlobRaw as Record<string, unknown>;
            if (obj['type'] === 'Buffer' && Array.isArray(obj['data'])) {
              // Node.js Buffer serialized via JSON.stringify(buffer)
              rawBlob = new Uint8Array(obj['data'] as number[]);
            } else if (!Array.isArray(rawBlobRaw)) {
              // Numeric-keyed plain object from JSON.stringify(Uint8Array)
              const entries = Object.keys(obj);
              if (entries.length > 0 && entries.every(k => /^\d+$/.test(k))) {
                const len = entries.length;
                rawBlob = new Uint8Array(len);
                for (let i = 0; i < len; i++) rawBlob[i] = (obj[String(i)] as number) ?? 0;
              }
            }
          }
          let blobData: Uint8Array | null = null;
          if (
            rawBlob !== null &&
            rawBlob.byteLength > 0 &&
            rawBlob.byteLength % 4 === 0
          ) {
            // Also validate that every float32 value is finite: a blob with the right
            // byte length but NaN/Inf values would be preserved, skip embedFact(), and
            // then be silently dropped by read(), making the fact permanently unsearchable.
            // Copy into a fresh ArrayBuffer so the Float32Array view is guaranteed to
            // start at offset 0 of its own buffer. Buffer.slice(0) in Node.js does NOT
            // copy — it returns a view into the parent buffer, which can have a non-zero
            // byteOffset and corrupt the Float32Array interpretation.
            const copy = new ArrayBuffer(rawBlob.byteLength);
            const alignedBlob = new Uint8Array(copy);
            alignedBlob.set(rawBlob);
            const floats = new Float32Array(copy, 0, rawBlob.byteLength / 4);
            let allFinite = true;
            for (let i = 0; i < floats.length; i++) {
              if (!isFinite(floats[i])) { allFinite = false; break; }
            }
            if (allFinite) {
              // Preserve this blob regardless of its dimension. Mixed-dimension
              // blobs are a real intermediate state during model migration and
              // silently discarding valid vectors is worse than importing them;
              // storeEmbeddingDimension() and read()'s mismatch-check handle
              // the case where stored blobs disagree on size.
              // Note: same-dimension model changes (e.g. two different providers
              // that happen to produce 1536-dim vectors) are undetectable here —
              // there is no model fingerprint in the blob. Callers importing from
              // a different provider should call runReembed() after importDump()
              // rather than relying on { skipExisting: true }.
              // Store aligned copy (not rawBlob) to avoid Float32Array alignment errors in notification.
              blobData = alignedBlob;
            }
          }

          if (existing) {
            if (existing.entity_id !== entityId) {
              this._warnCrossEntityCollision('entry', fact.id, existing.entity_id, entityId);
              continue;
            }
            if (merge) {
              if (safeUpdatedAt <= existing.updated_at) continue;
            }
          }

          const factObj: WikiFact = {
            id: fact.id,
            entity_id: entityId,
            title: fact.title,
            body: fact.body,
            tags: Array.isArray(fact.tags) ? fact.tags : [],
            confidence: fact.confidence,
            source_type: sourceType,
            source_hash: fact.source_hash,
            source_ref: fact.source_ref,
            created_at: fact.created_at,
            updated_at: safeUpdatedAt,
            last_accessed_at: fact.last_accessed_at,
            access_count: fact.access_count,
            deleted_at: fact.deleted_at,
            embedding_blob: blobData ?? undefined,
          };

          await this.entryRepo.upsertForImport(factObj, tx);
          if (blobData != null) {
            factsWithPreservedBlob.set(fact.id, blobData);
            if (!fact.deleted_at) preservedBlobDims.add(blobData.byteLength / 4);
          }
          existingFactsById.set(fact.id, { id: fact.id, entity_id: entityId, updated_at: safeUpdatedAt });
          upsertedFactIds.add(fact.id);
          if (fact.deleted_at) upsertedDeletedFactIds.add(fact.id);
        }

        const taskIds = bundle.tasks.map((task) => task.id);
        const existingTasksById = new Map<string, { id: string; entity_id: string; updated_at: number }>();
        const existingTasks = await this.taskRepo.findExistingMetadataByIds(taskIds, tx);
        for (const existingTask of existingTasks) {
          existingTasksById.set(existingTask.id, existingTask);
        }

        for (const task of bundle.tasks) {
          // Normalize once: non-finite (undefined/null/NaN) → 0 so we never persist an
          // invalid value to the DB and ORDER BY updated_at remains meaningful.
          const safeUpdatedAt = Number.isFinite(task.updated_at) ? task.updated_at : 0;
          const existing = existingTasksById.get(task.id);
          if (existing) {
            if (existing.entity_id !== entityId) {
              this._warnCrossEntityCollision('task', task.id, existing.entity_id, entityId);
              continue;
            }
            if (merge) {
              if (safeUpdatedAt <= existing.updated_at) continue;
            }
          }

          await this.taskRepo.upsertForImport({
            id: task.id,
            entity_id: entityId,
            description: task.description,
            status: task.status,
            priority: task.priority,
            created_at: task.created_at,
            updated_at: safeUpdatedAt,
            resolved_at: task.resolved_at,
            deleted_at: task.deleted_at,
          }, tx, safeUpdatedAt);
          existingTasksById.set(task.id, { id: task.id, entity_id: entityId, updated_at: safeUpdatedAt });
        }

        for (const event of bundle.events) {
          await this.eventRepo.addIgnoreDuplicate({
            id: event.id,
            entity_id: entityId,
            event_type: event.event_type,
            summary: event.summary,
            related_entry_id: event.related_entry_id ?? null,
            created_at: event.created_at,
          }, tx);
        }
      });
      // Evict cache and rebuild MiniSearch immediately after the transaction
      // commits so concurrent read() calls see updated text and don't use stale
      // vectors. sync() evicts the cache internally before rebuilding the index.
      await this.searchService.sync(entityId);
      // Embed only facts that were actually inserted/updated in the transaction.
      // Skipped rows (cross-entity collisions or merge LWW losers) must not be
      // re-embedded — they were not written and their existing row must not be
      // overwritten with the incoming fact's content.
      // Facts with preserved BLOBs (from an in-memory dump) already have valid
      // embeddings; skip embedFact() for those to avoid redundant API calls.
      // For facts without a BLOB, the UPDATE/INSERT already left embedding_blob = NULL,
      // so if embedFact() fails here the row correctly has a NULL vector.
      for (const fact of bundle.facts) {
        if (!fact.deleted_at && upsertedFactIds.has(fact.id) && !factsWithPreservedBlob.has(fact.id)) {
          await this.embedFact({
            id: fact.id,
            entity_id: entityId,  // Use authoritative entityId from dump key, not fact.entity_id
            title: fact.title,
            body: fact.body,
            tags: Array.isArray(fact.tags) || typeof fact.tags === 'string' ? fact.tags : [],
          });
        }
      }
      // Notify external vector index about preserved-blob facts.
      // These skipped embedFact(), so _notifyEmbeddingPersisted was never called.
      // Only notify for live facts (skip soft-deleted) to avoid polluting external index.
      for (const fact of bundle.facts) {
        const blobData = factsWithPreservedBlob.get(fact.id);
        if (blobData && !fact.deleted_at && upsertedFactIds.has(fact.id)) {
          try {
            const float32Vector = new Float32Array(blobData.buffer, blobData.byteOffset, blobData.byteLength / 4);
            await this._notifyEmbeddingPersisted(entityId, fact.id, float32Vector);
          } catch (hookErr) {
            console.warn(`[WikiMemory] onEmbeddingPersisted hook failed for preserved-blob fact ${fact.id}:`, hookErr);
          }
        }
      }
      // In replace mode, notify external vector index that soft-deleted facts should be removed.
      // Re-upserted facts are usually restores, except when the incoming row is still
      // soft-deleted (deleted_at set). Those must also receive vector=null.
      for (const factId of softDeletedFactIds) {
        if (!upsertedFactIds.has(factId) || upsertedDeletedFactIds.has(factId)) {
          try {
            await this._notifyEmbeddingPersisted(entityId, factId, null);
          } catch (hookErr) {
            console.warn(`[WikiMemory] onEmbeddingPersisted(vector=null) hook failed for soft-deleted fact ${factId}:`, hookErr);
          }
        }
      }
      // If any facts carried preserved BLOBs, record the vector dimension in the
      // meta table now (embedFact() was skipped for those rows, so it didn't happen
      // automatically). This ensures read() can detect model-dimension mismatches
      // after importing into a fresh DB that has never seen an embedding.
      // However, if the preserved BLOBs have a *different* dimension than the
      // current canonical dimension, skip bookkeeping entirely. Calling
      // storeEmbeddingDimension() with the imported dimension would set
      // embedding_dimension_mismatch, which _reconcileEmbeddingDimension() would
      // interpret as the target dimension. After runReembed() rewrites everything
      // to the canonical dimension, the mismatch flag would never clear (all facts
      // now differ from the old imported dimension, so residual count > 0 forever).
      // Instead, let runReembed() reconcile all vectors without pre-seeding metadata.
      try {
        // Query the current canonical embedding dimension, if any.
        const canonicalDimValue = await this.metadataRepo.getMeta('embedding_dimension');
        const canonicalDim = canonicalDimValue ? parseInt(canonicalDimValue, 10) : null;

        if (preservedBlobDims.size === 1) {
          const preservedDim = [...preservedBlobDims][0];
          if (canonicalDim === null || canonicalDim === preservedDim) {
            await this.storeEmbeddingDimension(preservedDim);
            const staleMismatchValue = await this.metadataRepo.getMeta('embedding_dimension_mismatch');
            if (staleMismatchValue && parseInt(staleMismatchValue, 10) !== preservedDim) {
              await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(preservedDim), this.db);
            }
            await this._reconcileEmbeddingDimension();
          } else {
            await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(canonicalDim), this.db);
          }
        } else if (preservedBlobDims.size > 1) {
          if (canonicalDim === null) {
            const sortedPreservedBlobDims = [...preservedBlobDims].sort((a, b) => a - b);
            await this.storeEmbeddingDimension(sortedPreservedBlobDims[0]);
            await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(sortedPreservedBlobDims[0]), this.db);
          } else {
            await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(canonicalDim), this.db);
          }
        }
      } finally {
        // Second flush: evict any cache entries a concurrent read() repopulated
        // from old DB vectors while the embedding loop was running. Runs even if
        // storeEmbeddingDimension() throws so stale entries cannot survive an error.
        this.searchService.evictCache(entityId);
      }
  }

  async forget(entityId: string, params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean }): Promise<{ deleted: { entries: number; tasks: number } }> {
    return this.maintenanceService.forget(entityId, params);
  }

  async ingestDocument(entityId: string, params: { sourceRef: string; sourceHash: string; documentChunk: string; maxChunkLength?: number; chunkOverlap?: number; chunkConcurrency?: number }): Promise<{ truncated: boolean; chunks: number }> {
    return this.ingestionService.ingestDocument(entityId, params);
  }

}


export const __testables = { validateFact, validateTask, clip, chunkText };

