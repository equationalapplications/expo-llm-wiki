import { parseJsonResponse, validateFact, validateTask, titleTokens, jaccardScore, normalizeSourceRef, normalizeSourceHash, sanitizeRankerError, safeErrorToString, safeSlice } from '../utils/pure';
import { normalizeTitleKey } from '../utils/ontology';
import { PromptService } from './PromptService';
import type { OntologyService, TitleIndexEntry } from './OntologyService';
import { generateId } from '../utils/ids';
import { parseEmbedding } from '../utils/embedding';
import { PrunePartialFailureError } from '../types';
import { HOOK_TIMEOUT_MARKER } from '../types';
import type { WikiOptions, ExtractedFact, ExtractedFactEdge, ExtractedTask, ExtractedFactWithOntology, WikiFact, WikiTask, OntologyUpdates, OntologyBackfillResult, HealResult, DegradedRecord } from '../types';
import type { SQLiteAdapter } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { SourceRefIndexRepository } from '../repositories/SourceRefIndexRepository';
import type { TaskRepository } from '../repositories/TaskRepository';
import type { EventRepository } from '../repositories/EventRepository';
import { entitySummaryMetaKey, type MetadataRepository } from '../repositories/MetadataRepository';
import type { SearchService } from './SearchService';
import type { JobManager } from './JobManager';
import type { EmbeddingService } from './EmbeddingService';
import { runBatched } from './BoundedLlmCall';
import {
  HEAL_ANCHORS_PER_CANDIDATE,
  HEAL_MAX_ANCHORS,
  HEAL_MAX_FACT_BODY_CHARS_L3,
  HEAL_MAX_TASKS,
} from '../utils/healConstants';

const FUZZY_THRESHOLD = 0.5;
const MIN_TOKENS_TO_QUALIFY = 3;

export const ONTOLOGY_BACKFILL_BATCH_SIZE = 25;
export const ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS = 40_000;
export const ONTOLOGY_BACKFILL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// Heal constants live in `utils/healConstants` so PromptService and
// MaintenanceService cannot drift apart on the anchor cap formula
// (spec: "values must match"). Re-exported here to preserve the existing
// `MaintenanceService.HEAL_*` public surface that index.ts and other
// downstream consumers already import.
export { HEAL_MAX_ANCHORS, HEAL_ANCHORS_PER_CANDIDATE, HEAL_MAX_FACT_BODY_CHARS_L3, HEAL_MAX_TASKS } from '../utils/healConstants';

/** Search hits requested before the immutable_document filter is applied.
 * Overfetched because the index holds every fact, not only anchors. */
const HEAL_ANCHOR_SEARCH_OVERFETCH = 4;

/** Input bound for heal, mirroring ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS.
 * Independent of output batching: a small number of dense facts is still trimmed. */
export const HEAL_MAX_PROMPT_CHARS = 40_000;

/**
 * Heal candidates fetched per pass. Bounds the pool runBatched draws from, not
 * the size of an individual LLM call — runBatched still packs ~10 candidates per
 * request and splits further on failure. At this default one pass costs roughly
 * 2-3 provider calls instead of an unbounded count (#67).
 */
export const HEAL_BATCH_SIZE = 25;

/** Cooldown before an already-healed fact is offered again. Matches ontology backfill. */
export const HEAL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** Attempts after which a fact is considered permanently un-embeddable. */
export const MAX_EMBED_ATTEMPTS = 5;
/** First retry delay after a recoverable embedding failure. */
export const EMBED_RETRY_BASE_MS = 60_000;
/** Upper bound on the exponential retry delay. */
export const EMBED_RETRY_CAP_MS = 24 * 60 * 60 * 1000;

/** Exponential backoff: base * 2^(attempts-1), capped. */
export function embedRetryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.trunc(attempts || 0));
  const delay = EMBED_RETRY_BASE_MS * Math.pow(2, n - 1);
  return Math.min(delay, EMBED_RETRY_CAP_MS);
}

export type ReembedDisposition = 'attempt' | 'defer' | 'permanent';

/**
 * Decide what to do with one candidate row. Pure: no DB, no clock.
 *
 * `float32_overflow` is terminal because it is deterministic arithmetic on the
 * same vector — retrying can only produce the same overflow.
 */
export function classifyReembedRow(
  row: {
    embedding_failed_at?: number | null;
    embedding_failure_kind?: string | null;
    embedding_attempts?: number | null;
  },
  now: number,
  force: boolean,
): ReembedDisposition {
  if (force) return 'attempt';

  const failedAt = row.embedding_failed_at;
  if (failedAt === null || failedAt === undefined) return 'attempt';

  if (row.embedding_failure_kind === 'float32_overflow') return 'permanent';

  const attempts = row.embedding_attempts ?? 0;
  if (attempts >= MAX_EMBED_ATTEMPTS) return 'permanent';

  return now - failedAt >= embedRetryDelayMs(attempts) ? 'attempt' : 'defer';
}

/** One parsed ontology-backfill response, paired with the facts that produced it. */
interface OntologyBackfillBatch {
  batch: WikiFact[];
  classifications: Array<{ id?: unknown; okf_type?: unknown; edges?: unknown }>;
  ontologyUpdates?: OntologyUpdates;
}

/** An immutable_document fact offered to heal purely for contradiction detection. */
type HealAnchor = { id: string; title: string; source_ref: string | null };

/** One parsed heal response, paired with the candidates that produced it. */
interface HealBatch {
  batch: WikiFact[];
  downgraded: string[];
  deleted: string[];
  newFacts: ExtractedFact[];
}

/**
 * Hard cap on skipped-item error text in the log. A provider response or
 * prompt artifact can carry a multi-MB message; one unbounded failure must
 * not flood stderr (or any downstream log-shipping pipeline) by being logged
 * once per skipped item.
 */
const SKIP_ERROR_LOG_CHARS = 4096;

/**
 * Stringify an unknown error from `RunBatchedArgs.onSkip` for the log.
 * Exported for unit testing only — callers must always treat the return
 * value as a bounded, log-safe string. Internal callers feed this through
 * `console.warn` from heal/ontology-backfill `onSkip` paths.
 *
 * The callback receives `unknown`, so the value is not guaranteed to be a
 * `WikiParseError` with a small `.message`; a raw provider stack, an HTTP
 * error object, or a `string` is all possible. `String(err)` on a plain object
 * uses `Object.prototype.toString` and stays small, but `JSON.stringify` is
 * needed to surface anything structured, and the output is bounded either
 * way so a degenerate payload cannot slip through.
 *
 * Implementation note: every coercion path delegates to `safeErrorToString`,
 * which guarantees a non-throwing string return via a static
 * `[unstringifiable error]` marker. The previous hand-rolled chain had a
 * hole — `JSON.stringify` throws and the `catch` then ran
 * `Object.prototype.toString.call(err)`, which itself can throw (a Proxy
 * whose `get` trap rejects every property access — including
 * `Symbol.toStringTag`). That throw escaped the function and rejected the
 * surrounding `runBatched` operation wholesale. `safeErrorToString` was
 * hardened against this exact path; reuse it.
 */
export const formatSkipError = (err: unknown): string => {
  // Two goals:
  //   1. Surface structured provider errors as JSON when present
  //      (e.g. `{code: 500, msg: 'oops'}` -> `"{"code":500,"msg":"oops"}"`).
  //   2. Never throw, regardless of what hostile value reaches us via
  //      `onSkip` (Symbol, function, throwing toString, Proxy rejecting
  //      property access, Error with bad message, etc).
  //
  // `safeErrorToString` is the hardened non-throwing helper; every path
  // either uses it directly or falls back to it. JSON.stringify failure
  // paths (throwing toJSON, circular structure, Proxy) all converge on
  // `safeErrorToString`, which itself wraps String() and
  // Object.prototype.toString.call() in nested try/catch.
  let base: string;
  // `err instanceof Error` invokes the `getPrototypeOf` trap on `err`. A
  // hostile Proxy (e.g. one passed through `onSkip` from a misbehaving
  // provider plugin) whose trap rejects would throw out of this function —
  // defeating the documented "never throw" contract. Treat the trap throw
  // as "not an Error" and fall through to the JSON.stringify / safeErrorToString
  // branch below.
  let isErrorLike = false;
  try {
    isErrorLike = err instanceof Error;
  } catch {
    // hostile Proxy whose getPrototypeOf trap rejects — fall through
  }
  if (isErrorLike || (typeof err !== 'object' && typeof err !== 'function')) {
    // Errors -> safeErrorToString (returns err.message verbatim, or .name,
    //   or '[Error]' for hostile Error subclasses)
    // Primitives (string, number, boolean, bigint, undefined, symbol) ->
    //   safeErrorToString (String() handles them all)
    base = safeErrorToString(err);
  } else {
    // null + plain objects + arrays -> try JSON.stringify to surface
    //   structure. `null` JSON-stringifies to 'null', `typeof null ===
    //   'object'` so it lands here safely.
    try {
      const json = JSON.stringify(err);
      base = typeof json === 'string' ? json : safeErrorToString(err);
    } catch {
      base = safeErrorToString(err);
    }
  }
  if (base.length > SKIP_ERROR_LOG_CHARS) {
    // safeSlice (from utils/pure) never splits a UTF-16 surrogate pair at the
    // cut boundary — a bare String.slice can, leaving a lone high surrogate
    // that renders as U+FFFD in the log line.
    const truncated = safeSlice(base, 0, SKIP_ERROR_LOG_CHARS);
    return `${truncated}…[+${base.length - SKIP_ERROR_LOG_CHARS} chars truncated]`;
  }
  return base;
};

export class MaintenanceService {
  private promptService: PromptService;

  constructor(
    private db: SQLiteAdapter,
    private prefix: string,
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private sourceRefIndexRepo: SourceRefIndexRepository,
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

  async runHeal(
    entityId: string,
    options?: { promptOverride?: string; batchSize?: number; bodyTruncationChars?: number },
  ): Promise<HealResult> {
    this.jobManager.acquireLock('heal', entityId);
    try {
      return await this.doRunHeal(entityId, options);
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

  async forget(
    entityId: string,
    params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean },
    opts?: { dryRun?: boolean },
  ): Promise<{ deleted: { entries: number; tasks: number }; metadataReset?: boolean }> {
    if (params.clearAll && (params.entryId !== undefined || params.taskId !== undefined || params.sourceRef !== undefined || params.sourceHash !== undefined)) {
      throw new Error('forget() clearAll is mutually exclusive with entryId, taskId, sourceRef, and sourceHash');
    }

    // Dry-run: read-only, no lock, no outbox events, no embedding hooks.
    if (opts?.dryRun === true) {
      return this.forgetDryRun(entityId, params);
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
          // Mirror the clearAll to source_ref_index so the post-clearAll state
          // has no live index rows for the entity. Hard-delete via the soft-delete
          // path keeps the CDC contract identical to entries (outbox events are
          // not fired for source_ref_index, so this is purely an internal
          // invariant cleanup).
          // TODO: add a bulk source_ref_index soft-delete once the v9 backfill
          // gap is closed; for now, leaving the rows in place is safe because
          // the partial UNIQUE index excludes deleted_at != NULL rows from
          // re-ingest — a re-ingest would correctly take ownership.
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
          // Soft-delete the source_ref_index row so a re-ingest of this
          // sourceRef+hash can take ownership. The pre-check at the start of
          // ingestDocument will now see no live ref and proceed. No-op when
          // the row is already soft-deleted or never existed.
          const sourceRefIndexPromise = sourceRef
            ? this.sourceRefIndexRepo.softDeleteByEntityAndSourceRef(entityId, sourceRef, tx).then(() => undefined)
            : null;

          const [entryResult, taskResult, refResult] = await Promise.all([
            entryPromise ?? Promise.resolve(false),
            taskDeletedPromise ?? Promise.resolve(false),
            refPromise ?? Promise.resolve(0),
            sourceRefIndexPromise ?? Promise.resolve(undefined),
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

      return params.clearAll
        ? { deleted: { entries: deletedEntries, tasks: deletedTasks }, metadataReset: true }
        : { deleted: { entries: deletedEntries, tasks: deletedTasks } };
    } finally {
      this.jobManager.releaseLock('forget', entityId);
    }
  }

  /**
   * Read-only dry-run preview of {@link forget}. Returns the same shape as a
   * real call would, without acquiring the lock, opening a transaction, staging
   * outbox events, or firing embedding hooks. Counts may be off-by-N during a
   * concurrent real forget — this is accepted, not considered a bug.
   *
   * `metadataReset` mirrors the real call: only `clearAll: true` returns true,
   * because only `clearAll` actually resets the metadata checkpoint.
   * `standard` (sourceRef/sourceHash) returns no metadataReset field, just like
   * the real call. `entryId`/`taskId` selectors are rejected with a clear error
   * (the spec keeps dry-run narrow).
   */
  private async forgetDryRun(
    entityId: string,
    params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean },
  ): Promise<{ deleted: { entries: number; tasks: number }; metadataReset?: boolean }> {
    // Note: the clearAll mutual-exclusion check is performed by the public
    // forget() before dispatching here. forgetDryRun is private and unreachable
    // for callers that violate that contract, so it does not re-validate.

    if (params.entryId !== undefined || params.taskId !== undefined) {
      throw new Error('forget({ dryRun: true }) does not support entryId/taskId selectors; use sourceRef/sourceHash or clearAll');
    }

    if (params.clearAll) {
      const entries = await this.entryRepo.countLiveByEntityId(entityId);
      const tasks = await this.taskRepo.countLiveByEntityId(entityId);
      return { deleted: { entries, tasks }, metadataReset: true };
    }

    const sourceRef = params.sourceRef !== undefined ? normalizeSourceRef(params.sourceRef) : null;
    if (params.sourceRef !== undefined && !sourceRef) throw new Error('Invalid sourceRef');

    const sourceHash = params.sourceHash !== undefined ? normalizeSourceHash(params.sourceHash) : null;
    if (params.sourceHash !== undefined && !sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

    // No source selectors supplied: the real call is a no-op (softDeleteBySource
    // is gated on `if (sourceRef || sourceHash)`). Mirror that — do NOT count all
    // live entries, which would silently mask a caller bug as a large blast radius.
    if (sourceRef === null && sourceHash === null) {
      return { deleted: { entries: 0, tasks: 0 } };
    }

    const entries = await this.entryRepo.countLiveBySource(entityId, sourceRef, sourceHash);
    return { deleted: { entries, tasks: 0 } };
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
        const normalized = this.ontologyService?.validateAndNormalizeFact(ontologyFact, manifest, { strict: false })
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

  /**
   * Core heal pass (locks handled by {@link runHeal}). Package-internal orchestration hook.
   *
   * Bounded: at most `batchSize` candidates per pass (#67). Loop on
   * `result.remaining > 0` for convergence — see {@link HealResult.remaining}
   * for what convergence means here.
   */
  async doRunHeal(
    entityId: string,
    options?: {
      promptOverride?: string;
      batchSize?: number;
      bodyTruncationChars?: number;
    },
  ): Promise<HealResult> {
    const promptOverride = options?.promptOverride;
    const batchSize = options?.batchSize ?? HEAL_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('Invalid batchSize: must be an integer >= 1');
    }

    const bodyTruncationChars = options?.bodyTruncationChars ?? HEAL_MAX_FACT_BODY_CHARS_L3;
    if (!Number.isInteger(bodyTruncationChars) || bodyTruncationChars < 1) {
      throw new Error('Invalid bodyTruncationChars: must be an integer >= 1');
    }

    const now = Date.now();
    const recheckCutoff = now - HEAL_RECHECK_MS;
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
    // The SQL passes below mutate rows before candidates are even selected, so
    // their ids are folded into the HealResult counters — otherwise a pass that
    // soft-deletes 50 orphans but offers no candidates reports `deleted: 0`.
    const staleDowngradedIds: string[] = [];

    await this.db.withTransactionAsync(async (tx) => {
      if (orphanAfterDays !== null) {
        const orphanThreshold = now - (orphanAfterDays * MS_PER_DAY);
        orphanedIds.push(...await this.entryRepo.markOrphaned(entityId, orphanThreshold, tx));
      }
      if (staleInferredAfterDays !== null) {
        const staleThreshold = now - (staleInferredAfterDays * MS_PER_DAY);
        staleDowngradedIds.push(...await this.entryRepo.downgradeStaleInferred(entityId, staleThreshold, tx));
      }
    });

    for (const factId of orphanedIds) {
      try {
        await this.embeddingService.notifyEmbeddingPersisted(entityId, factId, null);
      } catch (hookErr) {
        console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during heal orphan pass for ${factId}:`, hookErr);
      }
    }

    const healCandidates = await this.entryRepo.findHealCandidatesByEntityId(entityId, batchSize, recheckCutoff);
    if (healCandidates.length === 0) {
      // The orphan/stale SQL passes above may still have mutated rows, so the
      // search index sync must happen before returning — it did today, after
      // runBatched no-oped on an empty candidate list.
      await this.searchService.sync(entityId);
      this.searchService.evictCache(entityId);
      const counts = await this.entryRepo.countHealCandidatesByEntityId(entityId, recheckCutoff);
      return {
        scanned: 0,
        downgraded: staleDowngradedIds.length,
        deleted: orphanedIds.length,
        newFactsCreated: 0,
        skipped: [], degraded: [], remaining: counts.eligible, deferred: counts.deferred,
      };
    }
    // Cap applied once at fetch time. The bound is the one remaining
    // unbounded input to the heal prompt (#101's L0 fix). AllTasks is
    // entity-global; we don't re-fetch per level. L1+ levels omit the
    // array via buildHealPrompt's level logic.
    const allTasks = await this.taskRepo.findAllPending([entityId], HEAL_MAX_TASKS);
    const recentEvents = await this.eventRepo.getRecent(entityId, 20);

    const toPromptShape = (f: WikiFact) => {
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      return { ...rest, tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags };
    };

    // Anchor selection costs a keyword search plus a repository read, and
    // runBatched calls buildPrompt more than once per batch it actually sends —
    // while trimming to maxPromptChars, and again for each half when a batch is
    // split. Prefixes recur heavily across those paths, so memoizing by the
    // query the batch produces collapses the repeats. Scoped to this pass: the
    // index and the anchor rows can both change between heal runs.
    const anchorCache = new Map<string, HealAnchor[]>();

    // Captured in the doRunHeal scope so the buildPrompt lambda can push
    // L3 truncation records into it. Reconcile after runBatched returns:
    // any record whose id also ended up in outcome.skipped is a
    // contradiction (degraded = healed, skipped = dropped) and is dropped.
    // The post-reconcile log line fires for the survivors only.
    const degraded: DegradedRecord[] = [];

    const outcome = await runBatched<WikiFact, HealBatch>({
      items: healCandidates,
      buildPrompt: async (batch, attemptLevel = 0) => {
        const documentAnchors = await this._selectHealAnchors(
          entityId,
          batch,
          // Per-batch anchor cap: `batch.length * HEAL_ANCHORS_PER_CANDIDATE` (capped at
          // HEAL_MAX_ANCHORS) right-sizes the anchor lookup so a 1-fact batch does
          // not overfetch the same 200 keyword hits a 25-fact batch once did.
          // buildHealPrompt applies the matching cap on its side — values must match.
          Math.min(HEAL_MAX_ANCHORS, batch.length * HEAL_ANCHORS_PER_CANDIDATE),
          anchorCache,
        );
        const { prompts, degraded: batchDegraded } = await this.promptService.buildHealPrompt(
          batch.map(toPromptShape),
          documentAnchors,
          allTasks,
          recentEvents,
          promptOverride,
          attemptLevel,
          bodyTruncationChars,
        );
        // L0 calls (including trim's speculatives) return degraded: [].
        // Only L3 real attempts can push here.
        degraded.push(...batchDegraded);
        return prompts;
      },
      call: (prompts) => this.options.llmProvider.generateText(prompts),
      parse: (responseText, batch) => {
        const result = parseJsonResponse<{ downgraded: string[], deleted: string[], newFacts: ExtractedFact[] }>(responseText);
        return {
          batch,
          downgraded: Array.isArray(result.downgraded) ? result.downgraded : [],
          deleted: Array.isArray(result.deleted) ? result.deleted : [],
          newFacts: Array.isArray(result.newFacts) ? result.newFacts : [],
        };
      },
      maxOutputTokens: this.options.llmProvider.maxOutputTokens,
      maxPromptChars: HEAL_MAX_PROMPT_CHARS,
      onSkip: (fact, err) => {
        console.warn(
          `[WikiMemory] heal skipped ${entityId}/${fact.id}: response could not be bounded: ${formatSkipError(err)}`,
        );
      },
    });

    // The mutable-ids guard is per batch: the model may only act on the
    // candidates it was actually offered in the call that produced the output.
    const safeDowngradedSet = new Set<string>();
    const safeDeletedSet = new Set<string>();
    const newFacts: ExtractedFact[] = [];

    for (const batchResult of outcome.results) {
      const mutableIds = new Set(batchResult.batch.map(f => f.id));
      for (const id of batchResult.downgraded) if (mutableIds.has(id)) safeDowngradedSet.add(id);
      for (const id of batchResult.deleted) if (mutableIds.has(id)) safeDeletedSet.add(id);
      newFacts.push(...batchResult.newFacts);
    }

    const safeDowngraded = Array.from(safeDowngradedSet);
    const safeDeleted = Array.from(safeDeletedSet);
    const validNewFacts = newFacts.map(validateFact).filter((f): f is ExtractedFact => f !== null);

    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
    const uniqueDeletedFactIds = Array.from(new Set(safeDeleted));

    // Full-breadth, independent of batchSize. Seeding from healCandidates would
    // shrink dedupe to a batchSize window, letting a synthesized fact that
    // duplicates a librarian_inferred fact outside the window pass the Jaccard
    // check — and a convergence loop would then multiply those duplicates.
    //
    // Read inside the transaction, after softDeleteByIds. The query filters
    // deleted_at IS NULL, so rows this pass retires leave the corpus naturally
    // — no explicit safeDeletedSet filter needed. Ordering is load-bearing:
    // the read must follow softDeleteByIds, or a delete-plus-restate (heal's
    // normal output shape) would match the replacement against the row it
    // replaces, drop the replacement, and leave the fact gone entirely (#68).
    // Reading inside the transaction also closes the race with concurrent
    // librarian passes (#69): withSerializedTransactions ensures a librarian
    // transaction either commits entirely before this transaction begins or
    // entirely after it ends, so there is no interleaving point at which a
    // librarian insert could land unseen.
    await this.db.withTransactionAsync(async (tx) => {
      await this.entryRepo.downgradeByIds(safeDowngraded, entityId, tx);
      await this.entryRepo.softDeleteByIds(safeDeleted, entityId, tx);

      const healFactsForDedupe: Array<{ id: string; title: string }> =
        await this.entryRepo.findInferredTitlesByEntityId(entityId, tx);

      for (const fact of validNewFacts) {
        const newTokens = titleTokens(fact.title);
        let skip = false;

        if (newTokens.size >= MIN_TOKENS_TO_QUALIFY) {
          for (const existing of healFactsForDedupe) {
            // The query already restricts to librarian_inferred, so the
            // projected { id, title } rows carry everything the check needs.
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
        healFactsForDedupe.push({ id, title: fact.title });
      }

      // Every candidate offered this pass is stamped, whether it landed in a
      // successful batch or in outcome.skipped: otherwise skipped facts stay at
      // the head of the updated_at ASC queue and starve everything behind them.
      // Facts heal just created are stamped too — without this each synthesized
      // fact is immediately an eligible candidate again and a host
      // `while (remaining > 0)` loop feeds on heal's own output.
      //
      // Transient-error ids (`reason: 'call_error'` from the runBatched helper,
      // added in Revision 1 of the ladder spec) are excluded from the stamp:
      // a momentary provider hiccup would otherwise lock a fact out of heals
      // for the full HEAL_RECHECK_MS window. The fact is reattempted as soon
      // as the host's scheduler runs heal again — `markHealChecked` skips
      // soft-deleted rows above, which is also correct (a deleted row is not
      // a candidate under any future pass).
      const callErrorIds = new Set(
        outcome.skipped.filter((s) => s.reason === 'call_error').map((s) => s.item.id),
      );
      await this.entryRepo.markHealChecked(
        [
          ...healCandidates.map((f) => f.id).filter((id) => !callErrorIds.has(id)),
          ...insertedFacts.map((f) => f.id),
        ],
        entityId,
        now,
        tx,
      );
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

    // Reconcile: a degraded record for an id in outcome.skipped is a
    // contradiction (degraded = healed, skipped = dropped). Drop the
    // contradiction. The reconciliation makes the two arrays mutually
    // exclusive on id, which is the contract HealResult promises.
    const skippedIds = new Set(outcome.skipped.map(({ item }) => item.id));
    const healedDegraded = degraded.filter((d) => !skippedIds.has(d.id));

    // Post-reconcile log. A naive implementation that logs inside the
    // buildPrompt lambda would emit this warning for facts whose L3
    // attempt still failed; that warning is a property of the log
    // stream, not just the data shape, and the test suite locks it.
    for (const d of healedDegraded) {
      console.warn(
        `[WikiMemory] heal healed under degraded context ${entityId}/${d.id}: ` +
        `body truncated from ${d.originalBodyChars} to ${d.truncatedBodyChars} chars`,
      );
    }

    // Skipped candidates were sent to the provider too — they just came back
    // unusable, possibly after being split down to a batch of one. Counting
    // only successful batches would under-report provider exposure, which is
    // the number this field exists to report.
    let scanned = outcome.skipped.length;
    for (const batchResult of outcome.results) scanned += batchResult.batch.length;

    // Union rather than sum: the orphan pass runs before candidate selection so
    // its ids cannot also be model-deleted, but a fact the stale pass downgraded
    // can be downgraded again by the model in the same pass.
    const allDowngraded = new Set([...staleDowngradedIds, ...safeDowngraded]);
    const allDeleted = new Set([...orphanedIds, ...uniqueDeletedFactIds]);

    const counts = await this.entryRepo.countHealCandidatesByEntityId(entityId, recheckCutoff);
    return {
      scanned,
      downgraded: allDowngraded.size,
      deleted: allDeleted.size,
      newFactsCreated: insertedFacts.length,
      skipped: outcome.skipped.map(({ item, reason }) => ({ id: item.id, reason })),
      degraded: healedDegraded,
      remaining: counts.eligible,
      deferred: counts.deferred,
    };
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
    const zeroed = { scanned: 0, typed: 0, failedValidation: 0, edgesAdded: 0, skipped: 0 };

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
    // starve it (spec Decision 2). Output size is bounded separately, by
    // runBatched — the two bounds are independent and both enforced.
    const toPromptShape = (f: WikiFact) => ({ id: f.id, title: f.title, body: f.body, tags: f.tags });
    const buildPrompt = (facts: WikiFact[]) => this.promptService.buildOntologyBackfillPrompt(
      facts.map(toPromptShape),
      options?.promptOverride,
      ontologyContext,
    );

    const outcome = await runBatched<WikiFact, OntologyBackfillBatch>({
      items: candidates,
      buildPrompt,
      call: (prompts) => this.options.llmProvider.generateText(prompts),
      parse: (responseText, batch) => {
        const parsed = parseJsonResponse<{
          classifications?: Array<{ id?: unknown; okf_type?: unknown; edges?: unknown }>;
          ontology_updates?: OntologyUpdates;
        }>(responseText);
        return {
          batch,
          classifications: Array.isArray(parsed.classifications) ? parsed.classifications : [],
          ontologyUpdates: parsed.ontology_updates,
        };
      },
      maxOutputTokens: this.options.llmProvider.maxOutputTokens,
      maxPromptChars: ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS,
      onSkip: (fact, err) => {
        console.warn(
          `[WikiMemory] ontology backfill skipped ${entityId}/${fact.id}: response could not be bounded: ${formatSkipError(err)}`,
        );
      },
    });

    let typed = 0;
    let failedValidation = 0;
    let edgesAdded = 0;
    let scanned = 0;
    let abortedOntologyOff = false;

    for (const batchResult of outcome.results) {
      const applied = await this._applyOntologyBackfillBatch(entityId, batchResult, now);
      if (applied.abortedOntologyOff) {
        abortedOntologyOff = true;
        break;
      }
      typed += applied.typed;
      failedValidation += applied.failedValidation;
      edgesAdded += applied.edgesAdded;
      scanned += batchResult.batch.length;
    }

    if (abortedOntologyOff) {
      // remaining stays 0 so a host convergence loop (while remaining > 0)
      // still terminates, mirroring the mode === 'off' early path.
      //
      // The counters are NOT zeroed. A pass is now many transactions, so
      // batches applied before the flip are already committed — facts typed,
      // edges persisted, cooldowns stamped. Reporting zeros here would tell the
      // caller nothing happened while the database says otherwise. Only the
      // aborting batch and everything after it are dropped, and those wrote
      // nothing: the abort check runs before any write in the batch's
      // transaction.
      const counts = await this.entryRepo.countUntypedByEntityId(entityId, recheckCutoff);
      return {
        scanned,
        typed,
        failedValidation,
        edgesAdded,
        skipped: outcome.skipped.length,
        remaining: 0,
        deferred: counts.deferred,
      };
    }

    // Skipped facts get the same cooldown stamp as processed ones — except
    // transient-error ids (`reason: 'call_error'` from the runBatched helper,
    // added in Revision 1 of the ladder spec), which are excluded so a
    // momentary provider hiccup doesn't lock them out of backfill for a full
    // ONTOLOGY_BACKFILL_RECHECK_MS window. Without the stamp on the non-
    // transient cases, those would stay at the head of the updated_at ASC
    // queue and every later pass would re-attempt them first, starving
    // everything behind them.
    if (outcome.skipped.length > 0) {
      const callErrorIds = new Set(
        outcome.skipped.filter((s) => s.reason === 'call_error').map((s) => s.item.id),
      );
      await this.entryRepo.markOntologyChecked(
        outcome.skipped
          .filter(({ item }) => !callErrorIds.has(item.id))
          .map(({ item }) => item.id),
        entityId,
        now,
        this.db,
      );
    }

    this.searchService.evictCache(entityId);

    const counts = await this.entryRepo.countUntypedByEntityId(entityId, recheckCutoff);
    return {
      scanned,
      typed,
      failedValidation,
      edgesAdded,
      skipped: outcome.skipped.length,
      remaining: counts.eligible,
      deferred: counts.deferred,
    };
  }

  /**
   * Applies one parsed backfill batch in its own transaction. Per-batch rather
   * than one transaction for the pass, so mergeEmergentUpdates semantics and
   * the mid-flight `mode === 'off'` abort check keep the shape they had when a
   * pass was a single call.
   */
  private async _applyOntologyBackfillBatch(
    entityId: string,
    batchResult: OntologyBackfillBatch,
    now: number,
  ): Promise<{ typed: number; failedValidation: number; edgesAdded: number; abortedOntologyOff: boolean }> {
    const ontologyService = this.ontologyService!;
    const { batch, classifications, ontologyUpdates } = batchResult;

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

      if (txMode === 'emergent' && ontologyUpdates) {
        manifest = await ontologyService.mergeEmergentUpdates(entityId, ontologyUpdates, tx);
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
          { strict: false },
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

    return { typed, failedValidation, edgesAdded, abortedOntologyOff };
  }

  private _validatePruneDuration(value: number | null | undefined, name: string): void {
    if (value !== null && value !== undefined && (typeof value !== 'number' || !isFinite(value) || value < 0)) {
      throw new Error(`Invalid ${name}: must be a non-negative finite number or null`);
    }
  }

  /**
   * Anchors relevant to one batch of heal candidates.
   *
   * Heal used to pass every immutable_document fact for the entity — 2560 rows
   * against 31 candidates on the corpus behind #63 — which is what blew the
   * output ceiling. Anchors are now retrieved by keyword relevance to the batch
   * and capped.
   *
   * The MiniSearch index holds all facts, not only anchors, so hits are
   * overfetched and the source_type restriction is applied after retrieval, in
   * SQL. Search rank order is preserved through the filter.
   *
   * Accepted tradeoff: an anchor that contradicts a candidate while sharing no
   * vocabulary with it is now missed. Exhaustive-but-broken traded for
   * relevance-scoped-and-working.
   *
   * `cache` is keyed by the derived query rather than by the batch, so two
   * batches that reduce to the same query share one lookup. Caller-owned and
   * per-pass — see the call site in doRunHeal.
   */
  private async _selectHealAnchors(
    entityId: string,
    batch: WikiFact[],
    cap: number = HEAL_MAX_ANCHORS,
    cache?: Map<string, HealAnchor[]>,
  ): Promise<HealAnchor[]> {
    const query = batch.map(f => f.title).join(' ').trim();
    if (!query) return [];

    const cached = cache?.get(query);
    if (cached) return cached;

    // Overfetch is sized off the cap we were given, not the global max —
    // a single-candidate query asks for fewer search hits.
    const hits = this.searchService.searchKeyword(
      query,
      [entityId],
      cap * HEAL_ANCHOR_SEARCH_OVERFETCH,
    );
    const hitIds = hits.map(h => h.id as string);

    const anchors: HealAnchor[] = [];
    if (hitIds.length > 0) {
      const rows = await this.entryRepo.findAnchorRowsByIds(entityId, hitIds);
      const byId = new Map(rows.map(r => [r.id, r]));

      for (const id of hitIds) {
        const row = byId.get(id);
        if (!row) continue;
        anchors.push(row);
        if (anchors.length >= cap) break;
      }
    }

    // Cached even when empty: a query that matched nothing still cost a search,
    // and the trim and split paths will ask for it again.
    cache?.set(query, anchors);
    return anchors;
  }

  private _sanitizeRankerError(err: unknown): Error {
    return sanitizeRankerError(err, this.options.sanitizeRankerErrors);
  }
}
