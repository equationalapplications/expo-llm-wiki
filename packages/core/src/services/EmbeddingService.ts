import type { SQLiteAdapter, WikiOptions } from '../types';
import { HOOK_TIMEOUT_MARKER } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import { clip } from '../utils/pure';
import { DEFAULT_MAX_EMBED_CHARS, EMBED_CHARS_CEILING } from '../utils/embedDefaults';

export type EmbedFailureKind =
  | 'no_provider'
  | 'invalid_vector'
  | 'float32_overflow'
  | 'provider_error'
  | 'storage_error';

export type EmbedFactResult =
  | { ok: true; dimension: number }
  | { ok: false; kind: EmbedFailureKind };

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

  /** Promotes embedding_dimension_mismatch to canonical embedding_dimension when safe. */
  async reconcileEmbeddingDimension(): Promise<void> {
    const mismatchValue = await this.metadataRepo.getMeta('embedding_dimension_mismatch');
    if (!mismatchValue) return;

    const newDim = parseInt(mismatchValue, 10);
    const residualCount = await this.entryRepo.countStaleEmbeddings(newDim);
    if (residualCount === 0) {
      await this.metadataRepo.setMeta('embedding_dimension', mismatchValue, this.db);
      await this.metadataRepo.clearDimensionMismatch(this.db);
    }
  }

  async tryEmbedFact(fact: {
    id: string;
    entity_id: string;
    title: string;
    body: string;
    tags: string | string[];
  }): Promise<EmbedFactResult> {
    const embedFn = this.options.llmProvider.embed;
    if (!embedFn) return { ok: false, kind: 'no_provider' };
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
      const vector = await embedFn(text);
      if (vector.length === 0 || !vector.every(v => typeof v === 'number' && isFinite(v))) {
        console.warn(`[WikiMemory] embedFact: embed() returned an invalid vector for ${fact.id}; skipping.`);
        await this.markFailure(fact.id, 'invalid_vector');
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
        await this.markFailure(fact.id, 'float32_overflow');
        return { ok: false, kind: 'float32_overflow' };
      }
    } catch (err) {
      console.warn(`[WikiMemory] embedFact failed for ${fact.id}:`, err);
      await this.markFailure(fact.id, 'provider_error');
      return { ok: false, kind: 'provider_error' };
    }

    // Storage is a separate failure domain: a DB error here is NOT an
    // embedding failure and must not be marked as one (spec §3.2, D3).
    try {
      await this.storeEmbeddingDimension(float32Vector.length);
      const blob = new Uint8Array(float32Vector.buffer);
      await this.entryRepo.updateEmbeddingBlob(fact.id, blob);
    } catch (err) {
      console.warn(`[WikiMemory] embedFact: persisting embedding failed for ${fact.id}:`, err);
      return { ok: false, kind: 'storage_error' };
    }

    try {
      await this.notifyEmbeddingPersisted(fact.entity_id, fact.id, float32Vector);
    } catch (hookErr) {
      console.warn(`[WikiMemory] onEmbeddingPersisted hook failed for ${fact.id}:`, hookErr);
    }
    return { ok: true, dimension: float32Vector.length };
  }

  /** Marker writes must never fail the caller. */
  private async markFailure(id: string, kind: EmbedFailureKind): Promise<void> {
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
  }): Promise<boolean> {
    const result = await this.tryEmbedFact(fact);
    return result.ok;
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

  async notifyEmbeddingPersistedOrThrow(
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
