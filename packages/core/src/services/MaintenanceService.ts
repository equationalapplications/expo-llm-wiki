import { parseJsonResponse, validateFact, validateTask, titleTokens, jaccardScore, normalizeSourceRef, normalizeSourceHash, sanitizeRankerError, safeErrorToString, safeSlice, withConcurrency, factRejectionReason, taskRejectionReason } from '../utils/pure';
import { resolveGrounding, checkGrounding, groundingOutcome } from '../utils/grounding';
import { normalizeTitleKey } from '../utils/ontology';
import { validateClassifierAnswer, classifierStateForFact, type ClassifierRejection } from '../utils/classifier';
import { DiagnosticBuffer, emitDiagnostic, edgeDropDiagnostic } from '../utils/diagnostics';
import type { EdgeDrop } from '../utils/ontology';
import { PromptService } from './PromptService';
import { buildTitleCatalogBlock } from '../prompts';
import { HISTORY_MAX_DEPTH } from './TemporalService';

const CHAIN_TRUNCATED_NOTICE = `includeChain walk stopped at the depth cap (${HISTORY_MAX_DEPTH} links per direction); the chain is longer than the ids listed. Run forget again on a remaining chain id to continue.`;
import type { OntologyService, TitleIndexEntry } from './OntologyService';
import { generateId } from '../utils/ids';
import { resolveLibrarianStrategy, resolveMaintenanceMode } from '../utils/engineDefaults';
import { parseEmbedding } from '../utils/embedding';
import { PrunePartialFailureError, WikiBusyError } from '../types';
import { WikiExternalDeletionError } from '../types';
import { removalGate, type VectorRemovalService } from './VectorRemovalService';
import type { VectorRemovalRepository } from '../repositories/VectorRemovalRepository';
import type { WikiOptions, ExtractedFact, ExtractedFactEdge, ExtractedTask, ExtractedFactWithOntology, WikiFact, WikiTask, OntologyUpdates, OntologyBackfillResult, HealResult, DegradedRecord, ReembedResult, ClassifierQuestion, ClassifyResponse, OntologyManifest, WikiDiagnosticTrigger } from '../types';
import type { SQLiteAdapter, ForgetParams, ForgetResult } from '../types';
import { EdgeRepository } from '../repositories/EdgeRepository';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { SourceRefIndexRepository } from '../repositories/SourceRefIndexRepository';
import type { TaskRepository } from '../repositories/TaskRepository';
import type { EventRepository } from '../repositories/EventRepository';
import { anchorAtLegacyBoundary, seedLegacyWatermark } from './legacyWatermark';
import { CheckpointIncompleteError, entitySummaryMetaKey, START_OF_LOG_WATERMARK, type LibrarianWatermark, type MetadataRepository } from '../repositories/MetadataRepository';
import type { SearchService } from './SearchService';
import type { JobManager } from './JobManager';
import type { EmbeddingService } from './EmbeddingService';
import { runBatched, isContextOverflowError } from './BoundedLlmCall';
import { resetNormalizeWatermarks } from '../db/sourceRefNormalize';
import { FTS5_RETIRED_TABLES_KEY, FTS5_STATE_KEY, isRetiredTableName, fts5LedgerDropSql, passageFtsTriggerNames } from './search/fts5Sql';
import { restartRebuildAfterVacuum } from './search/fts5Progress';
import type { BuiltPrompt } from './BoundedLlmCall';
import { callLlm, callClassify } from '../utils/llmCall';
import { WikiBudgetExhausted, UsageMeter } from '../utils/usage';
import {
  HEAL_ANCHORS_PER_CANDIDATE,
  HEAL_MAX_ANCHORS,
  HEAL_MAX_FACT_BODY_CHARS_L3,
  HEAL_MAX_TASKS,
} from '../utils/healConstants';
import { FUZZY_THRESHOLD, MIN_TOKENS_TO_QUALIFY } from './librarian/constants';
import { runLibrarianStrategy, type LibrarianContext, type LibrarianResult } from './librarian';

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
type HealAnchor = { id: string; title: string; source_ref: string | null; body?: string; lifecycle_status?: string };

/** One parsed heal response, paired with the candidates that produced it. */
interface HealBatch {
  batch: WikiFact[];
  downgraded: string[];
  deleted: string[];
  newFacts: ExtractedFact[];
  /** Corpus of the prompt that produced this response; null when heal is not a grounding writer. */
  corpus: string[] | null;
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

/** Report of the erase core (steps 0/1/1b); T6 extends it with the file steps. */
export interface EraseReport {
  /** True only when every step ran and the pragma read back ON. */
  verified: boolean;
  /** `PRAGMA secure_delete` as read back on the connection (1 = ON). */
  secureDelete: number | null;
  sqliteVersion: string;
  /** Entities step 1 enumerated. */
  entities: string[];
  /** External-removal holds, per entity (event-retention holds cannot arise: events are kept). */
  holds: Array<{ entityId: string; deleted: number; deletedTasks: number; failedAt: string; remaining: number }>;
  /** Entities skipped because their per-entity prune lock was busy. */
  skipped: string[];
  /** Superset of the hard-deleted entry ids, for the step-6 index sync (containment, not equality). */
  syncedIds: string[];
  registrySweep: { skipped: boolean; deleted: number };
  /** Retired FTS tables left listed (module-less runtime): shadow tables emptied, DROP deferred to an FTS5-capable open. */
  retiredUndroppable: string[];
  /** FTS5 orphan surfaces cleared (Path A/C) or dropped (Path B) by the step-3 remediation (specs/erase-fts-remediation D3). Names are recorded only after the owning transaction commits. */
  ftsOrphansCleared: string[];
  failedStep: 'secure_delete' | 'vacuum' | 'checkpoint' | 'prune' | 'registry_sweep' | 'passage_drain' | 'retired_reclaim' | 'index_sync' | 'optimize' | 'rebuild' | 'tombstone_gate' | 'fts_orphan_clear' | null;
  /** JS runtime the erase ran on (no overclaiming: this is not a storage-layer guarantee). */
  runtime: string;
  /** Every step's outcome, in execution order; a failed step is last. `partial` = ran with skipped entities or holds, or was skipped by design (`registry_sweep` on a pre-v9 store; `tombstone_gate` when holds/skips already account for surviving rows). */
  steps: Array<{ step: string; outcome: 'ok' | 'partial' | 'failed' }>;
}

function eraseRuntime(): string {
  const g = globalThis as { HermesInternal?: unknown; process?: { versions?: { node?: string } } };
  if (g.process?.versions?.node) return `node ${g.process.versions.node}`;
  return g.HermesInternal ? 'hermes' : 'unknown';
}

/** A failed erase step: carries the partial report (`verified: false`). */
export class EraseStepError extends Error {
  constructor(readonly code: string, message: string, readonly report: EraseReport, cause?: unknown) {
    super(message);
    this.name = 'EraseStepError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

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
    edgeRepo?: EdgeRepository,
    private vectorRemoval?: VectorRemovalService,
    private vectorRemovalRepo?: VectorRemovalRepository,
  ) {
    // Fallback for direct instantiation outside WikiMemory facade (e.g. isolated tests).
    this.promptService = promptService ?? new PromptService(this.options.config?.prompts, resolveGrounding(this.options.config?.grounding));
    this.edgeRepo = edgeRepo ?? new EdgeRepository(this.db, this.prefix);
  }

  private edgeRepo: EdgeRepository;

  async runPrune(entityId: string, options?: { retainSoftDeletedFor?: number | null; retainEventsFor?: number | null; vacuum?: boolean; syncedIds?: string[] }): Promise<{ entries: number; tasks: number; events: number }> {
    return this._runPrune(entityId, options, 'host');
  }

  /**
   * Shared prune body. `owner: 'erase'` lets erase()'s own per-entity prune
   * through the universal erase fence in JobManager; the public `runPrune`
   * always passes `'host'`.
   */
  private async _runPrune(
    entityId: string,
    options: { retainSoftDeletedFor?: number | null; retainEventsFor?: number | null; vacuum?: boolean; syncedIds?: string[]; softDeletedCutoff?: number | 'all' } | undefined,
    owner: 'host' | 'erase',
  ): Promise<{ entries: number; tasks: number; events: number }> {
    this.jobManager.acquireLock('prune', entityId, undefined, owner);

    try {
      const retainSoftDeletedFor = options?.retainSoftDeletedFor !== undefined ? options.retainSoftDeletedFor : (this.options.config?.pruneRetainSoftDeletedFor ?? 7);
      const retainEventsFor = options?.retainEventsFor !== undefined ? options.retainEventsFor : (this.options.config?.pruneEventsAfter ?? 30);
      const vacuum = options?.vacuum ?? false;

      this._validatePruneDuration(retainSoftDeletedFor, 'retainSoftDeletedFor');
      this._validatePruneDuration(retainEventsFor, 'retainEventsFor');
      const pruneSupersededAfter = this.options.config?.pruneSupersededAfter ?? null;
      this._validatePruneDuration(pruneSupersededAfter, 'pruneSupersededAfter');

      // Spec durable-vector-removal §5.6.7: a bad deletionHookTimeoutMs fails
      // before any write.
      const gate = removalGate(this.options);
      if (gate === 'hook') this.embeddingService.validateDeletionTimeout();

      const now = Date.now();
      // The full-entity rebuild is deferred until the touched-id set is known:
      // prune always knows exactly which rows it removed, so the index update
      // is O(touched) instead of O(entity) (spec 2026-09-28
      // maintenance-incremental-sync §2.2).
      let syncedIds: string[] = [];
      let deletedEntries = 0;
      let deletedTasks = 0;
      let deletedEvents = 0;
      let prunePartial: { failedAt: string; remaining: number; cause: Error } | null = null;

      // Spec §4.4 / §10.10: expired and superseded history is soft-deleted
      // here; the soft-delete retention below (on a later run) hard-deletes
      // it through the embedding-hook path. Off by default.
      if (pruneSupersededAfter !== null) {
        const expiredCutoff = now - pruneSupersededAfter * 86400000;
        const expiredIds = await this.entryRepo.findExpiredIds(entityId, expiredCutoff);
        if (expiredIds.length > 0) {
          await this.db.withTransactionAsync(async (tx) => {
            await this.entryRepo.softDeleteByIds(expiredIds, entityId, tx);
          });
          syncedIds = [...expiredIds];
          // The trigger enqueued them; send removal now, not 7 days later
          // (spec durable-vector-removal §5.6.1). A failure leaves them
          // pending (with hook_failed / external_deletion_pending, as on every
          // other post-commit path), and the hard-delete step below keeps them.
          if (this.vectorRemoval && await this.vectorRemoval.ledgerPresent()) {
            await this.vectorRemoval.deliverRemovals(entityId, expiredIds, 'prune', 'call', []);
          }
        }
      }

      if (retainSoftDeletedFor !== null) {
        // softDeletedCutoff: erase's override. 'all' means NO timestamp
        // predicate at all — a numeric cutoff (even MAX_SAFE_INTEGER) is still
        // a cutoff, and a tombstone above it (nanosecond-epoch exports) or a
        // TEXT-valued one (SQLite ranks TEXT above INTEGER) would escape the
        // walk and then fail the step-9 gate on every erase.
        const softDeletedAll = options?.softDeletedCutoff === 'all';
        const cutoff = softDeletedAll ? 0 : (options?.softDeletedCutoff as number) ?? now - retainSoftDeletedFor * 86400000;
        const entriesToDelete = await this.entryRepo.getPrunableMetadata(entityId, cutoff, undefined, { noCutoff: softDeletedAll });

        const prunableIds = entriesToDelete.map((r) => r.id);
        const vr = this.vectorRemoval;
        const vrRepo = this.vectorRemovalRepo;
        const ledgerOn = !!vr && !!vrRepo && await vr.ledgerPresent();
        // Spec durable-vector-removal §5.6: rows are hard-deleted only when
        // their removal is confirmed (hook) or the gate allows it.
        let deletable: string[] = prunableIds;
        let removeLedger = false;
        let kept: string[] = [];
        let timedOut = false;
        let cause: unknown;
        let firstFailed: string | undefined;
        let failedOrder: string[] = [];

        if (ledgerOn && vr && vrRepo) {
          if (gate === 'hook' && prunableIds.length > 0) {
            await this.db.withTransactionAsync(async (tx) => {
              await vrRepo.backstopEnqueue(entityId, prunableIds, now, tx);
            });
          }
          const result = prunableIds.length > 0
            ? await vr.drain({ entityId, ids: prunableIds })
            : { failedIds: [] as string[], timedOut: false, firstCause: undefined as unknown };
          if (gate === 'hook') {
            // The confirmed/pending split is read inside the delete
            // transaction below (rev 4), so a removal re-owed by an embed
            // that settles meanwhile keeps its fact.
            timedOut = result.timedOut;
            cause = result.firstCause;
            failedOrder = result.failedIds;
          } else if (gate === 'force') {
            removeLedger = true;
          } else {
            removeLedger = !(await vr.externalIndexInUse());
          }
        } else if (gate === 'hook') {
          // Store whose setup() never ran: no ledger table, so call the hook
          // per row and keep the rows that fail (mirrors forget's fallback).
          const r = await this.embeddingService.callRemovalHookEach(entityId, prunableIds);
          const failedSet = new Set(r.failed);
          kept = r.failed;
          deletable = prunableIds.filter((id) => !failedSet.has(id));
          timedOut = r.timedOut;
          cause = r.cause;
          firstFailed = kept[0];
        }

        // ids whose documents leave the index. Every pruned row was already
        // soft-deleted (and thus already absent from the live read), so this is
        // drift repair, not the primary removal mechanism — syncEntries still
        // discards each id before re-reading it, so a stale document left
        // behind by a path that never passed ids to syncEntries is scrubbed
        // here (§2.2).
        const hookLedger = ledgerOn && !!vrRepo && gate === 'hook';
        await this.db.withTransactionAsync(async (tx) => {
          if (hookLedger && vrRepo && prunableIds.length > 0) {
            const status = await vrRepo.statusFor(prunableIds, tx);
            deletable = prunableIds.filter((id) => status.get(id) !== 'pending');
            kept = prunableIds.filter((id) => status.get(id) === 'pending');
          }
          if (deletable.length > 0) {
            const deletedIds: string[] = [];
            deletedEntries = await this.entryRepo.bulkDeletePruned(entityId, cutoff, deletable, tx, { keepUnconfirmedRemovals: hookLedger, deletedIds, noCutoff: softDeletedAll });
            if (hookLedger) {
              // A removal re-owed inside this transaction (host raw SQL on the
              // shared connection) made the guard keep its fact: count it as
              // kept. An id skipped because it was restored or already gone
              // owes nothing, so it is neither deleted nor kept (spec rev 6).
              const gone = new Set(deletedIds);
              const skipped = deletable.filter((id) => !gone.has(id));
              if (skipped.length > 0) {
                const after = await vrRepo!.statusFor(skipped, tx);
                kept = [...kept, ...skipped.filter((id) => after.get(id) === 'pending')];
              }
              deletable = deletedIds;
            }
            if (vrRepo && ledgerOn) {
              // Hook: only confirmed rows of facts now gone. Force, or a store
              // that never had an index: every row. Hookless with the marker:
              // confirmed rows only; pending ones wait for a hook process.
              if (removeLedger) await vrRepo.deleteForFacts(entityId, deletable, tx, 'all');
              else await vrRepo.deleteForFacts(entityId, deletable, tx, 'confirmedGone');
            }
          }
          deletedTasks = await this.taskRepo.bulkDeletePruned(entityId, cutoff, tx, { noCutoff: softDeletedAll });
        });
        if (hookLedger) {
          const keptSet = new Set(kept);
          firstFailed = failedOrder.find((id) => keptSet.has(id)) ?? kept[0];
        }
        syncedIds = [...syncedIds, ...deletable];

        if (kept.length > 0) {
          if (timedOut) {
            prunePartial = { failedAt: firstFailed ?? kept[0], remaining: kept.length, cause: new Error('Deletion hook timed out') };
          } else if (cause === undefined) {
            prunePartial = { failedAt: firstFailed ?? kept[0], remaining: kept.length, cause: new Error('external removal not confirmed') };
          } else {
            prunePartial = { failedAt: firstFailed ?? kept[0], remaining: kept.length, cause: this._sanitizeRankerError(cause) };
          }
        }
      }

      if (retainEventsFor !== null) {
        const cutoff = now - retainEventsFor * 86400000;
        const guarded = resolveMaintenanceMode(this.options.config) === 'deferred' || resolveLibrarianStrategy(this.options.config) === 'ops';
        let wm: LibrarianWatermark | null = null;
        await this.db.withTransactionAsync(async (tx) => {
          if (guarded) {
            // Spec §6: under deferred/ops the librarian re-reads the event log,
            // so prune may only delete events the watermark has already passed.
            wm = await this.metadataRepo.getLibrarianWatermark(entityId, tx);
            deletedEvents = (await this.eventRepo.pruneThrough(entityId, cutoff, wm, tx)).changes;
          } else {
            deletedEvents = (await this.eventRepo.prune(entityId, cutoff, tx)).changes;
          }
          // memory_checkpoint and heal_checkpoint count the oldest events
          // already accounted for. Both prune queries delete a prefix of that
          // same order, so lower each count by what was deleted. Otherwise
          // memory points past unread events, and heal ends up above the
          // event count, reads as 0 and starts a full re-heal (spec
          // ops-auto-first-batch §4).
          if (deletedEvents > 0) {
            const cp = await this.metadataRepo.getCheckpoint(entityId, tx);
            const updates: { memory?: number; heal?: number } = {};
            if ((cp.memory ?? 0) > 0) updates.memory = Math.max(0, cp.memory! - deletedEvents);
            if ((cp.heal ?? 0) > 0) updates.heal = Math.max(0, cp.heal! - deletedEvents);
            if (updates.memory !== undefined || updates.heal !== undefined) {
              await this.metadataRepo.updateCheckpoint(entityId, updates, tx);
            }
          }
        });
        if (guarded) {
          const held = await this.eventRepo.countHeldBack(entityId, cutoff, wm);
          if (held > 0) {
            emitDiagnostic(this.options, { code: 'event_retention_held', operation: 'prune', trigger: 'call', entityId, detail: { count: held } });
          }
        }
      }

      let vacuumCheckpointErr: CheckpointIncompleteError | undefined;
      if (vacuum) {
        try {
          await this._wrappedVacuum();
        } catch (err) {
          // Deferred: the sync hand-off and partial-failure reporting below must still happen.
          if (!(err instanceof CheckpointIncompleteError)) throw err;
          vacuumCheckpointErr = err;
        }
      }

      // Output param (erase step 6): filled before anything below can throw.
      // Contract: a superset of the hard-deleted ids, consumed by containment.
      // A loop, not push(...ids): a spread of ~120k ids overflows the stack.
      if (options?.syncedIds) for (const id of syncedIds) options.syncedIds.push(id);
      await this.searchService.syncEntries(entityId, syncedIds);
      if (prunePartial && vacuumCheckpointErr) {
        // Both failures are real: surface the checkpoint one as a diagnostic rather than dropping it.
        emitDiagnostic(this.options, { code: 'prune_checkpoint_incomplete', operation: 'prune', trigger: 'call', entityId, detail: { reason: vacuumCheckpointErr.message } });
      }
      if (prunePartial) {
        throw new PrunePartialFailureError(
          deletedEntries, prunePartial.failedAt, prunePartial.remaining, prunePartial.cause, deletedTasks, deletedEvents,
        );
      }
      if (vacuumCheckpointErr) throw vacuumCheckpointErr;
      return { entries: deletedEntries, tasks: deletedTasks, events: deletedEvents };
    } finally {
      this.jobManager.releaseLock('prune', entityId);
    }
  }

  /** Shared by runPrune and erase step 5. */
  private async _wrappedVacuum(): Promise<void> {
    // VACUUM may renumber rowids; a watermark must never survive it.
    await resetNormalizeWatermarks(this.metadataRepo);
    let checkpointErr: unknown;
    try {
      await this.metadataRepo.vacuum();
    } catch (err) {
      // VACUUM already renumbered rowids when the post-VACUUM checkpoint was incomplete: the restart must still run.
      if (!(err instanceof CheckpointIncompleteError)) throw err;
      checkpointErr = err;
    }
    // After it, so the restarted FTS rebuild snapshots the renumbered rowids (spec #280 7(k)).
    await restartRebuildAfterVacuum(this.db, this.prefix, this.metadataRepo);
    if (checkpointErr) throw checkpointErr;
  }

  /**
   * Erase core (forget-erasure spec §2, steps 0 / 1 / 1b). Thin entry: T6
   * completes the pipeline (FTS, VACUUM, checkpoint, sync). Never reports a
   * success it cannot verify: a failed step throws {@link EraseStepError}
   * carrying the partial report with `verified: false`.
   */
  async erase(opts?: { rebuild?: boolean }): Promise<EraseReport> {
    const rebuild = opts?.rebuild === true;
    this.jobManager.acquireLock('erase', '*');
    const report: EraseReport = {
      verified: false, secureDelete: null, sqliteVersion: '', entities: [], holds: [],
      skipped: [], syncedIds: [], registrySweep: { skipped: false, deleted: 0 }, retiredUndroppable: [], ftsOrphansCleared: [], failedStep: null,
      runtime: eraseRuntime(), steps: [],
    };
    const ok = (step: string, outcome: 'ok' | 'partial' = 'ok') => { report.steps.push({ step, outcome }); };
    try {
      // Step 0 (ruling B): the pragma is load-bearing and a host can flip it on
      // the shared connection after setup(); verify on the connection in use.
      const readPragma = async () =>
        (await this.db.getFirstAsync<{ secure_delete: number }>('PRAGMA secure_delete'))?.secure_delete ?? null;
      let pragma: number | null;
      try {
        pragma = await readPragma();
        if (pragma !== 1) {
          await this.db.execAsync('PRAGMA secure_delete=ON');
          pragma = await readPragma();
        }
        report.secureDelete = pragma;
        report.sqliteVersion = (await this.db.getFirstAsync<{ v: string }>('SELECT sqlite_version() AS v'))?.v ?? '';
      } catch (err) {
        report.failedStep = 'secure_delete';
        throw new EraseStepError('erase_secure_delete_read_failed', 'erase stopped at step 0: secure_delete pragma read failed; erasure is unverified', report, err);
      }
      if (pragma !== 1) {
        emitDiagnostic(this.options, { code: 'erase_secure_delete_off', operation: 'erase', trigger: 'call', entityId: '' });
        report.failedStep = 'secure_delete';
        throw new EraseStepError('erase_secure_delete_off', 'erase stopped at step 0: secure_delete is not ON; erasure is unverified', report);
      }
      ok('secure_delete');

      // Step 1: per-entity prune; events are never deleted (retainEventsFor: null).
      // softDeletedAll: rows tombstoned with ANY deleted_at value — a future
      // or TEXT-valued one (imports never clamp; SQLite ranks TEXT above
      // INTEGER) — must still be walked and hard-deleted, or erase reports
      // verified while their text survives in the database file.
      try {
        report.entities = await this.metadataRepo.getDistinctEntityIds(undefined, { softDeletedAll: true });
      } catch (err) {
        report.failedStep = 'prune';
        throw new EraseStepError('erase_prune_failed', 'erase stopped at step 1: the entity walk failed; erasure is unverified', report, err);
      }
      const syncedByEntity = new Map<string, string[]>();
      for (const entityId of report.entities) {
        const syncedIds: string[] = [];
        syncedByEntity.set(entityId, syncedIds);
        try {
          await this._runPrune(entityId, { retainSoftDeletedFor: 0, retainEventsFor: null, vacuum: false, syncedIds, softDeletedCutoff: 'all' }, 'erase');
        } catch (err) {
          if (err instanceof PrunePartialFailureError) {
            report.holds.push({ entityId, deleted: err.deleted, deletedTasks: err.deletedTasks, failedAt: err.failedAt, remaining: err.remaining });
          } else if (err instanceof WikiBusyError) {
            report.skipped.push(entityId);
            emitDiagnostic(this.options, { code: 'erase_entity_skipped', operation: 'erase', trigger: 'call', entityId });
          } else {
            report.failedStep = 'prune';
            throw new EraseStepError('erase_prune_failed', `erase stopped at step 1 (entity ${entityId})`, report, err);
          }
        }
        // A loop, not push(...ids): a spread of ~120k ids overflows the stack.
        for (const id of syncedIds) report.syncedIds.push(id);
      }

      ok('prune', report.holds.length > 0 || report.skipped.length > 0 ? 'partial' : 'ok');

      // Step 1b (ruling G): store-wide tombstone sweep, only when the table exists.
      try {
        await this.db.withTransactionAsync(async (tx) => {
          if (await this.sourceRefIndexPresent(tx)) {
            const r = await tx.runAsync(`DELETE FROM ${this.prefix}source_ref_index WHERE deleted_at IS NOT NULL`);
            report.registrySweep = { skipped: false, deleted: r.changes };
          } else {
            report.registrySweep = { skipped: true, deleted: 0 };
          }
        });
      } catch (err) {
        report.failedStep = 'registry_sweep';
        throw new EraseStepError('erase_registry_sweep_failed', 'erase stopped at step 1b', report, err);
      }
      if (report.registrySweep.skipped) {
        emitDiagnostic(this.options, { code: 'erase_registry_sweep_skipped', operation: 'erase', trigger: 'call', entityId: '' });
      }
      ok('registry_sweep', report.registrySweep.skipped ? 'partial' : 'ok');

      // Step 3: full syncChain drain (awaited to completion), then step 4.
      await this._eraseDrainPassages(report);
      ok('passage_drain');
      await this._eraseReclaimRetired(report);
      ok('retired_reclaim');

      // Step 5: wrapped VACUUM (pre/post checkpoints verified inside).
      try {
        await this._wrappedVacuum();
      } catch (err) {
        if (err instanceof CheckpointIncompleteError) {
          report.failedStep = 'checkpoint';
          throw new EraseStepError('erase_checkpoint_incomplete', 'erase stopped at step 5: WAL checkpoint incomplete; erasure is unverified', report, err);
        }
        report.failedStep = 'vacuum';
        throw new EraseStepError('erase_vacuum_failed', 'erase stopped at step 5: VACUUM failed (commonly an unfenced writer holding the database — quiesce and retry; also any other VACUUM failure, e.g. disk-full or I/O errors)', report, err);
      }
      ok('vacuum');

      // Step 6: index sync for the syncedIds superset, immediately after VACUUM
      // (deliberately not deduplicated against step 1's internal pass).
      const byEntity = new Map<string, string[]>();
      for (const e of report.entities) byEntity.set(e, []);
      for (const [entityId, ids] of syncedByEntity) byEntity.set(entityId, ids);
      for (const [entityId, ids] of byEntity) {
        if (ids.length > 0) await this._eraseSyncEntries(entityId, ids, report);
      }
      ok('index_sync');

      // Step 7 rebuild escape hatch runs before the step-4 re-run, so the entries_fts_retired_N it
      // creates is reclaimed there. Optimize ALWAYS follows: the fresh entries_fts is safe to optimize
      // and source_passages_fts is untouched by the rebuild.
      if (rebuild) {
        try {
          await this.searchService.rebuildSurfaced();
        } catch (err) {
          report.failedStep = 'rebuild';
          throw new EraseStepError('erase_rebuild_failed', 'erase stopped at step 7: FTS rebuild failed', report, err);
        }
        ok('rebuild');
      }

      // Step 4 re-run (cheap when empty); nothing may stay retired except the module-less, emptied tables.
      await this._eraseReclaimRetired(report);
      // P1: sqlite_master is the truth (Fts5IndexStrategy delists a name even when its DROP failed).
      let present: Array<{ name: string }>;
      try {
        present = await this.db.getAllAsync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%entries_fts_retired_%'`,
        );
      } catch (err) {
        report.failedStep = 'retired_reclaim';
        emitDiagnostic(this.options, { code: 'erase_retired_read_failed', operation: 'erase', trigger: 'call', entityId: '' });
        throw new EraseStepError('erase_retired_read_failed', 'erase stopped after step 6: the retired-table read failed; erasure is unverified', report, err);
      }
      const left = present.map((r) => r.name).filter((n) => isRetiredTableName(this.prefix, n) && !report.retiredUndroppable.includes(n));
      if (left.length > 0) {
        report.failedStep = 'retired_reclaim';
        emitDiagnostic(this.options, { code: 'erase_retired_remaining', operation: 'erase', trigger: 'call', entityId: '', detail: { tables: left } });
        throw new EraseStepError('erase_retired_remaining', `erase stopped after step 6: retired FTS tables remain (${left.join(', ')})`, report);
      }
      ok('retired_reclaim_rerun');

      // Step 7: optimize on both FTS tables (always, including after a rebuild).
      await this._eraseOptimize(report);
      ok('optimize');

      // Step 8: final checkpoint, verified.
      try {
        await this.metadataRepo.checkpointTruncateVerified();
      } catch (err) {
        report.failedStep = 'checkpoint';
        throw new EraseStepError('erase_checkpoint_incomplete', 'erase stopped at step 8: WAL checkpoint incomplete; erasure is unverified', report, err);
      }

      ok('checkpoint');

      // Step 9 (final tombstone gate): verified:true means every soft-deleted
      // row's text is gone from the file. A row that escaped steps 0-8 (for
      // example a future-dated deleted_at an earlier cutoff missed) would
      // otherwise hide behind a verified:true report. Runs only when the
      // report would be honest: rows held for an unconfirmed hook or belonging
      // to a skipped entity already account for surviving tombstones and
      // already force verified:false.
      if (report.skipped.length === 0 && report.holds.length === 0) {
        let remainingTombstones: number;
        try {
          const row = await this.db.getFirstAsync<{ n: number }>(
            `SELECT (SELECT COUNT(*) FROM ${this.prefix}entries WHERE deleted_at IS NOT NULL)
                + (SELECT COUNT(*) FROM ${this.prefix}tasks WHERE deleted_at IS NOT NULL) AS n`,
          );
          remainingTombstones = row?.n ?? 0;
        } catch (err) {
          report.failedStep = 'tombstone_gate';
          throw new EraseStepError('erase_tombstone_gate_failed', 'erase stopped at step 9: could not count remaining tombstones; erasure is unverified', report, err);
        }
        if (remainingTombstones > 0) {
          emitDiagnostic(this.options, { code: 'erase_tombstones_remaining', operation: 'erase', trigger: 'call', entityId: '', detail: { count: remainingTombstones } });
          report.failedStep = 'tombstone_gate';
          throw new EraseStepError('erase_tombstones_remaining', `erase stopped at step 9: ${remainingTombstones} soft-deleted row(s) remain; erasure is unverified`, report);
        }
        ok('tombstone_gate');
      } else {
        // The gate did not run: holds/skipped entities already account for the
        // surviving soft-deleted rows. Record it so the report's step list never
        // makes "not run" look like "passed".
        report.steps.push({ step: 'tombstone_gate', outcome: 'partial' });
      }

      // Skipped entities were not erased: honest report, never a verified success.
      report.verified = report.skipped.length === 0 && report.holds.length === 0;
      return report;
    } catch (err) {
      if (err instanceof EraseStepError && err.report === report && report.failedStep) {
        report.steps.push({ step: report.failedStep, outcome: 'failed' });
        report.verified = false;
      }
      throw err;
    } finally {
      this.jobManager.releaseLock('erase', '*');
    }
  }

  // ── Erase FTS surfaces (spec §2 steps 3/4/6-sync/7). T6 composes these into erase(). ──

  private static readonly FTS_SHADOW_SUFFIXES = ['_content', '_data', '_idx', '_docsize', '_config'] as const;

  /**
   * Step 3 remediation (specs/erase-fts-remediation): on a runtime without
   * usable strict drains, clear orphaned FTS5 surfaces so erasure can
   * complete verified. Per surface: existence gate (vtab OR any shadow) →
   * strategy check → vtab probe → path body → companions → state write.
   * Dispatch order is D4; exact-name allowlist interpolation is D2.
   */
  async _eraseClearFtsOrphans(report: EraseReport): Promise<void> {
    const surfaces = [`${this.prefix}entries_fts`, `${this.prefix}source_passages_fts`] as const;
    let remediationRequired = false;
    const pathBTargets: string[] = [];
    try {
      for (const surface of surfaces) {
        const vtabExists = await this.sourceTableExists(surface);
        const shadows: string[] = [];
        for (const sfx of MaintenanceService.FTS_SHADOW_SUFFIXES) {
          const name = `${surface}${sfx}`;
          if (await this.sourceTableExists(name)) shadows.push(name);
        }
        if (!vtabExists && shadows.length === 0) continue; // never saw FTS5 or fully detached: no gate, no entry
        remediationRequired = true;
        // Honest failure first (D1): an Unavailable strategy is a transient
        // outage that preserves a healthy index — never drop or clear under it.
        if (this.searchService.isIndexUnavailable()) {
          report.failedStep = 'index_sync';
          throw new EraseStepError('erase_fts_index_unavailable', 'erase stopped at step 3: the index strategy is unavailable and orphaned FTS surfaces remain; erasure is unverified', report);
        }
        let moduleLess = false;
        if (vtabExists) {
          try {
            await this.db.getFirstAsync(`SELECT 1 AS x FROM ${surface} LIMIT 1`);
          } catch (err) {
            // Mirror createIndexStrategy's probe: some adapters wrap the SQLite message in a cause chain.
            let absent = false;
            let cur: unknown = err;
            for (let depth = 0; depth < 3 && cur != null && !absent; depth++) {
              let msg = '';
              try { msg = String((cur as { message?: unknown }).message ?? cur); } catch { break; }
              absent = /no such module/i.test(msg);
              try { cur = (cur as { cause?: unknown }).cause; } catch { break; }
            }
            if (!absent) {
              report.failedStep = 'index_sync';
              throw new EraseStepError('erase_fts_orphan_probe_failed', `erase stopped at step 3: could not classify orphaned vtab ${surface}`, report, err);
            }
            moduleLess = true; // Path A: the vtab row is inert
          }
        }
        if (vtabExists && !moduleLess) {
          if (this.options.config?.indexStrategy !== 'minisearch') {
            report.failedStep = 'index_sync';
            throw new EraseStepError('erase_fts_index_unavailable', `erase stopped at step 3: ${surface} is live and queryable but MiniSearch is not the configured strategy; erasure is unverified`, report);
          }
          pathBTargets.push(surface); // Path B: defer DROPs to after the per-surface loop
          continue;
        }
        // Path A / Path C: the shadows are plain tables here. The text-bearing
        // rows go; fts5's structural state stays: %_data ids 1 (AVERAGES record)
        // and 10 (STRUCTURE record) hold no text, and the %_config table with its
        // version row stays too — deleting it is what makes the vtab unreadable.
        // The kept structure record points at deleted segments, so a capable
        // re-open's retire path must never read segment data; the AC2 canary
        // proves that holds today (specs/erase-fts-remediation).
        const cleared: string[] = [];
        for (const name of shadows) {
          if (name.endsWith('_config')) continue;
          const res = await this.db.runAsync(name.endsWith('_data')
            ? `DELETE FROM ${name} WHERE id NOT IN (1, 10)`
            : `DELETE FROM ${name}`);
          if ((res?.changes ?? 0) > 0) cleared.push(name);
        }
        for (const name of cleared) {
          if (!report.ftsOrphansCleared.includes(name)) report.ftsOrphansCleared.push(name);
          emitDiagnostic(this.options, { code: 'erase_fts_orphan_cleared', operation: 'erase', trigger: 'call', entityId: '', detail: { table: name } });
        }
      }
      if (!remediationRequired) return;
      // Plain companions that can hold text and have no drain on this runtime (D1, existence-gated).
      // One transaction for the whole tail (D4): companions, Path B drops, state write.
      // Cleared names + diagnostics land AFTER the transaction resolves: a rollback
      // must not leave the report claiming tables were cleared (Tier-4 delta nit).
      const tailCleared: string[] = [];
      await this.db.withTransactionAsync(async (tx) => {
      for (const companion of [`${this.prefix}fts_pending`, `${this.prefix}fts_map`, `${this.prefix}source_passages_fts_pending`, `${this.prefix}source_passages_fts_map`] as const) {
        if (await this.sourceTableExists(companion, tx)) {
          const res = await tx.runAsync(`DELETE FROM ${companion}`);
          if ((res?.changes ?? 0) > 0 && !tailCleared.includes(companion)) tailCleared.push(companion);
        }
      }
      // Path B body (after the surface loop, D4): DROP the queryable vtabs and
      // the FTS triggers. Path B DELETEs the passage companions' rows where
      // detachFts5 DROPs the tables — harmless: the next capable init re-creates
      // them (CREATE IF NOT EXISTS), matching ensurePassageObjects' re-seed.
      for (const surface of pathBTargets) {
        await tx.execAsync(`DROP TABLE IF EXISTS ${surface}`);
        if (!tailCleared.includes(surface)) tailCleared.push(surface);
      }
      if (pathBTargets.length > 0) {
        const [ai, ad] = passageFtsTriggerNames(this.prefix);
        await tx.execAsync(fts5LedgerDropSql(this.prefix) + `\nDROP TRIGGER IF EXISTS ${ai};\nDROP TRIGGER IF EXISTS ${ad};`);
      }
      // Deterministic state (D1/D5): the next capable open must take resetAndRearm, not a corruption path.
      await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'detached', tx);
      });
      for (const name of tailCleared) {
        if (!report.ftsOrphansCleared.includes(name)) report.ftsOrphansCleared.push(name);
        emitDiagnostic(this.options, { code: 'erase_fts_orphan_cleared', operation: 'erase', trigger: 'call', entityId: '', detail: { table: name } });
      }
      report.steps.push({ step: 'fts_orphan_clear', outcome: 'ok' });
    } catch (err) {
      if (err instanceof EraseStepError) throw err;
      report.failedStep = 'fts_orphan_clear';
      throw new EraseStepError('erase_fts_orphan_clear', 'erase stopped at step 3: clearing an orphaned FTS surface failed; erasure is unverified', report, err);
    }
  }

  /**
   * Step 3: chained, surfaced drains (no deadline). Entries-ledger failures are
   * the entries/index-sync step (`index_sync`); passage failures `passage_drain`.
   * N2 guard (probe lives here, strategy-agnostic): a strategy without the strict
   * drains (Unavailable / MiniSearch) cannot drain, so rows in either FTS ledger
   * mean text was never drained -> the step fails and erasure is unverified.
   * Absent or empty ledgers proceed.
   */
  async _eraseDrainPassages(report: EraseReport): Promise<void> {
    if (!this.searchService.hasStrictDrain()) {
      await this._eraseClearFtsOrphans(report);
      for (const [table, failedStep, code] of [
        [`${this.prefix}fts_pending`, 'index_sync', 'erase_index_sync_failed'],
        [`${this.prefix}source_passages_fts_pending`, 'passage_drain', 'erase_passage_drain_failed'],
      ] as const) {
        let rows = false;
        try {
          rows = (await this.sourceTableExists(table)) && (await this.db.getFirstAsync(`SELECT 1 AS x FROM ${table} LIMIT 1`)) != null;
        } catch (err) {
          report.failedStep = failedStep;
          throw new EraseStepError(code, `erase stopped at step 3: could not probe ${table}`, report, err);
        }
        if (rows) {
          report.failedStep = failedStep;
          throw new EraseStepError(code, `erase stopped at step 3: ${table} holds undrained rows and the FTS index strategy cannot drain them; erasure is unverified`, report);
        }
      }
    }
    try {
      await this.searchService.drainEntriesLedgerSurfaced();
    } catch (err) {
      report.failedStep = 'index_sync';
      throw new EraseStepError('erase_index_sync_failed', 'erase stopped at step 3: entries ledger drain failed', report, err);
    }
    try {
      await this.searchService.drainPassagesSurfaced();
    } catch (err) {
      report.failedStep = 'passage_drain';
      throw new EraseStepError('erase_passage_drain_failed', 'erase stopped at step 3: passage drain failed', report, err);
    }
  }

  /**
   * Step 4 (and its re-run after step 6): reclaim retired FTS tables to
   * completion. A module-less runtime cannot DROP a virtual table, so each
   * retired table's shadow tables are emptied under the pragma and the name
   * stays listed; a later FTS5-capable open's step 4 completes the DROP.
   */
  async _eraseReclaimRetired(report: EraseReport): Promise<void> {
    // Strategies without reclaim (MiniSearch / Unavailable) cannot DROP: go straight to the shadow-table clear.
    if (this.searchService.canReclaimRetired()) {
      try {
        await this.searchService.reclaimRetiredSurfaced();
        return;
      } catch (err) {
        if (!/no such module/i.test(err instanceof Error ? err.message : String(err))) {
          report.failedStep = 'retired_reclaim';
          throw new EraseStepError('erase_retired_reclaim_failed', 'erase stopped at step 4: retired FTS table reclaim failed', report, err);
        }
      }
    }
    try {
      for (const name of await this._retiredList()) {
        for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
          if (sfx === '_config') continue; // preserve rule (as Path A): keeps the retired vtab readable so a capable re-open can DROP it
          if (await this.sourceTableExists(`${name}${sfx}`)) {
            await this.db.runAsync(sfx === '_data' ? `DELETE FROM ${name}_data WHERE id NOT IN (1, 10)` : `DELETE FROM ${name}${sfx}`);
          }
        }
        if (!report.retiredUndroppable.includes(name)) report.retiredUndroppable.push(name);
        emitDiagnostic(this.options, { code: 'erase_retired_vtab_undroppable', operation: 'erase', trigger: 'call', entityId: '' });
      }
    } catch (err) {
      report.failedStep = 'retired_reclaim';
      throw new EraseStepError('erase_retired_reclaim_failed', 'erase stopped at step 4: module-less shadow-table clear failed', report, err);
    }
  }

  /** Retired list straight from metadata (same key Fts5IndexStrategy maintains), independent of the active strategy. */
  private async _retiredList(): Promise<string[]> {
    let raw: unknown;
    try {
      raw = JSON.parse((await this.metadataRepo.getMeta(FTS5_RETIRED_TABLES_KEY)) ?? '[]');
    } catch {
      return [];
    }
    return Array.isArray(raw) ? raw.filter((n): n is string => isRetiredTableName(this.prefix, n)) : [];
  }

  private sourceTableExists(name: string, tx?: SQLiteAdapter): Promise<boolean> {
    return this.metadataRepo.tableExists(name, tx);
  }

  /** Step 6 sync: `syncEntries` resolving false means the ledger drain failed — a failed step. */
  async _eraseSyncEntries(entityId: string, ids: string[], report: EraseReport): Promise<void> {
    let ok = false;
    try {
      ok = await this.searchService.syncEntries(entityId, ids);
    } catch (err) {
      report.failedStep = 'index_sync';
      throw new EraseStepError('erase_index_sync_failed', `erase stopped at index sync (entity ${entityId})`, report, err);
    }
    if (!ok) {
      report.failedStep = 'index_sync';
      throw new EraseStepError('erase_index_sync_failed', `erase stopped at index sync (entity ${entityId}): ledger drain failed`, report);
    }
  }

  /** Step 7: FTS optimize on both FTS tables, after syncEntries. */
  async _eraseOptimize(report: EraseReport): Promise<void> {
    try {
      await this.searchService.optimizeSurfaced();
    } catch (err) {
      report.failedStep = 'optimize';
      throw new EraseStepError('erase_optimize_failed', 'erase stopped at step 7: FTS optimize failed', report, err);
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
    options?: { promptOverride?: string; batchSize?: number; classifier?: 'auto' | 'llm'; tokenBudget?: number },
  ): Promise<OntologyBackfillResult> {
    this.jobManager.acquireLock('ontologyBackfill', entityId);
    try {
      return await this.doRunOntologyBackfill(entityId, {
        ...options,
        meter: new UsageMeter(options?.tokenBudget),
      });
    } finally {
      this.jobManager.releaseLock('ontologyBackfill', entityId);
    }
  }

  /**
   * Re-embed facts, honouring per-row failure markers and exponential backoff.
   *
   * Marker lifecycle (spec §2): markers are cleared by a successful embed, by
   * an upsert carrying a valid blob, and by an embedding-dimension promotion.
   * A promotion revives rows for the NEXT sweep, not this one — reconciliation
   * runs after candidates were already classified.
   *
   * Residual, by design: swapping to a provider with the SAME dimension never
   * sets embedding_dimension_mismatch, so promotion never fires and markers
   * survive the swap. Use `runReembed({ force: true })` to clear that state —
   * `force` bypasses classification entirely and retries every row.
   *
   * Lock scope (spec 2026-09-05 §2): a marker mutation is legal while a sweep
   * is in flight if and only if it cannot resurrect a row the sweep has
   * classified. Mutations scoped to entities not under an active sweep key are
   * legal — the entity-scoped ingest/import lock checks enforce that. The one
   * mutation that spans every entity, `reconcileEmbeddingDimension`'s marker
   * clear, is made legal by DEFERRING (importDump gates on
   * `JobManager.isAnyReembedActive()`), never by widening a lock. Auto-heal is
   * excluded from sweeps for the same reason.
   */
  async runReembed(
    entityId?: string,
    opts?: { force?: boolean; skipExisting?: boolean },
  ): Promise<ReembedResult> {
    const embedFn = this.options.llmProvider.embed;
    // Same callability guard as EmbeddingService.tryEmbedFact (spec §2.4): a
    // misconfigured provider short-circuits the sweep instead of iterating and
    // marking every row.
    if (typeof embedFn !== 'function') {
      return { embedded: 0, skipped: 0, failed: 0, deferred: 0, permanentlyFailed: 0 };
    }

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
      let deferred = 0;
      let permanentlyFailed = 0;
      const force = opts?.force ?? false;
      // One clock snapshot for the whole sweep: backoff eligibility is decided
      // against sweep-start time, so rows whose window elapses mid-sweep stay
      // deferred until the next sweep. Keeps classifyReembedRow pure and the
      // sweep's deferral decisions deterministic for a single invocation.
      const now = Date.now();

      try {
        for (const row of rows) {
          const existingBlob = row.embedding_blob;
          const blobIsValid = !!existingBlob && existingBlob.byteLength > 0 && existingBlob.byteLength % 4 === 0;

          if (effectiveSkip && blobIsValid) {
            const vec = parseEmbedding(existingBlob, null);
            if (vec !== null && vec.every(v => Number.isFinite(v))) {
              skipped++;
              continue;
            }
          }

          const disposition = classifyReembedRow(row, now, force);
          if (disposition === 'defer') { deferred++; continue; }
          if (disposition === 'permanent') { permanentlyFailed++; continue; }

          const result = await this.embeddingService.tryEmbedFact(row, { operation: 'reembed', trigger: 'call' });
          if (result.ok) embedded++;
          else if (result.kind === 'fact_deleted') skipped++; // deleted mid-sweep: not a failure
          else failed++;
        }

        if (embedded > 0) {
          await this.embeddingService.reconcileEmbeddingDimension();
        }
      } finally {
        this.searchService.evictCache(entityId);
      }

      return { embedded, skipped, failed, deferred, permanentlyFailed };
    } finally {
      this.jobManager.releaseLock(op, entityId ?? '*');
    }
  }

  async forget(
    entityId: string,
    params: ForgetParams,
    opts?: { dryRun?: boolean },
  ): Promise<ForgetResult> {
    if (params.clearAll && (params.entryId !== undefined || params.taskId !== undefined || params.sourceRef !== undefined || params.sourceHash !== undefined || params.eventId !== undefined)) {
      throw new Error('forget() clearAll is mutually exclusive with entryId, taskId, sourceRef, sourceHash, and eventId');
    }
    if (params.includeEvents && !params.clearAll) {
      throw new Error('forget() includeEvents requires clearAll: true');
    }
    if (params.includeChain && (params.entryId === undefined || params.clearAll || params.taskId !== undefined || params.sourceRef !== undefined || params.sourceHash !== undefined || params.eventId !== undefined)) {
      throw new Error('forget() includeChain composes only with entryId');
    }
    // eventId exclusivity + validation live HERE, before the dry-run dispatch:
    // forgetDryRun runs outside any transaction and does not re-run the
    // in-transaction selector-group checks (specs/forget-by-event-id §D7).
    if (params.eventId !== undefined && (params.entryId !== undefined || params.taskId !== undefined || params.sourceRef !== undefined || params.sourceHash !== undefined)) {
      throw new Error('forget() eventId is mutually exclusive with entryId, taskId, sourceRef, and sourceHash');
    }
    if (params.eventId !== undefined && (typeof params.eventId !== 'string' || params.eventId === '')) {
      throw new Error('Invalid eventId');
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
      let deletedEvents = 0;
      let chainIds: string[] = [];
      let chainTruncated = false;
      const deletedEntryIds: string[] = [];
      // A store whose setup() never ran has no ledger table (#316 recovery).
      const ledgerOn = !!this.vectorRemoval && !!this.vectorRemovalRepo && await this.vectorRemoval.ledgerPresent();

      await this.db.withTransactionAsync(async (tx) => {
        if (params.clearAll) {
          // A loop, not push(...ids): a spread of ~120k ids overflows the stack.
          for (const id of await this.entryRepo.findIdsBySource(entityId, null, null, tx, true)) deletedEntryIds.push(id);
          deletedEntries = await this.entryRepo.bulkSoftDeleteByEntityId(entityId, tx);
          deletedTasks = await this.taskRepo.bulkSoftDeleteByEntityId(entityId, tx);
          // Remove the entity's source_ref_index rows, live or not. The table
          // is internal (no outbox events), and soft-deleted rows are never
          // read or pruned, so a wipe hard-deletes them (spec
          // import-followups §6 rev 4).
          // Skipped on a pre-v9 store, whose v9 backfill rebuilds the index from
          // live entries (same rule as the by-source path below).
          if (await this.sourceRefIndexPresent(tx)) {
            await this.sourceRefIndexRepo.deleteByEntityId(entityId, tx);
          }
          // Stored source text is hard-deleted with the rest (spec source-store §5).
          if (await this.sourceStorePresent(tx)) {
            await tx.runAsync(`DELETE FROM ${this.prefix}source_passages WHERE entity_id = ?`, [entityId]);
            await tx.runAsync(`DELETE FROM ${this.prefix}source_documents WHERE entity_id = ?`, [entityId]);
          }
          // Edges have no soft delete, and a soft-deleted fact is never
          // restored, so the entity's edges can never be used again (spec
          // import-followups §6).
          await this.edgeRepo.bulkDeleteByEntityId(entityId, tx);
          if (params.includeEvents) {
            // A requested wipe deletes every event, read or not (§6, ruling
            // §5.9). Deleting the checkpoint row also clears the librarian
            // watermark: with an empty log, a watermark ahead of the clock
            // would hide every new event.
            deletedEvents = (await this.eventRepo.deleteByEntityId(entityId, tx)).changes;
            await this.metadataRepo.deleteCheckpoint(entityId, tx);
          } else {
            await this.metadataRepo.updateCheckpoint(entityId, { memory: 0, heal: 0 }, tx);
          }
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

          // Before any mutation: a pre-v9 store has no source_ref_index to update (#316).
          const touchSourceRefIndex = sourceRef !== null && await this.sourceRefIndexPresent(tx);

          if (params.entryId) {
            const entryId = await this.entryRepo.findIdById(params.entryId, entityId, tx);
            if (entryId) deletedEntryIds.push(entryId);
            if (entryId && params.includeChain) {
              const walk = await this.entryRepo.findSupersessionChainWalk(entityId, entryId, HISTORY_MAX_DEPTH, tx);
              chainIds = walk.ids.filter((id) => id !== entryId);
              chainTruncated = walk.truncated;
              for (const id of chainIds) deletedEntryIds.push(id);
            }
          }

          if ((sourceRef || sourceHash) && await this.sourceStorePresent(tx)) {
            // Hard-delete the source's stored text and passages in this same
            // transaction (spec source-store §5). Fact semantics are unchanged.
            const docs = `${this.prefix}source_documents`;
            // Pair semantics (spec §5): both selectors are optional filters,
            // ANDed — a (sourceRef, sourceHash) call must never delete a
            // document that matches only one side.
            const sel = 'entity_id = ? AND (? IS NULL OR source_ref = ?) AND (? IS NULL OR source_hash = ?)';
            const selArgs = [entityId, sourceRef, sourceRef, sourceHash, sourceHash];
            await tx.runAsync(
              `DELETE FROM ${this.prefix}source_passages WHERE entity_id = ? AND document_id IN (SELECT id FROM ${docs} WHERE ${sel})`,
              [entityId, ...selArgs],
            );
            await tx.runAsync(`DELETE FROM ${docs} WHERE ${sel}`, selArgs);
          }

          if (sourceRef || sourceHash) {
            for (const id of await this.entryRepo.findIdsBySource(entityId, sourceRef, sourceHash, tx, true)) deletedEntryIds.push(id);
          }

          // specs/forget-by-event-id: the pointer selector enumerates its ids
          // (live + tombstoned superset) and mutates with outbox parity, same
          // shape as the by-source branch above.
          if (params.eventId !== undefined) {
            for (const id of await this.entryRepo.findIdsByPointerEvent(entityId, params.eventId, tx, true)) deletedEntryIds.push(id);
          }

          const entryPromise = params.entryId ? this.entryRepo.softDelete(params.entryId, entityId, tx).then(r => r.changes > 0) : null;
          const taskDeletedPromise = params.taskId ? this.taskRepo.softDeleteById(params.taskId, entityId, tx).then(r => r.changes > 0) : null;
          const refPromise = (sourceRef || sourceHash) ? this.entryRepo.softDeleteBySource(entityId, tx, sourceRef, sourceHash) : null;
          const pointerPromise = params.eventId !== undefined ? this.entryRepo.softDeleteByPointerEvent(entityId, params.eventId, tx) : null;
          // Soft-delete the source_ref_index row so a re-ingest of this
          // sourceRef+hash can take ownership. The pre-check at the start of
          // ingestDocument will now see no live ref and proceed. No-op when
          // the row is already soft-deleted or never existed, and skipped on a
          // pre-v9 store, whose v9 backfill rebuilds the index from live entries.
          const sourceRefIndexPromise = touchSourceRefIndex && sourceRef
            ? this.sourceRefIndexRepo.softDeleteByEntityAndSourceRef(entityId, sourceRef, tx).then(() => undefined)
            : null;

          const [entryResult, taskResult, refResult, pointerResult] = await Promise.all([
            entryPromise ?? Promise.resolve(false),
            taskDeletedPromise ?? Promise.resolve(false),
            refPromise ?? Promise.resolve(0),
            pointerPromise ?? Promise.resolve(0),
            sourceRefIndexPromise ?? Promise.resolve(undefined),
          ]);

          if (entryResult) deletedEntries++;
          for (const id of chainIds) {
            if ((await this.entryRepo.softDelete(id, entityId, tx)).changes > 0) deletedEntries++;
          }
          if (taskResult) deletedTasks++;
          deletedEntries += refResult;
          deletedEntries += pointerResult;
        }
        // Backstop (spec durable-vector-removal §5.5): ids soft-deleted before
        // the ledger existed get a row so a retry still sends them.
        if (ledgerOn && this.vectorRemoval?.gate() === 'hook' && deletedEntryIds.length > 0) {
          await this.vectorRemovalRepo?.backstopEnqueue(entityId, Array.from(new Set(deletedEntryIds)), now, tx);
        }
      });

      // Every branch that soft-deletes entries also enumerates the ids into
      // deletedEntryIds inside the same transaction: the entryId branch, the
      // by-source branch (findIdsBySource(..., includeDeleted=true) — its
      // predicate matches softDeleteBySource's exactly), the eventId branch
      // (findIdsByPointerEvent(..., includeDeleted=true) — same predicate as
      // softDeleteByPointerEvent modulo the tombstone guard), and the
      // clearAll branch. So the index update is O(deleted), not O(entity)
      // (spec §2.1).
      const uniqueDeletedIds = Array.from(new Set(deletedEntryIds));
      await this.searchService.syncEntries(entityId, uniqueDeletedIds);
      if (uniqueDeletedIds.length > 0) {
        const firstId = uniqueDeletedIds[0];
        const vr = this.vectorRemoval;
        const vrRepo = this.vectorRemovalRepo;
        let unconfirmed: string[] = [];
        let timedOut = false;
        let cause: unknown;
        let timedOutId: string | undefined;
        try {
          if (vr && vrRepo && ledgerOn) {
            const result = await vr.drain({ entityId, ids: uniqueDeletedIds });
            if (vr.gate() === 'hook') {
              const status = await vrRepo.statusFor(uniqueDeletedIds);
              unconfirmed = uniqueDeletedIds.filter((id) => status.get(id) === 'pending');
              timedOut = result.timedOut;
              timedOutId = result.timedOutId;
              cause = result.firstCause;
            }
          } else if (this.options.vectorRanker?.onEmbeddingPersisted && this.options.forceDeleteIgnoreRankerHook !== true) {
            // Store whose setup() never ran (#316 recovery): no ledger table, so
            // call the hook directly and record nothing (spec §5.5.5).
            const r = await this.embeddingService.callRemovalHookEach(entityId, uniqueDeletedIds);
            unconfirmed = r.failed;
            timedOut = r.timedOut;
            timedOutId = r.timedOutId;
            cause = r.cause;
          }
        } catch (hookErr) {
          const errMsg = (hookErr as Error)?.message ?? '';
          if (errMsg.startsWith('Invalid deletionHookTimeoutMs')) {
            throw new Error(`forget(${entityId}/${firstId}) failed: ${errMsg}`, { cause: hookErr });
          }
          throw hookErr;
        }
        if (unconfirmed.length > 0) {
          const head = `forget(${entityId}/${(timedOut ? timedOutId : undefined) ?? unconfirmed[0]}) failed: `;
          const message = timedOut
            ? head + ((cause as Error)?.message ?? 'onEmbeddingPersisted timed out')
            : cause === undefined
              ? head + 'ANN cleanup not confirmed'
              : head + 'ANN cleanup hook rejected';
          throw new WikiExternalDeletionError(message, {
            entityId,
            unconfirmedIds: unconfirmed.slice(0, 100),
            unconfirmedCount: unconfirmed.length,
            timedOut,
            cause: timedOut || cause === undefined ? undefined : this._sanitizeRankerError(cause),
          });
        }
      }

      if (!params.clearAll) {
        const base: ForgetResult = { deleted: { entries: deletedEntries, tasks: deletedTasks } };
        if (params.includeChain) {
          base.chainEntryIds = chainIds;
          if (chainTruncated) {
            base.truncated = true;
            base.notice = CHAIN_TRUNCATED_NOTICE;
          }
        }
        return base;
      }
      return params.includeEvents
        ? { deleted: { entries: deletedEntries, tasks: deletedTasks, events: deletedEvents }, metadataReset: true }
        : { deleted: { entries: deletedEntries, tasks: deletedTasks }, metadataReset: true };
    } finally {
      this.jobManager.releaseLock('forget', entityId);
    }
  }

  /** Heal's post-commit removal delivery (spec §5.7). Never throws. */
  private async deliverHealRemovals(entityId: string, ids: string[], trigger: WikiDiagnosticTrigger): Promise<void> {
    if (this.vectorRemoval) {
      await this.vectorRemoval.deliverRemovals(entityId, ids, 'heal', trigger);
      return;
    }
    if (this.options.forceDeleteIgnoreRankerHook === true) return;
    for (const factId of ids) {
      try {
        await this.embeddingService.notifyEmbeddingPersisted(entityId, factId, null);
      } catch (hookErr) {
        console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during heal for ${factId}:`, hookErr);
        emitDiagnostic(this.options, { entityId, operation: 'heal', trigger, code: 'hook_failed', detail: { factId, reason: 'on_embedding_persisted' } });
      }
    }
  }

  /**
   * Whether forget() should soft-delete in source_ref_index (#316,
   * specs/forget-pre-v9 §3.1). Normally true: setup()'s DDL creates the table.
   * False only when the table is absent AND the store is pre-v9 (stored
   * schema_version < 9; a missing key or unparseable value counts as 0, like
   * detectSchemaVersion; a store without the meta table at all is not
   * supported and fails as before) — the v9 recovery path, where there is no index row
   * to retire and v9's backfill reads live entries only. A v9+ store without
   * its index is corrupt: throw rather than skip, so the TOCTOU guard is never
   * silently bypassed.
   *
   * Every read runs on `tx`, so a v9 committed by *another connection* between
   * this probe and forget()'s writes can only fail the write-lock upgrade
   * (SQLite serializes writers), never make forget() skip a live index. A
   * setup() racing forget() on the *same* connection (expo passes the shared
   * db as tx) is not serialized against it; v9 runs in autocommit, a
   * pre-existing limit out of scope here. Await setup() before other calls,
   * as WikiMemory.setup() documents.
   */
  private async sourceRefIndexPresent(tx: SQLiteAdapter): Promise<boolean> {
    if (await this.metadataRepo.tableExists(`${this.prefix}source_ref_index`, tx)) return true;
    const raw = await this.metadataRepo.getMeta('schema_version', tx);
    const parsed = raw ? parseInt(raw, 10) : 0;
    const version = Number.isFinite(parsed) ? parsed : 0;
    if (version < 9) return false;
    throw new Error(`forget(): source_ref_index is missing on a schema_version=${version} database; run setup()`);
  }

  /** A never-set-up store has no source-store tables (#316 recovery); nothing to delete there. */
  private async sourceStorePresent(tx: SQLiteAdapter): Promise<boolean> {
    return (await this.metadataRepo.tableExists(`${this.prefix}source_documents`, tx))
      && (await this.metadataRepo.tableExists(`${this.prefix}source_passages`, tx));
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
    params: ForgetParams,
  ): Promise<ForgetResult> {
    // Note: the clearAll mutual-exclusion check is performed by the public
    // forget() before dispatching here. forgetDryRun is private and unreachable
    // for callers that violate that contract, so it does not re-validate.

    if (params.entryId !== undefined && params.includeChain && params.taskId === undefined) {
      const id = await this.entryRepo.findIdById(params.entryId, entityId);
      if (!id) return { deleted: { entries: 0, tasks: 0 }, chainEntryIds: [] };
      const walk = await this.entryRepo.findSupersessionChainWalk(entityId, id, HISTORY_MAX_DEPTH);
      const chainEntryIds = walk.ids.filter((c) => c !== id);
      // Count only live rows: already-soft-deleted chain members would not be deleted by a real call.
      const all = [id, ...chainEntryIds];
      const live = await this.db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL AND id IN (${all.map(() => '?').join(',')})`,
        [entityId, ...all],
      );
      const out: ForgetResult = { deleted: { entries: live?.n ?? 0, tasks: 0 }, chainEntryIds };
      if (walk.truncated) {
        out.truncated = true;
        out.notice = CHAIN_TRUNCATED_NOTICE;
      }
      return out;
    }
    if (params.entryId !== undefined || params.taskId !== undefined) {
      throw new Error('forget({ dryRun: true }) does not support entryId/taskId selectors (entryId is accepted only with includeChain); use sourceRef/sourceHash, eventId, or clearAll');
    }

    if (params.clearAll) {
      const entries = await this.entryRepo.countLiveByEntityId(entityId);
      const tasks = await this.taskRepo.countLiveByEntityId(entityId);
      if (params.includeEvents) {
        const events = await this.eventRepo.count(entityId);
        return { deleted: { entries, tasks, events }, metadataReset: true };
      }
      return { deleted: { entries, tasks }, metadataReset: true };
    }

    // Pointer selector: dispatched BEFORE the no-source-selector early return
    // below, so a valid eventId dry run never silently reports zero
    // (specs/forget-by-event-id §D7).
    if (params.eventId !== undefined) {
      const entries = await this.entryRepo.countLiveByPointerEvent(entityId, params.eventId);
      return { deleted: { entries, tasks: 0 } };
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
  async doRunLibrarian(entityId: string, promptOverride?: string, trigger: WikiDiagnosticTrigger = 'call'): Promise<void> {
    await this.runLibrarianPass({ entityId, trigger, ...(promptOverride !== undefined ? { promptOverride } : {}) });
  }

  /**
   * Seam between the lock wrapper and the strategy dispatcher (spec 2026-09-29
   * §5.1). Builds the strategy deps from `this` and dispatches via
   * `runLibrarianStrategy` so PR-B can plug in `ops/` without touching this
   * class. Returns the strategy's `LibrarianResult` so deferred/budgeted
   * schedulers (PR-C) can advance watermarks; the existing void-returning
   * `doRunLibrarian` discards it.
   *
   * Spec §10.3: one place advances the watermark, for every strategy, only
   * after the pass resolved (its transaction committed) and never backwards.
   * A budget-stopped pass wrote nothing and must not move the watermark.
   */
  async runLibrarianPass(ctx: LibrarianContext): Promise<LibrarianResult> {
    // Specs/librarian-guidance: guidance resolves HERE — once per pass, for
    // every caller (manual runLibrarian and the scheduler's deferred drain
    // both go through this method; MaintenanceScheduler.ts calls
    // runLibrarianPass directly, skipping doRunLibrarian). Any caller-
    // supplied ctx.guidance is ignored and overwritten. Diagnostics emit
    // immediately at resolution, never buffered with the pass results.
    const { guidance, diagnostic } = PromptService.resolveGuidance(this.options.config, ctx.entityId);
    if (diagnostic) {
      emitDiagnostic(this.options, {
        code: diagnostic.code,
        operation: 'librarian',
        trigger: ctx.trigger,
        entityId: ctx.entityId,
        detail: diagnostic.detail,
      });
    }
    const result = await runLibrarianStrategy(this.librarianDeps(), { ...ctx, guidance });
    if (result.processedThrough && !result.budgetStop) {
      await this.advanceLibrarianWatermark(ctx.entityId, result.processedThrough);
    }
    return result;
  }

  /**
   * Strategy deps shared between legacy and ops librarians (spec §5.1). The
   * ops strategy (PR-B Task 8) reads/anchors the watermark through these two
   * hooks so the dispatcher itself never reaches into the metadata table —
   * the watermark invariant (one place advances, never backwards) lives here.
   */
  private librarianDeps() {
    return {
      db: this.db,
      options: this.options,
      entryRepo: this.entryRepo,
      taskRepo: this.taskRepo,
      eventRepo: this.eventRepo,
      searchService: this.searchService,
      embeddingService: this.embeddingService,
      promptService: this.promptService,
      ontologyService: this.ontologyService,
      seedWatermark: (entityId: string) => this.seedLibrarianWatermark(entityId),
      getWatermark: (entityId: string) => this.metadataRepo.getLibrarianWatermark(entityId, this.db),
    };
  }

  /**
   * Persist `next` as the entity's librarian watermark when it is strictly
   * newer than the stored value, under the (created_at, id) ordering used by
   * the op-based librarian (spec §10.3). Never moves backwards.
   */
  private async advanceLibrarianWatermark(entityId: string, next: LibrarianWatermark): Promise<void> {
    const current = await this.metadataRepo.getLibrarianWatermark(entityId, this.db);
    const newer = !current || next.at > current.at || (next.at === current.at && next.id > current.id);
    if (newer) await this.metadataRepo.setLibrarianWatermark(entityId, next, this.db);
  }

  /**
   * Anchor the ops watermark before an auto trigger advances
   * `memory_checkpoint` (spec ops-auto-first-batch §1). No-op when a
   * watermark exists. With legacy history (`preCheckpoint > 0`) it anchors
   * where legacy stopped, as {@link seedLibrarianWatermark} does; without
   * it, it writes {@link START_OF_LOG_WATERMARK}. `total` is the entity's
   * event count, already read by the caller in the same transaction. All
   * reads and the write use the trigger's transaction. Returns the watermark
   * in force afterwards, so the caller need not read it again.
   * Package-internal.
   */
  async anchorWatermarkBeforeTrigger(entityId: string, preCheckpoint: number, total: number, tx: SQLiteAdapter): Promise<LibrarianWatermark> {
    const existing = await this.metadataRepo.getLibrarianWatermark(entityId, tx);
    if (existing) return existing;
    const wm = await this.anchorAtLegacyBoundary(entityId, preCheckpoint, total, tx);
    if (wm) return wm;
    await this.metadataRepo.setLibrarianWatermark(entityId, START_OF_LOG_WATERMARK, tx);
    return START_OF_LOG_WATERMARK;
  }

  /**
   * The one definition of "where legacy stopped" (spec §10.3): anchor the
   * watermark at the event at offset `min(checkpoint, total) - 1`. Writes
   * nothing and returns null when there is no legacy history or no such
   * event; each caller picks its own fallback.
   */
  private anchorAtLegacyBoundary(entityId: string, checkpoint: number, total: number, db: SQLiteAdapter): Promise<LibrarianWatermark | null> {
    return anchorAtLegacyBoundary(this.metadataRepo, this.eventRepo, entityId, checkpoint, total, db);
  }

  /**
   * Spec §10.3: first ops pass on a legacy DB starts after what the count
   * checkpoint already covered. No-op when a watermark already exists or the
   * memory checkpoint is 0; otherwise anchor the watermark to the event at
   * offset `memory_checkpoint - 1`. A checkpoint above the event count is
   * drift and gets {@link START_OF_LOG_WATERMARK} (spec ops-auto-first-batch §2).
   */
  async seedLibrarianWatermark(entityId: string): Promise<void> {
    await seedLegacyWatermark(this.metadataRepo, this.eventRepo, entityId, this.db);
  }

  /**
   * Core heal pass (locks handled by {@link runHeal}). Package-internal orchestration hook.
   *
   * Bounded: at most `batchSize` candidates per pass (#67). Loop on
   * `result.remaining > 0` for convergence — see {@link HealResult.remaining}
   * for what convergence means here, and for the no-progress flags
   * (`searchUnavailable`, `budgetStop`) a loop must also stop on.
   */
  async doRunHeal(
    entityId: string,
    options?: {
      promptOverride?: string;
      batchSize?: number;
      bodyTruncationChars?: number;
      trigger?: WikiDiagnosticTrigger;
      meter?: UsageMeter;
    },
  ): Promise<HealResult> {
    const promptOverride = options?.promptOverride;
    const batchSize = options?.batchSize ?? HEAL_BATCH_SIZE;
    const trigger: WikiDiagnosticTrigger = options?.trigger ?? 'call';
    const diagBase = { entityId, operation: 'heal' as const, trigger };
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

    await this.deliverHealRemovals(entityId, orphanedIds, trigger);

    const healCandidates = await this.entryRepo.findHealCandidatesByEntityId(entityId, batchSize, recheckCutoff);
    // Keyword outage: heal anchors need keyword search, so skip the LLM pass
    // entirely - no spend, no mutation, no heal_checked_at stamps; candidates
    // stay unattempted (spec #280 call-site map).
    const keywordUnavailable = healCandidates.length > 0 && !this.searchService.isKeywordAvailable();
    if (healCandidates.length === 0 || keywordUnavailable) {
      if (keywordUnavailable) {
        emitDiagnostic(this.options, { ...diagBase, code: 'heal_skipped', detail: { reason: 'keyword_search_unavailable', count: healCandidates.length } });
      }
      // The orphan/stale SQL passes above may still have mutated rows, so the
      // search index sync must happen before returning. Both passes return the
      // ids they touched (markOrphaned via RETURNING id, downgradeStaleInferred
      // via select-then-update with the same predicate), so the sync stays
      // O(touched) on the early-return path too (spec §2.4).
      await this.searchService.syncEntries(entityId, Array.from(new Set([...orphanedIds, ...staleDowngradedIds])));
      this.searchService.evictCache(entityId);
      const counts = await this.entryRepo.countHealCandidatesByEntityId(entityId, recheckCutoff);
      return {
        scanned: 0,
        downgraded: staleDowngradedIds.length,
        deleted: orphanedIds.length,
        newFactsCreated: 0,
        skipped: [], degraded: [], remaining: counts.eligible, deferred: counts.deferred,
        // remaining stays > 0 so maybeRunHeal holds the checkpoint back and
        // retries after the outage; the flag lets a host loop stop instead.
        ...(keywordUnavailable ? { searchUnavailable: true as const } : {}),
      };
    }
    // Cap applied once at fetch time. The bound is the one remaining
    // unbounded input to the heal prompt (#101's L0 fix). AllTasks is
    // entity-global; we don't re-fetch per level. L1+ levels omit the
    // array via buildHealPrompt's level logic.
    const allTasks = await this.taskRepo.findAllPending([entityId], HEAL_MAX_TASKS);
    const recentEvents = await this.eventRepo.getRecent(entityId, 20);

    const healGrounding = this.promptService.groundingFor('heal');

    const toPromptShape = (f: WikiFact) => {
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      // grounding: spec §6.2 hides trust fields from a grounding writer only;
      // with heal outside grounding.writers the candidate shape is unchanged.
      const shown = healGrounding
        ? (({ lifecycle_status: _l, okf_verified: _v, last_verified_at: _a, last_verified_by: _b, ...r }) => r)(rest)
        : rest;
      return { ...shown, tags: typeof shown.tags === 'string' ? JSON.parse(shown.tags) : shown.tags };
    };

    // Anchor selection costs a keyword search plus a repository read, and
    // runBatched calls buildPrompt more than once per batch it actually sends —
    // while trimming to maxPromptChars, and again for each half when a batch is
    // split. Prefixes recur heavily across those paths, so memoizing by the
    // query the batch produces collapses the repeats. Scoped to this pass: the
    // index and the anchor rows can both change between heal runs.
    const anchorCache = new Map<string, HealAnchor[]>();

    // runBatched rebuilds prompts while trimming, splitting and escalating, so
    // the corpus is keyed to the exact prompt object each response came from.
    const corpusByPrompt = new WeakMap<BuiltPrompt, string[]>();

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
          healGrounding !== null,
        );
        const { prompts, degraded: batchDegraded, groundingCorpus } = await this.promptService.buildHealPrompt(
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
        if (groundingCorpus !== undefined) corpusByPrompt.set(prompts, groundingCorpus);
        return prompts;
      },
      call: (prompts) => callLlm(this.options, { operation: 'heal', entityId, trigger, meter: options?.meter }, prompts),
      parse: (responseText, batch, prompts) => {
        const result = parseJsonResponse<{ downgraded: string[], deleted: string[], newFacts: ExtractedFact[] }>(responseText);
        return {
          batch,
          downgraded: Array.isArray(result.downgraded) ? result.downgraded : [],
          deleted: Array.isArray(result.deleted) ? result.deleted : [],
          newFacts: Array.isArray(result.newFacts) ? result.newFacts : [],
          corpus: corpusByPrompt.get(prompts) ?? null,
        };
      },
      maxOutputTokens: this.options.llmProvider.maxOutputTokens,
      maxPromptChars: HEAL_MAX_PROMPT_CHARS,
      // heal's buildPrompt sheds anchors per attemptLevel — escalation is real (errata E2)
      supportsEscalation: true,
      onSkip: (fact, err) => {
        if (isContextOverflowError(err)) {
          emitDiagnostic(this.options, {
            entityId, operation: 'heal', trigger, code: 'context_overflow_skipped',
            detail: { factId: fact.id },
          });
          return;
        }
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
    // Position within the producing batch's response, not the merged list, so
    // a diagnostic's itemIndex points into an array the model actually returned.
    const newFactItemIndexes: number[] = [];
    const newFactCorpora: Array<string[] | null> = [];

    for (const batchResult of outcome.results) {
      const mutableIds = new Set(batchResult.batch.map(f => f.id));
      for (const id of batchResult.downgraded) if (mutableIds.has(id)) safeDowngradedSet.add(id);
      for (const id of batchResult.deleted) if (mutableIds.has(id)) safeDeletedSet.add(id);
      batchResult.newFacts.forEach((raw, itemIndex) => {
        newFacts.push(raw);
        newFactItemIndexes.push(itemIndex);
        newFactCorpora.push(batchResult.corpus);
      });
    }

    const safeDowngraded = Array.from(safeDowngradedSet);
    const safeDeleted = Array.from(safeDeletedSet);
    const diagBuffer = new DiagnosticBuffer();
    const validNewFacts: ExtractedFact[] = [];
    const validNewFactItemIndexes: number[] = [];
    const validNewFactCorpora: Array<string[] | null> = [];
    newFacts.forEach((raw, k) => {
      const itemIndex = newFactItemIndexes[k];
      const valid = validateFact(raw);
      if (valid) {
        validNewFacts.push(valid);
        validNewFactItemIndexes.push(itemIndex);
        validNewFactCorpora.push(newFactCorpora[k]);
      } else {
        diagBuffer.push({ ...diagBase, code: 'fact_rejected', detail: { itemIndex, reason: factRejectionReason(raw) } });
      }
    });

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

      for (const [k, fact] of validNewFacts.entries()) {
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

        if (skip) {
          diagBuffer.push({ ...diagBase, code: 'fact_deduplicated', detail: { itemIndex: validNewFactItemIndexes[k], reason: 'fuzzy_title' } });
          continue;
        }

        const id = generateId('fact_');
        // A missing corpus is treated as empty, so every quote fails: fail closed.
        const grounding = healGrounding
          ? groundingOutcome(checkGrounding(fact.evidence, validNewFactCorpora[k] ?? [], healGrounding), now)
          : null;
        if (grounding?.diagnostic) {
          diagBuffer.push({ ...diagBase, code: grounding.diagnostic.code, detail: { factId: id, itemIndex: validNewFactItemIndexes[k], reason: grounding.diagnostic.reason } });
        }
        const factObj: WikiFact = {
          id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
          source_type: 'librarian_inferred', source_hash: null, source_ref: null,
          source_pointer: null,
          created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
          ...grounding?.trust,
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
      // Budget-stopped candidates must NOT receive the cooldown stamp: their
      // fact was never sent to the model, so cooling them down would lock them
      // out of the next pass for HEAL_RECHECK_MS for no reason.
      const unattemptedIds = new Set(outcome.unattempted.map((f) => f.id));
      await this.entryRepo.markHealChecked(
        [
          ...healCandidates.map((f) => f.id).filter((id) => !callErrorIds.has(id) && !unattemptedIds.has(id)),
          ...insertedFacts.map((f) => f.id),
        ],
        entityId,
        now,
        tx,
      );
    });

    for (const { item, reason } of outcome.skipped) {
      diagBuffer.push({ ...diagBase, code: 'heal_skipped', detail: { factId: item.id, reason } });
    }
    diagBuffer.flush(this.options);

    // Union of every id heal's passes touched, all of which are enumerated by
    // the passes themselves: markOrphaned (RETURNING id), downgradeStaleInferred
    // (select-then-update, same predicate), the mutable-ids-guarded batch
    // outcomes, and fresh-id inserts. There is no other `entries` write in this
    // method, so the index update is O(touched), not O(entity) (spec §2.4).
    const healSyncIds = Array.from(new Set([
      ...orphanedIds,
      ...staleDowngradedIds,
      ...safeDowngraded,
      ...uniqueDeletedFactIds,
      ...insertedFacts.map((f) => f.id),
    ]));
    await this.searchService.syncEntries(entityId, healSyncIds);

    await this.deliverHealRemovals(entityId, uniqueDeletedFactIds, trigger);

    for (const fact of insertedFacts) {
      await this.embeddingService.embedFact(fact, { operation: 'heal', trigger });
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
      ...(outcome.budgetStop ? { budgetStop: outcome.budgetStop } : {}),
    };
  }

  /** Core ontology backfill pass (locks handled by {@link runOntologyBackfill}). Package-internal orchestration hook. */
  async doRunOntologyBackfill(
    entityId: string,
    options?: {
      promptOverride?: string;
      batchSize?: number;
      classifier?: 'auto' | 'llm';
      tokenBudget?: number;
      meter?: UsageMeter;
    },
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

    const { mode, manifest: effectiveManifest } = await ontologyService.getEffectiveState(entityId);
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

    // Spec §7.3 / REQ-COMPAT-01.5: capability alone never switches paths.
    const classifierMode = options?.classifier ?? this.options.config?.ontology?.backfillClassifier ?? 'llm';
    const classify = this.options.llmProvider.classify;
    if (classifierMode === 'auto' && typeof classify === 'function') {
      const slugs = effectiveManifest.node_types.map((n) => n.type);
      if (slugs.length > 0 && slugs.length <= 255) {
        return this._runClassifierBackfill(entityId, candidates, effectiveManifest, now, recheckCutoff, options?.meter);
      }
    }

    const ontologyContext = await ontologyService.buildPromptContext(entityId);

    // #381 fix: the classifier prompt gains the title catalog — the verifiable
    // target pool of already-typed nodes (same index and title normalization
    // edge resolution uses; the block dedupes on the normalized key). Timing
    // note: the catalog reads the index once per pass outside a transaction,
    // while resolution re-reads it inside each batch's tx — a node deleted or
    // retyped in between makes a listed title unresolvable, so entries are
    // verifiable as of prompt-build time, not write time. NOTE (honesty): the
    // 0/28 → 28/28 E1 result measured a SEED-ONLY catalog variant via
    // runner-level promptOverride (results/statement-kinds-e1-title-catalog-
    // 2026-11-18.json); this shipped block covers all typed nodes and has not
    // itself been benchmarked yet. The wording is deliberately non-exclusive:
    // same-batch targets and titles beyond the 200-entry cap remain valid.
    // The catalog is built once per pass, so facts typed in an earlier batch
    // of the same run are accepted targets but are not listed yet — another
    // known divergence from the E1 variant.
    const titleRows = await this.entryRepo.findTitleIndexByEntityId(entityId);
    const titleCatalog = buildTitleCatalogBlock(titleRows);

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
      titleCatalog,
    );

    const outcome = await runBatched<WikiFact, OntologyBackfillBatch>({
      items: candidates,
      buildPrompt,
      call: (prompts) => callLlm(this.options, { operation: 'ontologyBackfill', entityId, trigger: 'call', meter: options?.meter }, prompts),
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
        if (isContextOverflowError(err)) {
          emitDiagnostic(this.options, {
            entityId, operation: 'ontologyBackfill', trigger: 'call', code: 'context_overflow_skipped',
            detail: { factId: fact.id },
          });
          return;
        }
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
        ...(outcome.budgetStop ? { budgetStop: outcome.budgetStop } : {}),
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
      ...(outcome.budgetStop ? { budgetStop: outcome.budgetStop } : {}),
    };
  }

  /**
   * Classifier-mode backfill (spec §7.3): one `choice` question per untyped
   * fact over the effective manifest's node-type slugs. Accepted answers go
   * through `_applyOntologyBackfillBatch` exactly like LLM classifications.
   * No edges are proposed.
   */
  private async _runClassifierBackfill(
    entityId: string,
    candidates: WikiFact[],
    manifest: OntologyManifest,
    now: number,
    recheckCutoff: number,
    meter?: UsageMeter,
  ): Promise<OntologyBackfillResult> {
    const rawMin = this.options.config?.ontology?.classifyMinConfidence;
    const minConfidence = typeof rawMin === 'number' && Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 1 ? rawMin : 0.5;
    const rawConcurrency = this.options.config?.chunkConcurrency ?? 1;
    const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;

    // Manifest descriptions are host-authored ontology vocabulary, not fact content.
    const question: ClassifierQuestion = {
      kind: 'choice',
      options: manifest.node_types.map((n) => n.type),
      instructions:
        'Choose the ontology node type that best describes this fact.\n' +
        manifest.node_types.map((n) => `- ${n.type}: ${n.description}`).join('\n'),
    };

    type Outcome =
      | { fact: WikiFact; kind: 'accepted'; okfType: string }
      | { fact: WikiFact; kind: 'low_confidence' }
      | { fact: WikiFact; kind: 'invalid'; reason: ClassifierRejection }
      | { fact: WikiFact; kind: 'threw'; overflow?: boolean }
      | { fact: WikiFact; kind: 'unattempted' };

    let stopped: WikiBudgetExhausted | undefined;
    const outcomes = await withConcurrency<Outcome>(
      candidates.map((fact) => async (): Promise<Outcome> => {
        if (stopped) return { fact, kind: 'unattempted' as const };
        let response: ClassifyResponse;
        try {
          response = await callClassify(
            this.options,
            { operation: 'ontologyBackfill', entityId, trigger: 'call', meter },
            { state: classifierStateForFact(fact), questions: { okf_type: question } },
          );
        } catch (err) {
          if (err instanceof WikiBudgetExhausted) {
            stopped ??= err;
            return { fact, kind: 'unattempted' as const };
          }
          if (isContextOverflowError(err)) return { fact, kind: 'threw', overflow: true };
          return { fact, kind: 'threw' };
        }
        const checked = validateClassifierAnswer(response, 'okf_type', question);
        if (!checked.ok) return { fact, kind: 'invalid', reason: checked.reason };
        if (checked.answer.kind !== 'choice') return { fact, kind: 'invalid', reason: 'kind_mismatch' };
        if (checked.answer.confidence < minConfidence) return { fact, kind: 'low_confidence' };
        return { fact, kind: 'accepted', okfType: checked.answer.choice };
      }),
      concurrency,
    );

    // Thrown calls are transient (like `call_error`): no cooldown stamp.
    const attempted = outcomes.filter((o) => o.kind !== 'threw' && o.kind !== 'unattempted').map((o) => o.fact);
    const unattemptedCount = outcomes.filter((o) => o.kind === 'unattempted').length;
    const skipped = outcomes.length - attempted.length - unattemptedCount;
    const classifications = outcomes
      .filter((o): o is Extract<Outcome, { kind: 'accepted' }> => o.kind === 'accepted')
      .map((o) => ({ id: o.fact.id, okf_type: o.okfType }));
    const invalidCount = outcomes.filter((o) => o.kind === 'invalid').length;

    let typed = 0;
    let failedValidation = 0;
    let edgesAdded = 0;
    let aborted = false;
    if (attempted.length > 0) {
      const applied = await this._applyOntologyBackfillBatch(
        entityId,
        { batch: attempted, classifications, ontologyUpdates: undefined },
        now,
      );
      aborted = applied.abortedOntologyOff;
      if (!aborted) {
        typed = applied.typed;
        failedValidation = invalidCount + applied.failedValidation;
        edgesAdded = applied.edgesAdded;
      }
    }

    const diagBuffer = new DiagnosticBuffer();
    const diagBase = { entityId, operation: 'ontologyBackfill' as const, trigger: 'call' as const };
    for (const o of outcomes) {
      if (o.kind === 'low_confidence') {
        diagBuffer.push({ ...diagBase, code: 'classification_low_confidence', detail: { factId: o.fact.id, reason: 'below_threshold' } });
      } else if (o.kind === 'invalid') {
        diagBuffer.push({ ...diagBase, code: 'classification_invalid', detail: { factId: o.fact.id, reason: o.reason } });
      } else if (o.kind === 'threw') {
        diagBuffer.push({ ...diagBase, code: 'classification_invalid', detail: { factId: o.fact.id, reason: 'classify_threw' } });
        if (o.overflow) {
          diagBuffer.push({ ...diagBase, code: 'context_overflow_skipped', detail: { factId: o.fact.id } });
        }
      }
    }
    // After the apply transaction committed (spec §4.2.4). Classifier answers
    // are reported even on an ontology-off abort: they describe the provider,
    // not a write.
    diagBuffer.flush(this.options);

    const counts = await this.entryRepo.countUntypedByEntityId(entityId, recheckCutoff);
    if (aborted) {
      // Mirrors the LLM path: nothing from the aborted batch was written; the host loop terminates.
      return { scanned: 0, typed: 0, failedValidation: 0, edgesAdded: 0, skipped, remaining: 0, deferred: counts.deferred };
    }
    this.searchService.evictCache(entityId);
    return {
      scanned: candidates.length - unattemptedCount,
      typed,
      failedValidation,
      edgesAdded,
      skipped,
      remaining: counts.eligible,
      deferred: counts.deferred,
      ...(stopped ? { budgetStop: { requiredEstimate: stopped.requiredEstimate } } : {}),
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
    const diagBuffer = new DiagnosticBuffer();
    const diagBase = { entityId, operation: 'ontologyBackfill' as const, trigger: 'call' as const };

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

        const validationDrops: EdgeDrop[] = [];
        const normalized = ontologyService.validateAndNormalizeFact(
          {
            title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
            okf_type: classification.okf_type as string | undefined, edges: classification.edges as ExtractedFactEdge[] | undefined,
          } as ExtractedFactWithOntology,
          manifest,
          { strict: false, drops: validationDrops },
        );
        for (const drop of validationDrops) {
          diagBuffer.push(edgeDropDiagnostic(drop, { ...diagBase, factId: fact.id }));
        }
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
        const resolveDrops: EdgeDrop[] = [];
        const added = await ontologyService.resolveAndPersistEdges(
          entityId, item.sourceId, item.sourceType, item.edges, manifest, titleIndex, tx, now, resolveDrops,
        );
        edgesAdded += added;
        for (const drop of resolveDrops) {
          diagBuffer.push(edgeDropDiagnostic(drop, diagBase));
        }
      }

      await this.entryRepo.markOntologyChecked(batch.map(f => f.id), entityId, now, tx);
    });

    diagBuffer.flush(this.options);

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
    withBodies: boolean = false,
  ): Promise<HealAnchor[]> {
    const query = batch.map(f => f.title).join(' ').trim();
    if (!query) return [];

    const cached = cache?.get(query);
    if (cached) return cached;

    // Overfetch is sized off the cap we were given, not the global max —
    // a single-candidate query asks for fewer search hits.
    const hits = await this.searchService.searchKeyword(
      query,
      [entityId],
      cap * HEAL_ANCHOR_SEARCH_OVERFETCH,
    );
    const hitIds = hits.map(h => h.id);

    const anchors: HealAnchor[] = [];
    if (hitIds.length > 0) {
      const rows = withBodies
        ? await this.entryRepo.findAnchorRowsByIds(entityId, hitIds, undefined, { withBody: true })
        : await this.entryRepo.findAnchorRowsByIds(entityId, hitIds);
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
