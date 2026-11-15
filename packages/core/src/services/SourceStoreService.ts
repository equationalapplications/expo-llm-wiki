import type {
  SQLiteAdapter, StoredSource, StoredSourceSummary, StoreSourceResult, WikiDiagnostic, WikiOptions,
} from '../types';
import type { JobManager } from './JobManager';
import { emitDiagnostic, type WikiDiagnosticInput } from '../utils/diagnostics';
import { normalizeSourceHash, normalizeSourceRef } from '../utils/pure';
import { upsertStoredSource } from './sourceStoreUpsert';

/** Spec source-store §9 defaults: owner-gated refusal guards, not targets. UTF-16 code units. */
export const DEFAULT_MAX_CHARS_PER_SOURCE = 200_000;
export const DEFAULT_MAX_TOTAL_CHARS = 5_000_000;


function limitOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Source store write path (spec source-store §5, §7, §9). */
export class SourceStoreService {
  constructor(
    private db: SQLiteAdapter,
    private prefix: string,
    private options: WikiOptions,
    private jobManager: JobManager,
  ) {}

  private limits(): { maxCharsPerSource: number; maxTotalChars: number } {
    const cfg = this.options.config?.sourceStore;
    return {
      maxCharsPerSource: limitOr(cfg?.maxCharsPerSource, DEFAULT_MAX_CHARS_PER_SOURCE),
      maxTotalChars: limitOr(cfg?.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS),
    };
  }

  private refuse(entityId: string, code: WikiDiagnosticInput['code'], sourceRef: string): StoreSourceResult {
    const captured: WikiDiagnostic[] = [];
    const input: WikiDiagnosticInput = { code, operation: 'sourceStore', trigger: 'call', entityId, detail: { sourceRef } };
    emitDiagnostic({ onDiagnostic: (d) => { captured.push(d); } }, input);
    emitDiagnostic(this.options, input);
    return { stored: false, diagnostics: captured };
  }

  async storeSource(
    entityId: string,
    params: { sourceRef: string; sourceHash: string; text: string },
  ): Promise<StoreSourceResult> {
    // Invalid arguments throw (spec §7), before any lock.
    const sourceRef = normalizeSourceRef(params.sourceRef);
    if (!sourceRef) throw new Error('Invalid sourceRef');
    const sourceHash = normalizeSourceHash(params.sourceHash);
    if (!sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');
    if (typeof params.text !== 'string') throw new Error(`text must be a string, received ${typeof params.text}`);
    const text = params.text;

    // Busy lock throws WikiBusyError; never converted to a refusal (spec §7).
    this.jobManager.acquireLock('store', entityId);
    try {
      const limits = this.limits();
      // Every check re-reads inside the transaction, under the store lock (§9).
      let refused: WikiDiagnosticInput['code'] | undefined;
      const outcome = await this.db.withTransactionAsync((tx) => upsertStoredSource(
        tx, this.prefix, entityId, { sourceRef, sourceHash, text }, limits,
        (code) => { refused = code; }, { idempotentSamePair: true },
      ));
      if (outcome.status === 'refused') return this.refuse(entityId, refused!, sourceRef);
      return {
        stored: true, sourceRef, sourceHash,
        charCount: outcome.charCount, passageCount: outcome.passageCount, storedAt: outcome.storedAt,
      };
    } finally {
      this.jobManager.releaseLock('store', entityId);
    }
  }

  /** Spec §7: the text exactly as handed, or null. Plain read, no write lock. */
  async getStoredSource(
    entityId: string,
    sourceRef: string,
  ): Promise<StoredSource | null> {
    const ref = normalizeSourceRef(sourceRef);
    if (!ref) return null;
    const row = await this.db.getFirstAsync<{
      source_ref: string; source_hash: string; text: string; char_count: number; created_at: number;
    }>(
      `SELECT source_ref, source_hash, text, char_count, created_at FROM ${this.prefix}source_documents
       WHERE entity_id = ? AND source_ref = ?`,
      [entityId, ref],
    );
    if (!row) return null;
    return {
      sourceRef: row.source_ref,
      sourceHash: row.source_hash,
      text: row.text,
      charCount: Number(row.char_count),
      storedAt: Number(row.created_at),
    };
  }

  /** Spec §4/§7: full store listing, including sources stored with no ingest. */
  async listStoredSources(entityId: string): Promise<StoredSourceSummary[]> {
    const rows = await this.db.getAllAsync<{
      source_ref: string; source_hash: string; char_count: number; created_at: number; passage_count: number;
    }>(
      `SELECT d.source_ref, d.source_hash, d.char_count, d.created_at,
              (SELECT COUNT(*) FROM ${this.prefix}source_passages p
                WHERE p.entity_id = d.entity_id AND p.document_id = d.id) AS passage_count
       FROM ${this.prefix}source_documents d
       WHERE d.entity_id = ?
       ORDER BY d.source_ref COLLATE BINARY`,
      [entityId],
    );
    return rows.map((r) => ({
      sourceRef: r.source_ref,
      sourceHash: r.source_hash,
      charCount: Number(r.char_count),
      passageCount: Number(r.passage_count),
      storedAt: Number(r.created_at),
    }));
  }
}
