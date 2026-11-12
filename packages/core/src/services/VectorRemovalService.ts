import type { SQLiteAdapter, WikiOptions, WikiDiagnosticTrigger } from '../types';
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
  firstCause?: Error;
}

export interface DrainOptions {
  deadlineMs?: number;
  backoff?: boolean;
  trigger?: WikiDiagnosticTrigger;
}

const MARKER_KEY = 'external_index_in_use';
const PAGE = 100;
const ID_CHUNK = 500;
const MAX_FAILED_IDS = 100;
const MAX_CONSECUTIVE_REJECTIONS = 5;

/** Drains the vector_removals ledger through the host's removal hook (spec §5.3-5.4). */
export class VectorRemovalService {
  private inFlight = new Map<string, Promise<void>>();

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
      await this.emitPending(entityId, trigger);
      return { confirmed: 0, pending, failedIds: [], timedOut: false };
    }

    if (gate === 'force') {
      const count = await this.repo.discardPending(entityId);
      await this.metadataRepo.deleteMeta(MARKER_KEY);
      emitDiagnostic(this.options, {
        code: 'external_deletion_discarded',
        operation: 'externalDeletion',
        trigger,
        entityId: entityId ?? '*',
        detail: { count },
      });
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
          break;
        }
        if (page.length === 0) break;
        const last = page[page.length - 1];
        cursor = { maxSeq, attempts: last.attempts, seq: last.seq };

        const confirmSeqs: number[] = [];
        const bumpSeqs: number[] = [];
        const deleteSeqs: number[] = [];

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
          if (opts.deadlineMs !== undefined) {
            const left = opts.deadlineMs - Date.now();
            if (left <= 0) {
              stop = true;
              break;
            }
            budget = Math.min(timeoutMs, left);
          }
          tried.add(row.seq);
          try {
            await this.callOnce(row.entity_id, row.fact_id, budget);
            consecutive = 0;
            if (row.fact_state === 'gone') deleteSeqs.push(row.seq);
            else confirmSeqs.push(row.seq);
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            bumpSeqs.push(row.seq);
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

        if (confirmSeqs.length || bumpSeqs.length || deleteSeqs.length) {
          const now = Date.now();
          await this.db.withTransactionAsync(async (tx) => {
            if (confirmSeqs.length) await this.repo.confirm(confirmSeqs, now, tx);
            if (bumpSeqs.length) await this.repo.bumpAttempts(bumpSeqs, now, tx);
            if (deleteSeqs.length) await this.repo.deleteBySeq(deleteSeqs, tx);
          });
        }
        result.confirmed += confirmSeqs.length;
        if (page.length < PAGE) break;
      }
    }

    result.firstCause = timeoutErr ?? firstRejection;
    result.pending = await this.pendingFor(entityId, ids);
    return result;
  }

  private callOnce(entityId: string, factId: string, timeoutMs: number): Promise<void> {
    const existing = this.inFlight.get(factId);
    if (existing) return existing;
    const p = this.embeddingService.callRemovalHook(entityId, factId, timeoutMs);
    this.inFlight.set(factId, p);
    const clear = () => {
      if (this.inFlight.get(factId) === p) this.inFlight.delete(factId);
    };
    p.then(clear, clear);
    return p;
  }

  private async pendingFor(entityId?: string, ids?: string[]): Promise<number> {
    if (entityId !== undefined && ids !== undefined) {
      const st = await this.repo.statusFor(ids);
      let n = 0;
      for (const v of st.values()) if (v === 'pending') n++;
      return n;
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
