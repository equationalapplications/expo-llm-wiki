import { parseJsonResponse, validateFact, validateTask, titleTokens, jaccardScore, normalizeSourceRef, normalizeSourceHash } from '../utils/pure';
import type { PromptService } from './PromptService';
import { generateId } from '../utils/ids';
import { parseEmbedding } from '../utils/embedding';
import { PrunePartialFailureError } from '../types';
import { HOOK_TIMEOUT_MARKER } from '../types';
import type { WikiOptions, ExtractedFact, ExtractedTask, WikiFact, WikiTask } from '../types';
import type { SQLiteAdapter } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { TaskRepository } from '../repositories/TaskRepository';
import type { EventRepository } from '../repositories/EventRepository';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import type { SearchService } from './SearchService';
import type { JobManager } from './JobManager';
import type { EmbeddingService } from './EmbeddingService';

const FUZZY_THRESHOLD = 0.5;
const MIN_TOKENS_TO_QUALIFY = 3;

export class MaintenanceService {
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
    private promptService: PromptService,
  ) {}

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

    const { systemPrompt, userPrompt } = this.promptService.buildLibrarianPrompt(
      events.reverse(),
      currentFacts,
      promptOverride,
    );

    const responseText = await this.options.llmProvider.generateText({ systemPrompt, userPrompt });

    const result = parseJsonResponse<{ facts: ExtractedFact[], tasks: ExtractedTask[] }>(responseText);
    const facts = Array.isArray(result.facts) ? result.facts : [];
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];

    const validFacts = facts.map(validateFact).filter((f): f is ExtractedFact => f !== null);
    const validTasks = tasks.map(validateTask).filter((t): t is ExtractedTask => t !== null);

    const now = Date.now();
    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];

    await this.db.withTransactionAsync(async (tx) => {
      const factsForDedupe = await this.entryRepo.findRecentByEntityId(entityId, 100, tx);

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

        const id = generateId('fact_');
        const factObj: WikiFact = {
          id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
          source_type: 'librarian_inferred', source_hash: null, source_ref: null,
          created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
        };

        await this.entryRepo.upsert(factObj, tx);
        insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
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

    await this.db.withTransactionAsync(async (tx) => {
      if (orphanAfterDays !== null) {
        const orphanThreshold = now - (orphanAfterDays * MS_PER_DAY);
        await this.entryRepo.markOrphaned(entityId, orphanThreshold, tx);
      }
      if (staleInferredAfterDays !== null) {
        const staleThreshold = now - (staleInferredAfterDays * MS_PER_DAY);
        await this.entryRepo.downgradeStaleInferred(entityId, staleThreshold, tx);
      }
    });

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

    const safeDowngraded = downgraded.filter(id => mutableIds.has(id));
    const safeDeleted = deleted.filter(id => mutableIds.has(id));
    const validNewFacts = newFacts.map(validateFact).filter((f): f is ExtractedFact => f !== null);

    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
    const uniqueDeletedFactIds = Array.from(new Set(safeDeleted));

    await this.db.withTransactionAsync(async (tx) => {
      await this.entryRepo.downgradeByIds(safeDowngraded, entityId, tx);
      await this.entryRepo.softDeleteByIds(safeDeleted, entityId, tx);

      for (const fact of validNewFacts) {
        const id = generateId('fact_');
        const factObj: WikiFact = {
          id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
          source_type: 'librarian_inferred', source_hash: null, source_ref: null,
          created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
        };

        await this.entryRepo.upsert(factObj, tx);
        insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
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

  private _validatePruneDuration(value: number | null | undefined, name: string): void {
    if (value !== null && value !== undefined && (typeof value !== 'number' || !isFinite(value) || value < 0)) {
      throw new Error(`Invalid ${name}: must be a non-negative finite number or null`);
    }
  }

  private _sanitizeRankerError(err: unknown): Error {
    if (this.options.sanitizeRankerErrors === false) {
      return err instanceof Error ? err : new Error(String(err));
    }
    const typeName = err instanceof Error ? (err.constructor?.name ?? 'Error') : typeof err;
    const innerCause = err instanceof Error && err.cause !== undefined
      ? new Error(`Caused by: ${(err.cause as Error)?.constructor?.name ?? typeof err.cause}`)
      : undefined;

    const sanitized = new Error(
      `VectorRanker ${typeName} (message scrubbed for security)`,
      innerCause ? { cause: innerCause } : undefined,
    );
    sanitized.name = typeName;
    return sanitized;
  }
}
