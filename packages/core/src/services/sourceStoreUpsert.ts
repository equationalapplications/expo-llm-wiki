import type { SQLiteAdapter, WikiDiagnosticCode } from '../types';
import { generateId } from '../utils/ids';
import { cutPassages } from '../utils/passageCutter';
import { sha256Hex } from '../utils/sha256';

// A surrogate half with no partner cannot round-trip through UTF-8 storage.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export interface StoreLimits {
  maxCharsPerSource: number;
  maxTotalChars: number;
}

export type UpsertOutcome =
  | { status: 'stored'; charCount: number; passageCount: number; storedAt: number }
  | { status: 'refused' };

/**
 * The one store write (spec source-store §5, §8, §9), shared by
 * SourceStoreService.storeSource and ImportExportService.importStoredSources.
 * Runs inside the caller's transaction. A refusal calls `onRefusal(code)` and
 * returns `{status:'refused'}` with nothing written; the caller decides whether
 * that throws, records, or continues.
 *
 * `idempotentSamePair` (storeSource): a stored copy with the same ref and hash
 * is a no-op returning the existing figures, or a `source_store_hash_mismatch`
 * refusal when its text hash differs. Import leaves it off: the dump is the
 * truth for that ref, so the old copy is replaced.
 */
export async function upsertStoredSource(
  tx: SQLiteAdapter,
  prefix: string,
  entityId: string,
  src: { sourceRef: string; sourceHash: string; text: string; storedAt?: number },
  limits: StoreLimits,
  onRefusal: (code: WikiDiagnosticCode) => void,
  opts: { idempotentSamePair?: boolean } = {},
): Promise<UpsertOutcome> {
  const { sourceRef, sourceHash, text } = src;
  const refuse = (code: WikiDiagnosticCode): UpsertOutcome => {
    onRefusal(code);
    return { status: 'refused' };
  };
  if (text.includes('\u0000') || LONE_SURROGATE.test(text)) return refuse('source_store_text_not_storable');
  if (text.length > limits.maxCharsPerSource) return refuse('source_store_source_too_large');

  const textHash = sha256Hex(text); // re-computed, never trusted from a dump (spec §8)
  const charCount = text.length;
  const docs = `${prefix}source_documents`;
  const passages = `${prefix}source_passages`;
  const registry = `${prefix}source_ref_index`;

  const existing = await tx.getFirstAsync<{
    id: string; source_hash: string; text_hash: string; char_count: number; created_at: number;
  }>(
    `SELECT id, source_hash, text_hash, char_count, created_at FROM ${docs}
     WHERE entity_id = ? AND source_ref = ?`,
    [entityId, sourceRef],
  );

  if (opts.idempotentSamePair && existing && existing.source_hash === sourceHash) {
    if (existing.text_hash !== textHash) return refuse('source_store_hash_mismatch');
    const row = await tx.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${passages} WHERE entity_id = ? AND document_id = ?`,
      [entityId, existing.id],
    );
    return { status: 'stored', charCount: existing.char_count, passageCount: row?.n ?? 0, storedAt: existing.created_at };
  }

  // Duplicate hash: the store's own index AND live registry rows (tombstones block nothing).
  const heldByStore = await tx.getFirstAsync<{ source_ref: string }>(
    `SELECT source_ref FROM ${docs} WHERE entity_id = ? AND source_hash = ? AND source_ref <> ?`,
    [entityId, sourceHash, sourceRef],
  );
  const heldByFacts = await tx.getFirstAsync<{ source_ref: string }>(
    `SELECT source_ref FROM ${registry}
     WHERE entity_id = ? AND source_hash = ? AND deleted_at IS NULL AND source_ref <> ?`,
    [entityId, sourceHash, sourceRef],
  );
  if (heldByStore || heldByFacts) return refuse('source_store_duplicate_hash');

  // A changed copy replaces the old text, so its size leaves the total.
  const total = await tx.getFirstAsync<{ n: number | null }>(
    `SELECT COALESCE(SUM(char_count), 0) AS n FROM ${docs} WHERE entity_id = ? AND source_ref <> ?`,
    [entityId, sourceRef],
  );
  if ((total?.n ?? 0) + charCount > limits.maxTotalChars) return refuse('source_store_budget_exceeded');

  if (existing) {
    // §5: changed copy is a real delete of the old text row and its passages.
    await tx.runAsync(`DELETE FROM ${passages} WHERE entity_id = ? AND document_id = ?`, [entityId, existing.id]);
    await tx.runAsync(`DELETE FROM ${docs} WHERE entity_id = ? AND id = ?`, [entityId, existing.id]);
  }

  const id = generateId('sdoc_');
  const storedAt = typeof src.storedAt === 'number' && Number.isFinite(src.storedAt) ? src.storedAt : Date.now();
  await tx.runAsync(
    `INSERT INTO ${docs} (id, entity_id, source_ref, source_hash, text, text_hash, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, sourceRef, sourceHash, text, textHash, charCount, storedAt],
  );
  // Offsets only (spec §3): passage text is sliced from source_documents.text in JS, never stored.
  const spans = cutPassages(text);
  for (let seq = 0; seq < spans.length; seq++) {
    await tx.runAsync(
      `INSERT INTO ${passages} (id, entity_id, document_id, seq, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)`,
      [generateId('spas_'), entityId, id, seq, spans[seq]!.start, spans[seq]!.end],
    );
  }
  return { status: 'stored', charCount, passageCount: spans.length, storedAt };
}
