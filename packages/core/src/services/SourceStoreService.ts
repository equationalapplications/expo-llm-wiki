import type { SQLiteAdapter, WikiDiagnostic, WikiOptions } from '../types';
import type { JobManager } from './JobManager';
import { emitDiagnostic, type WikiDiagnosticInput } from '../utils/diagnostics';
import { generateId } from '../utils/ids';
import { normalizeSourceHash, normalizeSourceRef } from '../utils/pure';
import { sha256Hex } from '../utils/sha256';

/** Spec source-store §9 defaults: owner-gated refusal guards, not targets. UTF-16 code units. */
export const DEFAULT_MAX_CHARS_PER_SOURCE = 200_000;
export const DEFAULT_MAX_TOTAL_CHARS = 5_000_000;

export type StoreSourceResult =
  | {
      stored: true;
      sourceRef: string;
      sourceHash: string;
      charCount: number;
      passageCount: number;
      storedAt: number;
    }
  | { stored: false; diagnostics: WikiDiagnostic[] };

// A surrogate half with no partner cannot round-trip through UTF-8 storage.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface DocRow {
  id: string;
  source_ref: string;
  source_hash: string;
  text_hash: string;
  char_count: number;
  created_at: number;
}

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
    // `sourceStore` is not yet on WikiConfig (types.ts is outside Task 4); read it structurally.
    const cfg = (this.options.config as { sourceStore?: { maxCharsPerSource?: number; maxTotalChars?: number } } | undefined)
      ?.sourceStore;
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
      if (text.includes('\u0000') || LONE_SURROGATE.test(text)) {
        return this.refuse(entityId, 'source_store_text_not_storable', sourceRef);
      }
      const { maxCharsPerSource, maxTotalChars } = this.limits();
      if (text.length > maxCharsPerSource) {
        return this.refuse(entityId, 'source_store_source_too_large', sourceRef);
      }

      const textHash = sha256Hex(text);
      const charCount = text.length;
      const docs = `${this.prefix}source_documents`;
      const passages = `${this.prefix}source_passages`;
      const registry = `${this.prefix}source_ref_index`;

      // Every check re-reads inside the transaction, under the store lock (§9).
      const outcome = await this.db.withTransactionAsync(async (tx) => {
        const db = tx;
        const existing = await db.getFirstAsync<DocRow>(
          `SELECT id, source_ref, source_hash, text_hash, char_count, created_at FROM ${docs}
           WHERE entity_id = ? AND source_ref = ?`,
          [entityId, sourceRef],
        );

        if (existing && existing.source_hash === sourceHash) {
          if (existing.text_hash !== textHash) return { refused: 'source_store_hash_mismatch' as const };
          const row = await db.getFirstAsync<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${passages} WHERE entity_id = ? AND document_id = ?`,
            [entityId, existing.id],
          );
          return {
            charCount: existing.char_count,
            passageCount: row?.n ?? 0,
            storedAt: existing.created_at,
          };
        }

        // Duplicate hash: the store's own index AND live registry rows (tombstones block nothing).
        const heldByStore = await db.getFirstAsync<{ source_ref: string }>(
          `SELECT source_ref FROM ${docs} WHERE entity_id = ? AND source_hash = ? AND source_ref <> ?`,
          [entityId, sourceHash, sourceRef],
        );
        const heldByFacts = await db.getFirstAsync<{ source_ref: string }>(
          `SELECT source_ref FROM ${registry}
           WHERE entity_id = ? AND source_hash = ? AND deleted_at IS NULL AND source_ref <> ?`,
          [entityId, sourceHash, sourceRef],
        );
        if (heldByStore || heldByFacts) return { refused: 'source_store_duplicate_hash' as const };

        // A changed copy replaces the old text, so its size leaves the total.
        const total = await db.getFirstAsync<{ n: number | null }>(
          `SELECT COALESCE(SUM(char_count), 0) AS n FROM ${docs} WHERE entity_id = ? AND source_ref <> ?`,
          [entityId, sourceRef],
        );
        if ((total?.n ?? 0) + charCount > maxTotalChars) return { refused: 'source_store_budget_exceeded' as const };

        if (existing) {
          // §5: changed copy is a real delete of the old text row and its passages.
          await db.runAsync(`DELETE FROM ${passages} WHERE entity_id = ? AND document_id = ?`, [entityId, existing.id]);
          await db.runAsync(`DELETE FROM ${docs} WHERE entity_id = ? AND id = ?`, [entityId, existing.id]);
        }

        const id = generateId('sdoc_');
        const storedAt = Date.now();
        await db.runAsync(
          `INSERT INTO ${docs} (id, entity_id, source_ref, source_hash, text, text_hash, char_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, entityId, sourceRef, sourceHash, text, textHash, charCount, storedAt],
        );
        // TODO(task-6): passage slicing — insert source_passages rows here, inside this transaction.
        return { charCount, passageCount: 0, storedAt };
      });

      if ('refused' in outcome && outcome.refused) return this.refuse(entityId, outcome.refused, sourceRef);
      return { stored: true, sourceRef, sourceHash, ...outcome };
    } finally {
      this.jobManager.releaseLock('store', entityId);
    }
  }

  /** Spec §7: the text exactly as handed, or null. Plain read, no write lock. */
  async getStoredSource(
    entityId: string,
    sourceRef: string,
  ): Promise<{ sourceRef: string; sourceHash: string; text: string; charCount: number; storedAt: number } | null> {
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
  async listStoredSources(entityId: string): Promise<Array<{
    sourceRef: string; sourceHash: string; charCount: number; passageCount: number; storedAt: number;
  }>> {
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
