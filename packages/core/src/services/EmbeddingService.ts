import type { SQLiteAdapter, WikiOptions, EmbeddingMarkerKind, WikiDiagnosticOperation, WikiDiagnosticTrigger } from '../types';
import { HOOK_TIMEOUT_MARKER } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import { clip } from '../utils/pure';
import { DEFAULT_MAX_EMBED_CHARS, EMBED_CHARS_CEILING } from '../utils/embedDefaults';
import type { VectorRemovalService } from './VectorRemovalService';
import type { VectorRemovalRepository } from '../repositories/VectorRemovalRepository';
import { emitDiagnostic } from '../utils/diagnostics';

export type { EmbeddingMarkerKind };

export type EmbedFailureKind =
  | EmbeddingMarkerKind
  | 'no_provider'
  | 'storage_error'
  | 'fact_deleted';

export type EmbedFactResult =
  | { ok: true; dimension: number }
  | { ok: false; kind: EmbedFailureKind };

export interface EmbedDiagnosticContext {
  operation: WikiDiagnosticOperation;
  trigger: WikiDiagnosticTrigger;
}

export class EmbeddingService {
  constructor(
    private db: SQLiteAdapter,
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private metadataRepo: MetadataRepository,
  ) {}

  async storeEmbeddingDimension(dim: number): Promise<void> {
    const existing = await this.metadataRepo.getMeta('embedding_dimension');
    if (existing) {
      const storedDim = parseInt(existing, 10);
      if (storedDim !== dim) {
        console.warn(
          `[WikiMemory] Embedding dimension mismatch: stored ${storedDim}, got ${dim}. ` +
            `Call runReembed() to rebuild embeddings with the new model.`,
        );
        await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(dim), this.db);
      }
      // Do not clear embedding_dimension_mismatch here; only reconcileEmbeddingDimension()
      // may clear it after a full runReembed confirms all blobs match.
    } else {
      await this.metadataRepo.setMeta('embedding_dimension', String(dim), this.db);
    }
  }

  /**
   * Promotes embedding_dimension_mismatch to canonical embedding_dimension when
   * safe, and clears embedding failure markers as part of the same event.
   *
   * Marker reset (spec §2.3): a promoted dimension means a different model is
   * producing the vectors, so prior failures no longer predict future ones.
   * `float32_overflow` is cleared too — it is terminal only because retrying is
   * the same arithmetic on the same vector, and after a model change it is not.
   *
   * All three writes commit atomically; see the transaction note inline.
   *
   * Revived rows are NOT embedded here. They become eligible and are picked up
   * by the NEXT sweep, because runReembed calls this after its candidates were
   * already classified; same-sweep revival would be re-entrant.
   *
   * Caller contract (spec 2026-09-05 §3.2): callers must not invoke this while
   * a reembed sweep is in flight unless they hold that sweep's lock, because
   * the marker clear spans every entity. `runReembed`'s tail call is exempt —
   * by the tail, the sweep's classification phase is complete, so the clear
   * cannot resurrect a row THIS sweep classified; any overlap with a
   * concurrent import's entity-scoped, blob-guarded writes (an importDump of a
   * different entity can run during a per-entity sweep) is bounded redundant
   * work. External callers
   * gate on `JobManager.isAnyReembedActive()` and defer. This service
   * deliberately holds no `JobManager` reference: gating here instead of at
   * the call site would make `runReembed`'s own tail call see its own lock and
   * defer forever.
   */
  async reconcileEmbeddingDimension(): Promise<void> {
    const mismatchValue = await this.metadataRepo.getMeta('embedding_dimension_mismatch');
    if (!mismatchValue) return;

    const newDim = parseInt(mismatchValue, 10);
    const residualCount = await this.entryRepo.countStaleEmbeddings(newDim);
    if (residualCount === 0) {
      // One transaction for the whole promotion (spec §2.3): the three writes
      // are a single logical event. Committed separately, a failure after
      // clearDimensionMismatch would leave markers set with no mismatch key
      // left to re-trigger promotion, stranding those rows until `force: true`.
      // Safe to open here — both callers (runReembed, importDump's dimension
      // reconciliation) invoke this outside their own transactions, and the
      // adapter does not support nesting.
      await this.db.withTransactionAsync(async (tx) => {
        await this.metadataRepo.setMeta('embedding_dimension', mismatchValue, tx);
        await this.metadataRepo.clearDimensionMismatch(tx);
        await this.entryRepo.clearEmbeddingFailureMarkers(tx);
      });
    }
  }

  async tryEmbedFact(fact: {
    id: string;
    entity_id: string;
    title: string;
    body: string;
    tags: string | string[];
  }, ctx?: EmbedDiagnosticContext): Promise<EmbedFactResult> {
    const r = await this.embedTextForFact(fact, ctx);
    return r.ok ? this.storeFactVector(fact, r.vector, ctx) : r;
  }

  /**
   * Compute half: build the embed text, call embed(), validate the result,
   * mark any embed-time failure, and return the validated Float32 vector.
   *
   * Failure kinds: `no_provider`, `invalid_vector`, `float32_overflow`,
   * `provider_error`. All embed-time failures are marked via `markFailure`;
   * `no_provider` deliberately does not mark (spec §2.4).
   *
   * Storage errors are NOT possible here — that is `storeFactVector`'s domain.
   */
  async embedTextForFact(
    fact: {
      id: string;
      entity_id: string;
      title: string;
      body: string;
      tags: string | string[];
    },
    ctx?: EmbedDiagnosticContext,
    opts?: { markFailures?: boolean },
  ): Promise<{ ok: true; vector: Float32Array } | { ok: false; kind: EmbedFailureKind }> {
    const markFailures = opts?.markFailures !== false;
    // Callability, not truthiness: a truthy non-function would pass a `!embedFn`
    // guard, throw TypeError at the call, and be marked `provider_error` —
    // burning an attempt per sweep until a host config error permanently
    // excluded the fact. `no_provider` never marks. (spec §2.4)
    if (typeof this.options.llmProvider.embed !== 'function') return { ok: false, kind: 'no_provider' };
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
    const configuredMaxEmbedChars = this.options.config?.maxEmbedChars;
    const maxEmbedChars = Number.isFinite(configuredMaxEmbedChars)
      ? Math.min(Math.max(0, Math.trunc(configuredMaxEmbedChars as number)), EMBED_CHARS_CEILING)
      : DEFAULT_MAX_EMBED_CHARS;
    const text = clip(`${fact.title} ${fact.body} ${tagsStr}`.trim(), maxEmbedChars);
    let float32Vector: Float32Array;
    try {
      const vector = await this.options.llmProvider.embed(text);
      if (vector.length === 0 || !vector.every(v => typeof v === 'number' && isFinite(v))) {
        console.warn(`[WikiMemory] embedFact: embed() returned an invalid vector for ${fact.id}; skipping.`);
        if (markFailures) this.reportEmbed(ctx, fact, 'embedding_failed', 'invalid_vector');
        if (markFailures) await this.markFailure(fact.id, 'invalid_vector');
        return { ok: false, kind: 'invalid_vector' };
      }
      float32Vector = new Float32Array(vector);
      let hasNonFinite = false;
      for (let i = 0; i < float32Vector.length; i++) {
        if (!isFinite(float32Vector[i])) {
          hasNonFinite = true;
          break;
        }
      }
      if (hasNonFinite) {
        console.warn(`[WikiMemory] embedFact: embed() returned values that overflow float32 for ${fact.id}; skipping.`);
        if (markFailures) this.reportEmbed(ctx, fact, 'embedding_failed', 'float32_overflow');
        if (markFailures) await this.markFailure(fact.id, 'float32_overflow');
        return { ok: false, kind: 'float32_overflow' };
      }
    } catch (err) {
      console.warn(`[WikiMemory] embedFact failed for ${fact.id}:`, err);
      if (markFailures) this.reportEmbed(ctx, fact, 'embedding_failed', 'embed_threw');
      if (markFailures) await this.markFailure(fact.id, 'provider_error');
      return { ok: false, kind: 'provider_error' };
    }
    return { ok: true, vector: float32Vector };
  }

  /**
   * Storage half: persist the computed vector to the entry row, then fire the
   * `onEmbeddingPersisted` hook. Failure kinds: `storage_error` (a DB error) and
   * `fact_deleted` (the row was soft-deleted or gone: no blob, no vector call, no
   * marker). Embed failures do not originate here, so they cannot be marked as
   * such (spec §3.2, D3).
   */
  async storeFactVector(fact: {
    id: string;
    entity_id: string;
  }, float32Vector: Float32Array, ctx?: EmbedDiagnosticContext): Promise<EmbedFactResult> {
    // Storage is a separate failure domain: a DB error here is NOT an
    // embedding failure and must not be marked as one (spec §3.2, D3).
    let stored = true;
    try {
      await this.storeEmbeddingDimension(float32Vector.length);
      const blob = new Uint8Array(float32Vector.buffer);
      stored = (await this.entryRepo.updateEmbeddingBlob(fact.id, blob)).changes > 0;
    } catch (err) {
      console.warn(`[WikiMemory] embedFact: persisting embedding failed for ${fact.id}:`, err);
      this.reportEmbed(ctx, fact, 'embedding_failed', 'persist_failed');
      return { ok: false, kind: 'storage_error' };
    }

    // The fact was deleted while its embed was in flight: no blob, no vector call (G10).
    if (!stored) return { ok: false, kind: 'fact_deleted' };

    try {
      await this.notifyEmbeddingPersisted(fact.entity_id, fact.id, float32Vector);
    } catch (hookErr) {
      console.warn(`[WikiMemory] onEmbeddingPersisted hook failed for ${fact.id}:`, hookErr);
      this.reportEmbed(ctx, fact, 'hook_failed', 'on_embedding_persisted');
    }
    // A vector call was made (resolved or not): if the fact was deleted while
    // it ran, take the vector back. Every embed path passes here; import's
    // preserved-blob loop calls settleAfterVectorCall itself (spec §5.7, G10).
    if (this.hasVectorHook()) {
      await this.settleAfterVectorCall(fact.entity_id, fact.id, ctx?.operation ?? 'externalDeletion', ctx?.trigger ?? 'call');
    }
    return { ok: true, dimension: float32Vector.length };
  }

  hasVectorHook(): boolean {
    return !!this.options.vectorRanker?.onEmbeddingPersisted;
  }

  /**
   * Run after a vector call (resolved or not) by every path that sends one.
   * Never throws: a failure here leaves the removal owed or unrecorded, as before.
   */
  async settleAfterVectorCall(
    entityId: string,
    factId: string,
    operation: WikiDiagnosticOperation,
    trigger: WikiDiagnosticTrigger,
  ): Promise<void> {
    const vr = this.vectorRemoval;
    if (!vr) return;
    const outcome = await this.recordAfterVectorCall(entityId, factId);
    if (outcome === 'enqueued') {
      try {
        await vr.service.deliverRemovals(entityId, [factId], operation, trigger, []);
      } catch (err) {
        console.warn(`[WikiMemory] post-embed removal delivery failed for ${factId}:`, err);
      }
      return;
    }
    // 'none': live, already owed, or nothing to record. 'unknown': liveness
    // couldn't be read and the guarded write failed, so a null could remove a
    // live fact's vector; send nothing (spec rev 6).
    if (outcome !== 'write_failed') return;
    // The fact is known not live but the removal couldn't be recorded (for
    // example the host holds a transaction on the connection). Send null now
    // so the last call the host sees for a deleted fact is still a removal.
    try {
      await this.callRemovalHook(entityId, factId, this.validateDeletionTimeout());
    } catch (hookErr) {
      console.warn(`[WikiMemory] onEmbeddingPersisted(vector=null) hook failed for ${factId}:`, hookErr);
      this.reportHookFailed({ operation, trigger }, entityId, factId);
      // Neither the record nor the call landed. Try the record once more (the
      // hook wait gave the host time to finish its transaction): an owed row
      // is retried by the next drain. If this fails too, nothing durable is
      // left to write to, as in the never-set-up fallbacks (§5.5.5).
      await this.recordAfterVectorCall(entityId, factId);
    }
  }

  private reportEmbed(
    ctx: EmbedDiagnosticContext | undefined,
    fact: { id: string; entity_id: string },
    code: 'embedding_failed' | 'hook_failed',
    reason: 'invalid_vector' | 'float32_overflow' | 'embed_threw' | 'persist_failed' | 'on_embedding_persisted',
  ): void {
    if (!ctx) return;
    emitDiagnostic(this.options, {
      code, operation: ctx.operation, trigger: ctx.trigger, entityId: fact.entity_id,
      detail: { factId: fact.id, reason },
    });
  }

  /** For callers that invoke `notifyEmbeddingPersisted` directly and catch its failure. */
  reportHookFailed(ctx: EmbedDiagnosticContext, entityId: string, factId: string): void {
    this.reportEmbed(ctx, { id: factId, entity_id: entityId }, 'hook_failed', 'on_embedding_persisted');
  }

  /** Marker writes must never fail the caller. Only marker-eligible kinds reach here. */
  private async markFailure(id: string, kind: EmbeddingMarkerKind): Promise<void> {
    try {
      await this.entryRepo.markEmbeddingFailure(id, kind, Date.now());
    } catch (err) {
      console.warn(`[WikiMemory] failed to record embedding failure for ${id}:`, err);
    }
  }

  /**
   * Back-compatible boolean form. Kept because callers such as
   * ImportExportService branch on `if (!embedded)`; a discriminated result
   * object is always truthy and would silently disable that branch.
   */
  async embedFact(fact: {
    id: string;
    entity_id: string;
    title: string;
    body: string;
    tags: string | string[];
  }, ctx?: EmbedDiagnosticContext): Promise<boolean> {
    const result = await this.tryEmbedFact(fact, ctx);
    return result.ok;
  }

  private vectorRemoval?: { service: VectorRemovalService; repo: VectorRemovalRepository };

  /** Wired by WikiMemory (VectorRemovalService itself depends on this class). */
  attachVectorRemoval(service: VectorRemovalService, repo: VectorRemovalRepository): void {
    this.vectorRemoval = { service, repo };
  }

  /**
   * After an embed (and its vector call) settles: owe a removal if the fact is
   * no longer live, so a vector the host just received is taken back (§5.7, G10).
   * Never throws. `'enqueued'`: a ledger row was written. `'none'`: no ledger
   * table, no removal hook, the fact is live, or a row was already owed.
   * `'write_failed'`: the fact is known not live but the write failed.
   * `'unknown'`: the liveness read and the guarded write both failed.
   */
  private async recordAfterVectorCall(
    entityId: string,
    factId: string,
  ): Promise<'none' | 'enqueued' | 'write_failed' | 'unknown'> {
    const vr = this.vectorRemoval;
    if (!vr || vr.service.gate() !== 'hook') return 'none';
    let live: boolean | undefined;
    try {
      if (!(await vr.service.ledgerPresent())) return 'none';
      // A read first: the common case (fact live) opens no write transaction.
      live = await vr.repo.isLive(factId);
    } catch (err) {
      // The guarded write below still decides liveness atomically.
      console.warn(`[WikiMemory] post-embed liveness read failed for ${factId}:`, err);
    }
    if (live) return 'none';
    try {
      return (await vr.repo.enqueueIfNotLive(entityId, factId, Date.now())) ? 'enqueued' : 'none';
    } catch (err) {
      console.warn(`[WikiMemory] post-embed removal could not be recorded for ${factId}:`, err);
      return live === false ? 'write_failed' : 'unknown';
    }
  }

  async notifyEmbeddingPersisted(entityId: string, factId: string, vector: Float32Array | null): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
    const vectorCopy = vector ? vector.slice() : null;
    await this.options.vectorRanker.onEmbeddingPersisted({
      entityId,
      factId,
      vector: vectorCopy,
    });
  }

  validateDeletionTimeout(): number {
    const rawTimeout = this.options.deletionHookTimeoutMs ?? 30_000;
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error('Invalid deletionHookTimeoutMs: must be a positive finite number');
    }
    return rawTimeout;
  }

  /** Send a removal (`vector: null`) to the hook. No gate check; the caller owns the gate. */
  async callRemovalHook(entityId: string, factId: string, timeoutMs: number): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) {
      throw new Error('callRemovalHook requires vectorRanker.onEmbeddingPersisted');
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const timeoutError = new Error(`onEmbeddingPersisted timed out after ${timeoutMs}ms`);
        (timeoutError as any)[HOOK_TIMEOUT_MARKER] = true;
        reject(timeoutError);
      }, timeoutMs);
    });
    const hookPromise = Promise.resolve().then(() =>
      this.options.vectorRanker!.onEmbeddingPersisted!({ entityId, factId, vector: null }),
    );
    try {
      await Promise.race([hookPromise, timeoutPromise]);
    } catch (err) {
      hookPromise.catch(() => {});
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async notifyEmbeddingPersistedOrThrow(
    entityId: string,
    factId: string,
    vector: Float32Array | null,
  ): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
    if (this.options.forceDeleteIgnoreRankerHook === true) return;

    const vectorCopy = vector ? vector.slice() : null;
    const timeoutMs = this.validateDeletionTimeout();

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const timeoutError = new Error(`onEmbeddingPersisted timed out after ${timeoutMs}ms`);
        (timeoutError as any)[HOOK_TIMEOUT_MARKER] = true;
        reject(timeoutError);
      }, timeoutMs);
    });

    const hookPromise = Promise.resolve().then(() =>
      this.options.vectorRanker!.onEmbeddingPersisted!({
        entityId,
        factId,
        vector: vectorCopy,
      }),
    );

    try {
      await Promise.race([hookPromise, timeoutPromise]);
    } catch (err) {
      hookPromise.catch(() => {});
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}
