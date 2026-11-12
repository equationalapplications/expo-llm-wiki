import type { SQLiteAdapter, WikiOptions, WikiDiagnosticTrigger, WikiDiagnosticOperation } from '../types';
import { HOOK_TIMEOUT_MARKER } from '../types';
import type {
  VectorRemovalRepository,
  VectorRemovalScope,
  LedgerRow,
} from '../repositories/VectorRemovalRepository';
import type { EmbeddingService } from './EmbeddingService';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import { emitDiagnostic } from '../utils/diagnostics';

export type DrainScope = { entityId: string; ids?: string[] } | { all: true };

export interface DrainResult {
  confirmed: number;
  pending: number;
  failedIds: string[];
  timedOut: boolean;
  /** True when a page read or a settling write failed; rows stay pending. */
  transient?: boolean;
  firstCause?: Error;
}

export interface DrainOptions {
  /** Absolute `Date.now()` time after which no further calls are made. */
  deadlineAt?: number;
  backoff?: boolean;
  trigger?: WikiDiagnosticTrigger;
}

const JOINED = Symbol('vectorRemovalJoined');
const MARKER_KEY = 'external_index_in_use';
const PAGE = 100;
const ID_CHUNK = 500;
const MAX_FAILED_IDS = 100;
const MAX_CONSECUTIVE_REJECTIONS = 5;

/** Drains the vector_removals ledger through the host's removal hook (spec §5.3-5.4). */
export class VectorRemovalService {
  private inFlight = new Map<string, { seq: number; promise: Promise<void> }>();

  constructor(
    private db: SQLiteAdapter,
    private options: WikiOptions,
    private repo: VectorRemovalRepository,
    private embeddingService: EmbeddingService,
    private metadataRepo: MetadataRepository,
  ) {}

  gate(): 'hook' | 'none' | 'force' {
    if (this.options.forceDeleteIgnoreRankerHook === true) return 'force';
    if (this.options.vectorRanker?.onEmbeddingPersisted) return 'hook';
    return 'none';
  }

  private ledgerSeen = false;
  async ledgerPresent(): Promise<boolean> {
    if (this.ledgerSeen) return true;
    this.ledgerSeen = await this.metadataRepo.tableExists(this.repo.ledgerTable);
    return this.ledgerSeen;
  }

  /** One `hook_failed` diagnostic per id (the removal stays owed). */
  emitHookFailed(
    entityId: string,
    ids: string[],
    operation: WikiDiagnosticOperation,
    trigger: WikiDiagnosticTrigger,
  ): void {
    for (const factId of ids) {
      emitDiagnostic(this.options, {
        entityId, operation, trigger, code: 'hook_failed',
        detail: { factId, reason: 'on_embedding_persisted' },
      });
    }
  }

  /**
   * Post-commit delivery for heal, ingest and import (spec §5.7). Never throws:
   * a failed id emits `hook_failed` and stays owed on the ledger. Without a
   * ledger table (setup never ran) it falls back to a best-effort call per id.
   * Under `forceDeleteIgnoreRankerHook` no removal call is made.
   */
  async deliverRemovals(
    entityId: string,
    ids: string[],
    operation: WikiDiagnosticOperation,
    trigger: WikiDiagnosticTrigger,
    fallbackIds: string[] = ids,
  ): Promise<void> {
    try {
      if (await this.ledgerPresent()) {
        if (ids.length === 0) return;
        const r = await this.drain({ entityId, ids }, { trigger });
        this.emitHookFailed(entityId, r.failedIds, operation, trigger);
        if (r.pending > 0) await this.emitPending(entityId, trigger);
        return;
      }
      if (this.gate() !== 'hook') return;
      for (const factId of new Set(fallbackIds)) {
        try {
          await this.embeddingService.notifyEmbeddingPersisted(entityId, factId, null);
        } catch (hookErr) {
          console.warn(`[WikiMemory] onEmbeddingPersisted(vector=null) hook failed for ${factId}:`, hookErr);
          this.emitHookFailed(entityId, [factId], operation, trigger);
        }
      }
    } catch (err) {
      console.warn('[WikiMemory] removal delivery failed:', err);
      let stillPending = ids;
      try {
        const st = await this.repo.statusFor(ids);
        stillPending = ids.filter((id) => st.get(id) === 'pending');
      } catch {
        // keep the full list: better a spurious diagnostic than a silent one
      }
      this.emitHookFailed(entityId, stillPending, operation, trigger);
    }
  }

  async markExternalIndexInUse(tx: SQLiteAdapter): Promise<void> {
    await this.metadataRepo.setMeta(MARKER_KEY, '1', tx);
  }

  async externalIndexInUse(): Promise<boolean> {
    return (await this.metadataRepo.getMeta(MARKER_KEY)) === '1';
  }

  async drain(scope: DrainScope, opts: DrainOptions = {}): Promise<DrainResult> {
    const trigger = opts.trigger ?? 'call';
    const entityId = 'all' in scope ? undefined : scope.entityId;
    const ids = 'all' in scope ? undefined : scope.ids;
    const gate = this.gate();

    if (gate === 'none') {
      const pending = await this.pendingFor(entityId, ids);
      if (pending > 0 && (await this.externalIndexInUse())) await this.emitPending(entityId, trigger);
      return { confirmed: 0, pending, failedIds: [], timedOut: false };
    }

    if (gate === 'force') {
      const entities = entityId === undefined ? await this.repo.entitiesWithPending() : [entityId];
      const counts: Array<[string, number]> = [];
      for (const e of entities) counts.push([e, (await this.repo.pendingStats(e)).count]);
      await this.repo.discardPending(entityId);
      await this.metadataRepo.deleteMeta(MARKER_KEY);
      for (const [e, count] of counts) {
        if (count === 0) continue;
        emitDiagnostic(this.options, {
          code: 'external_deletion_discarded',
          operation: 'externalDeletion',
          trigger,
          entityId: e,
          detail: { count },
        });
      }
      return { confirmed: 0, pending: 0, failedIds: [], timedOut: false };
    }

    const timeoutMs = this.embeddingService.validateDeletionTimeout();
    const result: DrainResult = { confirmed: 0, pending: 0, failedIds: [], timedOut: false };
    let timeoutErr: Error | undefined;
    let firstRejection: Error | undefined;
    let consecutive = 0;
    let stop = false;
    let transient = false;
    const tried = new Set<number>();

    const scopes: VectorRemovalScope[] =
      entityId === undefined
        ? [{}]
        : ids === undefined
          ? [{ entityId }]
          : chunk(ids, ID_CHUNK).map((c) => ({ entityId, ids: c }));
    const maxSeq = await this.repo.maxSeq();

    for (const sc of scopes) {
      if (stop || transient) break;
      let cursor = { maxSeq, attempts: -1, seq: 0 };
      while (!stop) {
        let page: LedgerRow[];
        try {
          page = await this.db.withTransactionAsync((tx) =>
            this.repo.readPage(sc, cursor, PAGE, tx),
          );
        } catch {
          transient = true;
          result.transient = true;
          break;
        }
        if (page.length === 0) break;
        const last = page[page.length - 1];
        cursor = { maxSeq, attempts: last.attempts, seq: last.seq };

        const confirmSeqs: number[] = [];
        const bumpSeqs: number[] = [];
        const deleteSeqs: number[] = [];
        const goneSeqs: number[] = [];

        for (const row of page) {
          if (tried.has(row.seq)) continue;
          if (row.fact_state === 'live') {
            tried.add(row.seq);
            deleteSeqs.push(row.seq);
            continue;
          }
          if (opts.backoff === true && row.last_attempt_at !== null) {
            const waitMs = Math.min(2 ** row.attempts, 3600) * 1000;
            if (Date.now() - row.last_attempt_at < waitMs) continue;
          }
          let budget = timeoutMs;
          if (opts.deadlineAt !== undefined) {
            const left = opts.deadlineAt - Date.now();
            if (left <= 0) {
              stop = true;
              break;
            }
            budget = Math.min(timeoutMs, left);
          }
          tried.add(row.seq);
          try {
            const joined = await this.callFor(row, budget);
            consecutive = 0;
            if (!joined) {
              if (row.fact_state === 'gone') goneSeqs.push(row.seq);
              else confirmSeqs.push(row.seq);
            }
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            if (!(e as any)[JOINED]) bumpSeqs.push(row.seq);
            if (result.failedIds.length < MAX_FAILED_IDS) result.failedIds.push(row.fact_id);
            if ((e as any)[HOOK_TIMEOUT_MARKER] === true) {
              result.timedOut = true;
              timeoutErr ??= e;
              stop = true;
              break;
            }
            firstRejection ??= e;
            if (++consecutive >= MAX_CONSECUTIVE_REJECTIONS) {
              stop = true;
              break;
            }
          }
        }

        if (confirmSeqs.length || bumpSeqs.length || deleteSeqs.length || goneSeqs.length) {
          const now = Date.now();
          try {
            const changed = await this.db.withTransactionAsync(async (tx) => {
              let n = 0;
              if (confirmSeqs.length) n += await this.repo.confirm(confirmSeqs, now, tx);
              if (bumpSeqs.length) await this.repo.bumpAttempts(bumpSeqs, now, tx);
              if (goneSeqs.length) n += await this.repo.deleteBySeq(goneSeqs, tx);
              if (deleteSeqs.length) await this.repo.deleteBySeq(deleteSeqs, tx);
              return n;
            });
            result.confirmed += changed;
          } catch {
            transient = true;
            result.transient = true;
            break;
          }
        }
        if (page.length < PAGE) break;
      }
    }

    result.firstCause = timeoutErr ?? firstRejection;
    result.pending = await this.pendingFor(entityId, ids);
    return result;
  }

  /**
   * Resolves `true` when this drain joined another drain's call for the same
   * seq (the caller then settles nothing), `false` when it made the call.
   * Rejections from a joined call carry the JOINED flag so they are not bumped twice.
   */
  private async callFor(row: LedgerRow, budgetMs: number): Promise<boolean> {
    const end = Date.now() + budgetMs;
    const left = () => Math.max(1, end - Date.now());
    let existing = this.inFlight.get(row.fact_id);
    while (existing && existing.seq !== row.seq) {
      await withBudget(existing.promise.catch(() => {}), left());
      const next = this.inFlight.get(row.fact_id);
      existing = next === existing ? undefined : next;
    }
    if (existing) {
      try {
        await withBudget(existing.promise, left());
      } catch (err) {
        if (err instanceof Error) (err as any)[JOINED] = true;
        throw err;
      }
      return true;
    }
    const p = this.embeddingService.callRemovalHook(row.entity_id, row.fact_id, left());
    const entry = { seq: row.seq, promise: p };
    this.inFlight.set(row.fact_id, entry);
    const clear = () => {
      if (this.inFlight.get(row.fact_id) === entry) this.inFlight.delete(row.fact_id);
    };
    p.then(clear, clear);
    await p;
    return false;
  }

  private async pendingFor(entityId?: string, ids?: string[]): Promise<number> {
    if (entityId !== undefined && ids !== undefined) {
      return this.repo.pendingCountForIds(entityId, ids);
    }
    return (await this.repo.pendingStats(entityId)).count;
  }

  private async emitPending(entityId: string | undefined, trigger: WikiDiagnosticTrigger) {
    const entities = entityId === undefined ? await this.repo.entitiesWithPending() : [entityId];
    for (const e of entities) {
      const st = await this.repo.pendingStats(e);
      if (st.count === 0) continue;
      emitDiagnostic(this.options, {
        code: 'external_deletion_pending',
        operation: 'externalDeletion',
        trigger,
        entityId: e,
        detail: {
          count: st.count,
          ...(st.oldestEnqueuedAt !== null ? { oldestEnqueuedAt: st.oldestEnqueuedAt } : {}),
          maxAttempts: st.maxAttempts,
        },
      });
    }
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Race `p` against a timer; the timeout error carries HOOK_TIMEOUT_MARKER and `p` keeps running. */
function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      const e = new Error(`onEmbeddingPersisted timed out after ${ms}ms`);
      (e as any)[HOOK_TIMEOUT_MARKER] = true;
      (e as any)[JOINED] = true;
      reject(e);
    }, ms);
  });
  return Promise.race([p, timer]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}
