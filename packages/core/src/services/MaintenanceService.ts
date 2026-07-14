import { parseJsonResponse, validateFact, validateTask, titleTokens, jaccardScore, normalizeSourceRef, normalizeSourceHash, sanitizeRankerError } from '../utils/pure';
import { normalizeTitleKey } from '../utils/ontology';
import { PromptService } from './PromptService';
import type { OntologyService, TitleIndexEntry } from './OntologyService';
import { generateId } from '../utils/ids';
import { parseEmbedding } from '../utils/embedding';
import { PrunePartialFailureError } from '../types';
import { HOOK_TIMEOUT_MARKER } from '../types';
import type { WikiOptions, ExtractedFact, ExtractedFactEdge, ExtractedTask, ExtractedFactWithOntology, WikiFact, WikiTask, OntologyUpdates, OntologyBackfillResult } from '../types';
import type { SQLiteAdapter } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { TaskRepository } from '../repositories/TaskRepository';
import type { EventRepository } from '../repositories/EventRepository';
import { entitySummaryMetaKey, type MetadataRepository } from '../repositories/MetadataRepository';
import type { SearchService } from './SearchService';
import type { JobManager } from './JobManager';
import type { EmbeddingService } from './EmbeddingService';

const FUZZY_THRESHOLD = 0.5;
const MIN_TOKENS_TO_QUALIFY = 3;

export const ONTOLOGY_BACKFILL_BATCH_SIZE = 25;
export const ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS = 40_000;
export const ONTOLOGY_BACKFILL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export class MaintenanceService {
  private promptService: PromptService;

  constructor(
    private db: SQLiteAdapter,
    private prefix: string,
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private taskRepo: TaskRepository,
    private eventRepo: EventRepository,
    private metadataRepo: MetadataRepository,
    private searchService: SearchService,
    private jobManager: JobManager,
    private embeddingService: EmbeddingService,
    promptService?: PromptService,
    private ontologyService?: OntologyService,
  ) {
    // Fallback for direct instantiation outside WikiMemory facade (e.g. isolated tests).
    this.promptService = promptService ?? new PromptService(this.options.config?.prompts);
  }

  async runPrune(entityId: string, options?: { retainSoftDeletedFor?: number | null; retainEventsFor?: number | null; vacuum?: boolean }): Promise<{ entries: number; tasks: number; events: number }> {
    this.jobManager.acquireLock('prune', entityId);

    try {
      const retainSoftDeletedFor = options?.retainSoftDeletedFor !== undefined ? options.retainSoftDeletedFor : (this.options.config?.pruneRetainSoftDeletedFor ?? 7);
      const retainEventsFor = options?.retainEventsFor !== undefined ? options.retainEventsFor : (this.options.config?.pruneEventsAfter ?? 30);
      const vacuum = options?.vacuum ?? false;

      this._validatePruneDuration(retainSoftDeletedFor, 'retainSoftDeletedFor');
      this._validatePruneDuration(retainEventsFor, 'retainEventsFor');

      const now = Date.now();
      let deletedEntries = 0;
      let deletedTasks = 0;
      let deletedEvents = 0;

      if (retainSoftDeletedFor !== null) {
        const cutoff = now - retainSoftDeletedFor * 86400000;
        const entriesToDelete = await this.entryRepo.getPrunableMetadata(entityId, cutoff);

        const succeeded: Array<{ entity_id: string; id: string }> = [];
        let failure: { factId: string; cause: unknown } | null = null;

        for (const row of entriesToDelete) {
          try {
            await this.embeddingService.notifyEmbeddingPersistedOrThrow(row.entity_id, row.id, null);
            succeeded.push({ entity_id: row.entity_id, id: row.id });
          } catch (err) {
            failure = { factId: row.id, cause: err };
            break;
          }
        }

        const succeededIds = succeeded.map(r => r.id);

        await this.db.withTransactionAsync(async (tx) => {
          if (succeededIds.length > 0) {
            deletedEntries = await this.entryRepo.bulkDeletePruned(entityId, cutoff, succeededIds, tx);
          }
          deletedTasks = await this.taskRepo.bulkDeletePruned(entityId, cutoff, tx);
        });

        if (failure) {
          await this.searchService.sync(entityId);
          const remaining = entriesToDelete.length - succeeded.length - 1;
          const isTimeout = (failure.cause as any)?.[HOOK_TIMEOUT_MARKER] === true;

          if (isTimeout) {
            throw new PrunePartialFailureError(
              succeeded.length, failure.factId, remaining, new Error('Deletion hook timed out'), deletedTasks, 0
            );
          }

          const errMsg = (failure.cause as Error)?.message ?? '';
          const isValidationError = errMsg.startsWith('Invalid deletionHookTimeoutMs');
          const sanitizedCause = isValidationError ? failure.cause as Error : this._sanitizeRankerError(failure.cause);

          throw new PrunePartialFailureError(
            succeeded.length, failure.factId, remaining, sanitizedCause, deletedTasks, 0
          );
        }
      }

      if (retainEventsFor !== null) {
        const cutoff = now - retainEventsFor * 86400000;
        const eventResult = await this.eventRepo.prune(entityId, cutoff);
        deletedEvents = eventResult.changes;
      }

      if (vacuum) {
        await this.metadataRepo.vacuum();
      }

      await this.searchService.sync(entityId);
      return { entries: deletedEntries, tasks: deletedTasks, events: deletedEvents };
    } finally {
      this.jobManager.releaseLock('prune', entityId);
    }
  }

  async runLibrarian(entityId: string, options?: { promptOverride?: string }): Promise<void> {
    this.jobManager.acquireLock('librarian', entityId);
    try {
      await this.doRunLibrarian(entityId, options?.promptOverride);
    } finally {
      this.jobManager.releaseLock('librarian', entityId);
    }
  }

  async runHeal(entityId: string, options?: { promptOverride?: string }): Promise<void> {
    this.jobManager.acquireLock('heal', entityId);
    try {
      await this.doRunHeal(entityId, options?.promptOverride);
    } finally {
      this.jobManager.releaseLock('heal', entityId);
    }
  }

  async runOntologyBackfill(
    entityId: string,
    options?: { promptOverride?: string; batchSize?: number },
  ): Promise<OntologyBackfillResult> {
    this.jobManager.acquireLock('ontologyBackfill', entityId);
    try {
      return await this.doRunOntologyBackfill(entityId, options);
    } finally {
      this.jobManager.releaseLock('ontologyBackfill', entityId);
    }
  }

  async runReembed(entityId?: string, opts?: { force?: boolean; skipExisting?: boolean }): Promise<{ embedded: number; skipped: number; failed: number }> {
    const embedFn = this.options.llmProvider.embed;
    if (!embedFn) return { embedded: 0, skipped: 0, failed: 0 };

    const op = entityId ? 'reembed' : 'global_reembed';
    this.jobManager.acquireLock(op, entityId ?? '*');

    try {

      const rows = await this.entryRepo.findAllForReembed(entityId);
      this.searchService.evictCache(entityId);

      const skipExisting = opts?.skipExisting ?? false;
      let effectiveSkip = skipExisting;

      if (skipExisting) {
        const mismatchValue = await this.metadataRepo.getMeta('embedding_dimension_mismatch');
        if (mismatchValue) {
          if (entityId) {
            const mismatchDim = parseInt(mismatchValue, 10);
            const staleCount = await this.entryRepo.countStaleForEntity(entityId, mismatchDim);
            if (staleCount > 0) effectiveSkip = false;
          } else {
            effectiveSkip = false;
          }
        }
      }

      let embedded = 0;
      let skipped = 0;
      let failed = 0;

      try {
        for (const row of rows) {
          const existingBlob = (row as WikiFact & { embedding_blob?: Uint8Array | null }).embedding_blob;
          const blobIsValid = !!existingBlob && existingBlob.byteLength > 0 && existingBlob.byteLength % 4 === 0;

          if (effectiveSkip && blobIsValid) {
            const vec = parseEmbedding(existingBlob, null);
            if (vec !== null && vec.every(v => Number.isFinite(v))) {
              skipped++;
              continue;
            }
          }

          const success = await this.embeddingService.embedFact(row);
          if (success) embedded++;
          else failed++;
        }

        if (embedded > 0) {
          await this.embeddingService.reconcileEmbeddingDimension();
        }
      } finally {
        this.searchService.evictCache(entityId);
      }

      return { embedded, skipped, failed };
    } finally {
      this.jobManager.releaseLock(op, entityId ?? '*');
    }
  }

  async forget(entityId: string, params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean }): Promise<{ deleted: { entries: number; tasks: number } }> {
    if (params.clearAll && (params.entryId !== undefined || params.taskId !== undefined || params.sourceRef !== undefined || params.sourceHash !== undefined)) {
      throw new Error('forget() clearAll is mutually exclusive with entryId, taskId, sourceRef, and sourceHash');
    }

    this.jobManager.acquireLock('forget', entityId);

    try {
      const now = Date.now();
      let deletedEntries = 0;
      let deletedTasks = 0;
      const deletedEntryIds: string[] = [];

      await this.db.withTransactionAsync(async (tx) => {
        if (params.clearAll) {
          deletedEntryIds.push(...await this.entryRepo.findIdsBySource(entityId, null, null, tx, true));
          deletedEntries = await this.entryRepo.bulkSoftDeleteByEntityId(entityId, tx);
          deletedTasks = await this.taskRepo.bulkSoftDeleteByEntityId(entityId, tx);
          await this.metadataRepo.updateCheckpoint(entityId, { memory: 0, heal: 0 }, tx);
          await this.metadataRepo.deleteMeta(entitySummaryMetaKey(entityId), tx);
        } else {
          const hasIdSelectors = params.entryId !== undefined || params.taskId !== undefined;
          const hasSourceSelectors = params.sourceRef !== undefined || params.sourceHash !== undefined;

          if (hasIdSelectors && hasSourceSelectors) {
            throw new Error('forget() params are mutually exclusive: use entryId/taskId together, or sourceRef/sourceHash together, but not both in the same call');
          }

          const sourceRef = params.sourceRef !== undefined ? normalizeSourceRef(params.sourceRef) : null;
          if (params.sourceRef !== undefined && !sourceRef) throw new Error('Invalid sourceRef');

          const sourceHash = params.sourceHash !== undefined ? normalizeSourceHash(params.sourceHash) : null;
          if (params.sourceHash !== undefined && !sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

          if (params.entryId) {
            const entryId = await this.entryRepo.findIdById(params.entryId, entityId, tx);
            if (entryId) deletedEntryIds.push(entryId);
          }

          if (sourceRef || sourceHash) {
            deletedEntryIds.push(...await this.entryRepo.findIdsBySource(entityId, sourceRef, sourceHash, tx, true));
          }

          const entryPromise = params.entryId ? this.entryRepo.softDelete(params.entryId, entityId, tx).then(r => r.changes > 0) : null;
          const taskDeletedPromise = params.taskId ? this.taskRepo.softDeleteById(params.taskId, entityId, tx).then(r => r.changes > 0) : null;
          const refPromise = (sourceRef || sourceHash) ? this.entryRepo.softDeleteBySource(entityId, tx, sourceRef, sourceHash) : null;

          const [entryResult, taskResult, refResult] = await Promise.all([
            entryPromise ?? Promise.resolve(false),
            taskDeletedPromise ?? Promise.resolve(false),
            refPromise ?? Promise.resolve(0),
          ]);

          if (entryResult) deletedEntries++;
          if (taskResult) deletedTasks++;
          deletedEntries += refResult;
        }
      });

      await this.searchService.sync(entityId);

      const uniqueDeletedIds = Array.from(new Set(deletedEntryIds));
      for (const factId of uniqueDeletedIds) {
        try {
          await this.embeddingService.notifyEmbeddingPersistedOrThrow(entityId, factId, null);
        } catch (hookErr) {
          const isTimeout = (hookErr as any)?.[HOOK_TIMEOUT_MARKER] === true;
          if (isTimeout) {
            throw new Error(`forget(${entityId}/${factId}) failed: ${(hookErr as Error).message}`);
          }
          const errMsg = (hookErr as Error)?.message ?? '';
          if (errMsg.startsWith('Invalid deletionHookTimeoutMs')) {
            throw new Error(`forget(${entityId}/${factId}) failed: ${errMsg}`, { cause: hookErr });
          }
          throw new Error(`forget(${entityId}/${factId}) failed: ANN cleanup hook rejected`, { cause: this._sanitizeRankerError(hookErr) });
        }
      }

      return { deleted: { entries: deletedEntries, tasks: deletedTasks } };
    } finally {
      this.jobManager.releaseLock('forget', entityId);
    }
  }

  /** Core librarian pass (locks handled by {@link runLibrarian}). Package-internal orchestration hook. */
  async doRunLibrarian(entityId: string, promptOverride?: string): Promise<void> {
    const events = await this.eventRepo.getRecent(entityId, 50);
    const currentFactsRows = await this.entryRepo.findRecentByEntityId(entityId, 100);

    const currentFacts = currentFactsRows.map(f => {
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      return {
        ...rest,
        tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags,
      };
    });

    const ontologyContext = await this.ontologyService?.buildPromptContext(entityId) ?? null;

    const { systemPrompt, userPrompt } = this.promptService.buildLibrarianPrompt(
      events.reverse(),
      currentFacts,
      promptOverride,
      ontologyContext,
    );

    const responseText = await this.options.llmProvider.generateText({ systemPrompt, userPrompt });

    const result = parseJsonResponse<{
      facts: ExtractedFact[];
      tasks: ExtractedTask[];
      ontology_updates?: OntologyUpdates;
    }>(responseText);
    const facts = Array.isArray(result.facts) ? result.facts : [];
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    const ontologyUpdates = result.ontology_updates;

    const validFacts = facts.map(validateFact).filter((f): f is ExtractedFact => f !== null);
    const validTasks = tasks.map(validateTask).filter((t): t is ExtractedTask => t !== null);

    const now = Date.now();
    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];

    await this.db.withTransactionAsync(async (tx) => {
      let { mode, manifest } = await this.ontologyService?.getEffectiveState(entityId, tx)
        ?? { mode: 'off' as const, manifest: { node_types: [], edge_types: [] } };

      if (mode === 'emergent' && ontologyUpdates && this.ontologyService) {
        manifest = await this.ontologyService.mergeEmergentUpdates(entityId, ontologyUpdates, tx);
      }

      const titleIndex = new Map<string, TitleIndexEntry>();
      for (const existing of currentFactsRows) {
        titleIndex.set(normalizeTitleKey(existing.title), {
          id: existing.id,
          okf_type: existing.okf_type ?? null,
        });
      }

      const factsForDedupe = await this.entryRepo.findRecentByEntityId(entityId, 100, tx);

      const pendingEdges: Array<{
        sourceId: string;
        sourceType: string | null;
        edges: ExtractedFactWithOntology['edges'];
      }> = [];

      for (const fact of validFacts) {
        const newTokens = titleTokens(fact.title);
        let skip = false;

        if (newTokens.size >= MIN_TOKENS_TO_QUALIFY) {
          for (const existing of factsForDedupe) {
            if (existing.source_type !== 'librarian_inferred') continue;
            const existingTokens = titleTokens(existing.title);
            if (existingTokens.size >= MIN_TOKENS_TO_QUALIFY) {
              if (jaccardScore(newTokens, existingTokens) >= FUZZY_THRESHOLD) {
                skip = true;
                break;
              }
            }
          }
        }

        if (skip) continue;

        const ontologyFact = fact as ExtractedFactWithOntology;
        const normalized = this.ontologyService?.validateAndNormalizeFact(ontologyFact, manifest)
          ?? { okf_type: null, edges: [] };

        const id = generateId('fact_');
        const factObj: WikiFact = {
          id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
          source_type: 'librarian_inferred', source_hash: null, source_ref: null,
          created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
          okf_type: normalized.okf_type,
        };

        await this.entryRepo.upsert(factObj, tx);
        insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
        factsForDedupe.push(factObj);

        titleIndex.set(normalizeTitleKey(fact.title), { id, okf_type: normalized.okf_type });

        if (normalized.edges.length > 0) {
          pendingEdges.push({ sourceId: id, sourceType: normalized.okf_type, edges: normalized.edges });
        }
      }

      for (const item of pendingEdges) {
        await this.ontologyService?.resolveAndPersistEdges(
          entityId, item.sourceId, item.sourceType, item.edges ?? [], manifest, titleIndex, tx, now,
        );
      }

      for (const task of validTasks) {
        const id = generateId('task_');
        const taskObj: WikiTask = {
          id, entity_id: entityId, description: task.description, status: 'pending', priority: task.priority,
          created_at: now, updated_at: now, resolved_at: null, deleted_at: null
        };
        await this.taskRepo.upsert(taskObj, tx);
      }
    });

    await this.searchService.sync(entityId);

    for (const fact of insertedFacts) {
      await this.embeddingService.embedFact(fact);
    }

    this.searchService.evictCache(entityId);
  }

  /** Core heal pass (locks handled by {@link runHeal}). Package-internal orchestration hook. */
  async doRunHeal(entityId: string, promptOverride?: string): Promise<void> {
    const now = Date.now();
    const orphanAfterDays = this.options.config?.orphanAfterDays !== undefined ? this.options.config?.orphanAfterDays : 30;
    const staleInferredAfterDays = this.options.config?.staleInferredAfterDays !== undefined ? this.options.config?.staleInferredAfterDays : 60;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    if (orphanAfterDays !== null && (typeof orphanAfterDays !== 'number' || !Number.isFinite(orphanAfterDays) || orphanAfterDays < 0)) {
      throw new Error('Invalid orphanAfterDays: must be a finite number >= 0 or null');
    }
    if (staleInferredAfterDays !== null && (typeof staleInferredAfterDays !== 'number' || !Number.isFinite(staleInferredAfterDays) || staleInferredAfterDays < 0)) {
      throw new Error('Invalid staleInferredAfterDays: must be a finite number >= 0 or null');
    }

    const orphanedIds: string[] = [];

    await this.db.withTransactionAsync(async (tx) => {
      if (orphanAfterDays !== null) {
        const orphanThreshold = now - (orphanAfterDays * MS_PER_DAY);
        orphanedIds.push(...await this.entryRepo.markOrphaned(entityId, orphanThreshold, tx));
      }
      if (staleInferredAfterDays !== null) {
        const staleThreshold = now - (staleInferredAfterDays * MS_PER_DAY);
        await this.entryRepo.downgradeStaleInferred(entityId, staleThreshold, tx);
      }
    });

    for (const factId of orphanedIds) {
      try {
        await this.embeddingService.notifyEmbeddingPersisted(entityId, factId, null);
      } catch (hookErr) {
        console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during heal orphan pass for ${factId}:`, hookErr);
      }
    }

    const allFactsRows = await this.entryRepo.findAllByEntityId(entityId);
    const allTasks = await this.taskRepo.findAllPending([entityId]);
    const recentEvents = await this.eventRepo.getRecent(entityId, 20);

    const healCandidates = allFactsRows.filter(f => f.source_type !== 'immutable_document');
    const documentAnchors = allFactsRows
      .filter(f => f.source_type === 'immutable_document')
      .map(({ id, title, source_ref }) => ({ id, title, source_ref }));

    const healCandidatesForPrompt = healCandidates.map(f => {
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      return { ...rest, tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags };
    });

    const { systemPrompt, userPrompt } = this.promptService.buildHealPrompt(
      healCandidatesForPrompt,
      documentAnchors,
      allTasks,
      recentEvents,
      promptOverride,
    );

    const responseText = await this.options.llmProvider.generateText({ systemPrompt, userPrompt });

    const result = parseJsonResponse<{ downgraded: string[], deleted: string[], newFacts: ExtractedFact[] }>(responseText);

    const mutableIds = new Set(healCandidates.map(f => f.id));
    const downgraded = Array.isArray(result.downgraded) ? result.downgraded : [];
    const deleted = Array.isArray(result.deleted) ? result.deleted : [];
    const newFacts = Array.isArray(result.newFacts) ? result.newFacts : [];

    const safeDowngraded = Array.from(new Set(downgraded.filter(id => mutableIds.has(id))));
    const safeDeleted = Array.from(new Set(deleted.filter(id => mutableIds.has(id))));
    const validNewFacts = newFacts.map(validateFact).filter((f): f is ExtractedFact => f !== null);

    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
    const uniqueDeletedFactIds = Array.from(new Set(safeDeleted));

    const healFactsForDedupe = [...healCandidates];

    await this.db.withTransactionAsync(async (tx) => {
      await this.entryRepo.downgradeByIds(safeDowngraded, entityId, tx);
      await this.entryRepo.softDeleteByIds(safeDeleted, entityId, tx);

      for (const fact of validNewFacts) {
        const newTokens = titleTokens(fact.title);
        let skip = false;

        if (newTokens.size >= MIN_TOKENS_TO_QUALIFY) {
          for (const existing of healFactsForDedupe) {
            if (existing.source_type !== 'librarian_inferred') continue;
            const existingTokens = titleTokens(existing.title);
            if (existingTokens.size >= MIN_TOKENS_TO_QUALIFY) {
              if (jaccardScore(newTokens, existingTokens) >= FUZZY_THRESHOLD) {
                skip = true;
                break;
              }
            }
          }
        }

        if (skip) continue;

        const id = generateId('fact_');
        const factObj: WikiFact = {
          id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
          source_type: 'librarian_inferred', source_hash: null, source_ref: null,
          created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
        };

        await this.entryRepo.upsert(factObj, tx);
        insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
        healFactsForDedupe.push(factObj);
      }
    });

    await this.searchService.sync(entityId);

    for (const factId of uniqueDeletedFactIds) {
      try {
        await this.embeddingService.notifyEmbeddingPersisted(entityId, factId, null);
      } catch (hookErr) {
        console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during heal for ${factId}:`, hookErr);
      }
    }

    for (const fact of insertedFacts) {
      await this.embeddingService.embedFact(fact);
    }

    this.searchService.evictCache(entityId);
  }

  /** Core ontology backfill pass (locks handled by {@link runOntologyBackfill}). Package-internal orchestration hook. */
  async doRunOntologyBackfill(
    entityId: string,
    options?: { promptOverride?: string; batchSize?: number },
  ): Promise<OntologyBackfillResult> {
    const batchSize = options?.batchSize ?? ONTOLOGY_BACKFILL_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('Invalid batchSize: must be an integer >= 1');
    }

    const now = Date.now();
    const recheckCutoff = now - ONTOLOGY_BACKFILL_RECHECK_MS;
    const zeroed = { scanned: 0, typed: 0, failedValidation: 0, edgesAdded: 0 };

    const ontologyService = this.ontologyService;
    if (!ontologyService) {
      return { ...zeroed, remaining: 0, deferred: 0 };
    }

    const { mode } = await ontologyService.getEffectiveState(entityId);
    if (mode === 'off') {
      // remaining stays 0: with ontology off nothing is eligible for typing, and
      // a host convergence loop (while remaining > 0) must terminate.
      const counts = await this.entryRepo.countUntypedByEntityId(entityId, recheckCutoff);
      return { ...zeroed, remaining: 0, deferred: counts.deferred };
    }

    const candidates = await this.entryRepo.findUntypedByEntityId(entityId, batchSize, recheckCutoff);
    if (candidates.length === 0) {
      const counts = await this.entryRepo.countUntypedByEntityId(entityId, recheckCutoff);
      return { ...zeroed, remaining: counts.eligible, deferred: counts.deferred };
    }

    const ontologyContext = await ontologyService.buildPromptContext(entityId);

    // Payload guard: cap the full serialized prompt (system + user — manifest,
    // ids, tags, JSON syntax, overrides all counted) so dense facts cannot blow
    // a provider's context window. A single fact whose prompt alone exceeds the
    // cap is still sent by itself: deferring it would just re-defer forever and
    // starve it (spec Decision 2).
    const toPromptShape = (f: WikiFact) => ({ id: f.id, title: f.title, body: f.body, tags: f.tags });
    const buildPrompt = (facts: WikiFact[]) => this.promptService.buildOntologyBackfillPrompt(
      facts.map(toPromptShape),
      options?.promptOverride,
      ontologyContext,
    );

    const batch: WikiFact[] = [candidates[0]];
    let built = buildPrompt(batch);
    for (let i = 1; i < candidates.length; i++) {
      const next = buildPrompt([...batch, candidates[i]]);
      if (next.systemPrompt.length + next.userPrompt.length > ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS) break;
      batch.push(candidates[i]);
      built = next;
    }

    const { systemPrompt, userPrompt } = built;

    const responseText = await this.options.llmProvider.generateText({ systemPrompt, userPrompt });

    const parsed = parseJsonResponse<{
      classifications?: Array<{ id?: unknown; okf_type?: unknown; edges?: unknown }>;
      ontology_updates?: OntologyUpdates;
    }>(responseText);
    const classifications = Array.isArray(parsed.classifications) ? parsed.classifications : [];

    let typed = 0;
    let failedValidation = 0;
    let edgesAdded = 0;

    let abortedOntologyOff = false;

    await this.db.withTransactionAsync(async (tx) => {
      let { mode: txMode, manifest } = await ontologyService.getEffectiveState(entityId, tx);

      // setOntologyManifest is not under this job lock, so ontology can be
      // disabled while generateText was in flight. Abort without typing facts
      // or stamping cooldowns.
      if (txMode === 'off') {
        abortedOntologyOff = true;
        return;
      }

      if (txMode === 'emergent' && parsed.ontology_updates) {
        manifest = await ontologyService.mergeEmergentUpdates(entityId, parsed.ontology_updates, tx);
      }

      // Full breadth, three columns only: an old fact's edge targets are its
      // contemporaries, which a recent-100 window would silently miss.
      const titleRows = await this.entryRepo.findTitleIndexByEntityId(entityId, tx);
      const titleIndex = new Map<string, TitleIndexEntry>();
      for (const row of titleRows) {
        titleIndex.set(normalizeTitleKey(row.title), { id: row.id, okf_type: row.okf_type });
      }

      const batchById = new Map(batch.map(f => [f.id, f]));
      const applied = new Set<string>();
      const pendingEdges: Array<{ sourceId: string; sourceType: string; edges: ExtractedFactEdge[] }> = [];

      for (const classification of classifications) {
        const fact = typeof classification.id === 'string' ? batchById.get(classification.id) : undefined;
        if (!fact || applied.has(fact.id)) {
          failedValidation++;
          continue;
        }
        applied.add(fact.id);

        const normalized = ontologyService.validateAndNormalizeFact(
          {
            title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
            okf_type: classification.okf_type as string | undefined, edges: classification.edges as ExtractedFactEdge[] | undefined,
          } as ExtractedFactWithOntology,
          manifest,
        );
        if (!normalized.okf_type) {
          failedValidation++;
          continue;
        }

        const result = await this.entryRepo.updateOkfType(fact.id, entityId, normalized.okf_type, tx);
        // changes === 0 → typed concurrently between select and update; the
        // okf_type IS NULL guard left it untouched. Counted as an omission.
        if (result.changes === 0) continue;

        typed++;
        titleIndex.set(normalizeTitleKey(fact.title), { id: fact.id, okf_type: normalized.okf_type });
        if (normalized.edges.length > 0) {
          pendingEdges.push({ sourceId: fact.id, sourceType: normalized.okf_type, edges: normalized.edges });
        }
      }

      // Two-phase: edges resolve only after every batch fact has its new type,
      // so intra-batch targets pass the target-type check.
      for (const item of pendingEdges) {
        edgesAdded += await ontologyService.resolveAndPersistEdges(
          entityId, item.sourceId, item.sourceType, item.edges, manifest, titleIndex, tx, now,
        );
      }

      await this.entryRepo.markOntologyChecked(batch.map(f => f.id), entityId, now, tx);
    });

    if (abortedOntologyOff) {
      // Mirror the mode === 'off' early path: remaining stays 0 so a host
      // convergence loop (while remaining > 0) still terminates.
      const counts = await this.entryRepo.countUntypedByEntityId(entityId, recheckCutoff);
      return { ...zeroed, remaining: 0, deferred: counts.deferred };
    }

    this.searchService.evictCache(entityId);

    const counts = await this.entryRepo.countUntypedByEntityId(entityId, recheckCutoff);
    return { scanned: batch.length, typed, failedValidation, edgesAdded, remaining: counts.eligible, deferred: counts.deferred };
  }

  private _validatePruneDuration(value: number | null | undefined, name: string): void {
    if (value !== null && value !== undefined && (typeof value !== 'number' || !isFinite(value) || value < 0)) {
      throw new Error(`Invalid ${name}: must be a non-negative finite number or null`);
    }
  }

  private _sanitizeRankerError(err: unknown): Error {
    return sanitizeRankerError(err, this.options.sanitizeRankerErrors);
  }
}
