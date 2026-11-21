import type {
  WikiDiagnostic,
  WikiDiagnosticCode,
  WikiDiagnosticDetail,
  WikiDiagnosticOperation,
  WikiDiagnosticSeverity,
  WikiDiagnosticTrigger,
  WikiOptions,
  OntologyMode,
} from '../types';
import type { EdgeDrop } from './ontology';

/** What a call site supplies; severity, message and timestamp are derived from `code`. */
export type WikiDiagnosticInput = Omit<WikiDiagnostic, 'severity' | 'message' | 'at'>;

type DiagnosticTarget = Pick<WikiOptions, 'onDiagnostic'>;

export const SEVERITY: Record<WikiDiagnosticCode, WikiDiagnosticSeverity> = {
  ingest_chunk_failed: 'warn',
  fact_rejected: 'warn',
  task_rejected: 'warn',
  fact_deduplicated: 'info',
  edge_dropped: 'warn',
  embedding_failed: 'warn',
  hook_failed: 'warn',
  background_job_failed: 'error',
  heal_skipped: 'warn',
  grounding_missing: 'warn',
  grounding_failed: 'warn',
  classification_low_confidence: 'info',
  classification_invalid: 'warn',
  context_overflow_skipped: 'warn',
  llm_usage: 'info',
  librarian_gate: 'info',
  librarian_op_rejected: 'warn',
  contradicts_document: 'warn',
  resolve_failed: 'warn',
  read_budget: 'info',
  event_retention_held: 'info',
  prune_checkpoint_incomplete: 'warn',
  erase_secure_delete_off: 'error',
  erase_entity_skipped: 'warn',
  erase_retired_vtab_undroppable: 'warn',
  erase_fts_orphan_cleared: 'info',
  erase_retired_remaining: 'error',
  erase_tombstones_remaining: 'error',
  erase_retired_read_failed: 'error',
  erase_registry_sweep_skipped: 'info',
  import_tombstone_skipped: 'info',
  event_created_at_clamped: 'warn',
  event_created_at_restamped: 'info',
  external_deletion_pending: 'warn',
  external_deletion_discarded: 'warn',
  guidance_too_long: 'warn',
  guidance_resolver_failed: 'warn',
  source_pointer_unresolved: 'warn',
  source_pointer_invalid: 'warn',
  source_store_source_too_large: 'warn',
  source_store_budget_exceeded: 'warn',
  source_store_hash_mismatch: 'warn',
  source_store_duplicate_hash: 'warn',
  source_store_text_not_storable: 'warn',
  node_type_dropped: 'warn',
  node_type_folded: 'info',
  node_type_assigned: 'info',
  ontology_update_rejected: 'warn',
  ingest_zero_facts: 'warn',
};

// Fixed templates (REQ-DIAG-03): never interpolate content into these.
export const MESSAGE: Record<WikiDiagnosticCode, string> = {
  ingest_chunk_failed: 'One or more document chunks failed to parse or generate.',
  fact_rejected: 'An extracted fact failed validation and was not written.',
  task_rejected: 'An extracted task failed validation and was not written.',
  fact_deduplicated: 'An extracted fact duplicated an existing fact and was not written.',
  edge_dropped: 'An extracted edge could not be resolved against the ontology and was not written.',
  embedding_failed: 'A fact could not be embedded.',
  hook_failed: 'A host hook threw or rejected.',
  background_job_failed: 'A background maintenance job failed.',
  heal_skipped: 'Heal skipped a candidate fact, or the whole LLM pass when keyword search is unavailable.',
  grounding_missing: 'A fact carried no qualifying evidence and was stored as a draft.',
  grounding_failed: 'A fact carried evidence not found in its source and was stored as a draft.',
  classification_low_confidence: 'A classifier answer was below the confidence threshold and was not applied.',
  classification_invalid: 'A classifier answer was invalid and was not applied.',
  context_overflow_skipped: 'An item (fact or event) was skipped because the model input exceeded its context window.',
  llm_usage: 'An LLM call completed; token usage attached.',
  librarian_gate: 'Librarian gate outcome counts for one pass.',
  librarian_op_rejected: 'A librarian reconciliation op was invalid and the candidate was added instead.',
  contradicts_document: 'A candidate contradicted a document fact and was stored as a draft.',
  resolve_failed: 'Reconciliation failed for a candidate; it was stored as a draft.',
  read_budget: 'A read was packed to a token budget.',
  event_retention_held: 'Event pruning was held back because the librarian has not processed those events yet.',
  prune_checkpoint_incomplete: 'The post-VACUUM WAL checkpoint was incomplete while a prune partial failure was also reported; deleted bytes may remain in the WAL.',
  erase_secure_delete_off: 'secure_delete could not be confirmed ON on the connection; erasure is unverified and the erase was stopped.',
  erase_retired_vtab_undroppable: 'A retired FTS table could not be dropped on a runtime without FTS5; its shadow-table text rows were emptied (fts5 %_config and %_data ids 1 and 10 are intentionally kept) and the name stays listed until an FTS5-capable open drops it.',
  erase_fts_orphan_cleared: 'An orphaned FTS5 surface (shadow or companion table, or a queryable vtab) was cleared during erase so forgotten text cannot survive in it.',
  erase_retired_remaining: 'Erase stopped: retired FTS tables still exist after reclamation; the erase is incomplete.',
  erase_tombstones_remaining: 'Erase stopped: soft-deleted rows remain in the database file after the erase pipeline; the erase is incomplete and unverified.',
  erase_retired_read_failed: 'Erase stopped: the retired-FTS-table inventory read failed; the erase is incomplete and unverified.',
  erase_entity_skipped: 'Erase skipped an entity because another operation held its prune lock.',
  erase_registry_sweep_skipped: 'Erase skipped the source_ref_index tombstone sweep because the table does not exist (pre-v9 store).',
  import_tombstone_skipped: 'Import skipped live dump rows (facts and tasks) whose ids were forgotten locally. The protection holds while the tombstone is retained; once a prune hard-deletes the row, an old dump can import the fact again — see the OKF guide’s restore caveat.',
  event_created_at_clamped: 'Imported events dated in the future were re-dated just after the current time, or after the librarian position if that is later, keeping their order.',
  event_created_at_restamped: 'Imported events that would have sorted behind the librarian position, or had an unusable date, were adjusted: an affected created_at was re-dated just after the current time, or after the librarian position if that is later, keeping their order; an unusable occurred_at was cleared.',
  external_deletion_pending: 'Removals owed to the external vector index are still pending.',
  external_deletion_discarded: 'Pending external vector removals were discarded because forceDeleteIgnoreRankerHook is set.',
  guidance_too_long: 'The configured guidance exceeded the length cap and was not sent for this pass.',
  guidance_resolver_failed: 'The per-entity guidance resolver failed; its value was not used for this pass.',
  source_pointer_unresolved: 'A stored librarian fact carries no source pointer because the model answer could not yield one.',
  source_pointer_invalid: 'Import met a malformed source pointer value and stored a null pointer.',
  source_store_source_too_large: 'A source document exceeded the per-document size cap and was not stored.',
  source_store_budget_exceeded: 'Storing a source document would exceed the store UTF-16 code-unit budget and it was not stored.',
  source_store_hash_mismatch: 'A source document text did not match its recorded hash and was not stored.',
  source_store_duplicate_hash: 'A source document duplicated the hash of one already stored and was not stored.',
  source_store_text_not_storable: 'A source document text could not be stored as given.',
  node_type_dropped: 'A supplied node type missed the ontology manifest and the fact was stored untyped.',
  node_type_folded: 'A supplied node type was normalized into the manifest canonical slug.',
  node_type_assigned: 'A fact was assigned an ontology node type by a typing path.',
  ontology_update_rejected: 'An emergent ontology proposal was rejected during the merge.',
  ingest_zero_facts: 'A re-ingest tombstoned prior facts and edges and then wrote zero facts.',
};

/** Ontology receipts emit only when the entity's ontology mode ≠ `'off'`. */
export function shouldEmitOntologyReceipt(mode: OntologyMode): boolean {
  return mode !== 'off';
}

/** Receipt slugs are content-free identifiers, capped at 64 characters. */
export function capReceiptSlug(slug: string): string {
  return typeof slug === 'string' ? slug.slice(0, 64) : '';
}

/**
 * Node-type door receipts for one fact: `node_type_folded` when the resolver
 * normalized the supplied slug into the canonical one, `node_type_dropped`
 * when a non-empty supplied slug missed the manifest entirely. Callers gate
 * on the effective ontology mode before pushing these.
 */
export function nodeTypeReceipts(
  base: { entityId: string; operation: WikiDiagnosticOperation; trigger: WikiDiagnosticTrigger },
  factId: string,
  rawType: string,
  okfType: string | null,
  match?: { raw: string; canonical: string; via: 'exact' | 'normalize' },
): WikiDiagnosticInput[] {
  const out: WikiDiagnosticInput[] = [];
  const supplied = typeof rawType === 'string' ? rawType.trim() : '';
  if (match && match.via === 'normalize') {
    const to = capReceiptSlug(match.canonical);
    out.push({
      ...base,
      code: 'node_type_folded',
      detail: {
        factId,
        nodeType: to,
        from: capReceiptSlug(match.raw),
        to,
        via: 'normalize',
      },
    });
  }
  if (!okfType && supplied) {
    out.push({
      ...base,
      code: 'node_type_dropped',
      detail: {
        factId,
        nodeType: capReceiptSlug(supplied),
        reason: 'not_in_manifest',
      },
    });
  }
  return out;
}

const warnedNonFunction = new WeakSet<object>();

function copyDetail(detail: WikiDiagnosticDetail): WikiDiagnosticDetail {
  const copy: WikiDiagnosticDetail = { ...detail };
  if (detail.chunkIndexes) copy.chunkIndexes = detail.chunkIndexes.slice();
  return copy;
}

/**
 * Deliver one diagnostic to the host hook. Never throws, never awaits, and
 * never writes to the console unless the hook itself misbehaves (REQ-DIAG-02).
 */
export function emitDiagnostic(options: DiagnosticTarget, input: WikiDiagnosticInput): void {
  const hook: unknown = options.onDiagnostic;
  if (hook === undefined || hook === null) return;
  if (typeof hook !== 'function') {
    if (!warnedNonFunction.has(options)) {
      warnedNonFunction.add(options);
      console.warn('[WikiMemory] onDiagnostic is not a function; diagnostics are disabled.');
    }
    return;
  }
  const diagnostic: WikiDiagnostic = {
    code: input.code,
    severity: SEVERITY[input.code],
    operation: input.operation,
    trigger: input.trigger,
    entityId: input.entityId,
    at: Date.now(),
    message: MESSAGE[input.code],
    ...(input.detail ? { detail: copyDetail(input.detail) } : {}),
  };
  try {
    const returned: unknown = (hook as (d: WikiDiagnostic) => unknown)(diagnostic);
    if (returned !== undefined) {
      // Promise.resolve never throws synchronously; a hostile thenable rejects instead.
      Promise.resolve(returned).catch((err: unknown) => {
        console.warn('[WikiMemory] onDiagnostic hook rejected:', err);
      });
    }
  } catch (err) {
    console.warn('[WikiMemory] onDiagnostic hook threw:', err);
  }
}

/**
 * Operation-scoped buffer (spec §4.2.4): push while the operation's
 * transaction is open, `flush` after it commits, `discard` (or simply drop the
 * buffer) when the operation throws.
 */
export class DiagnosticBuffer {
  private items: WikiDiagnosticInput[] = [];

  push(input: WikiDiagnosticInput): void {
    this.items.push(input);
  }

  get size(): number {
    return this.items.length;
  }

  flush(options: DiagnosticTarget): void {
    const pending = this.items;
    this.items = [];
    for (const input of pending) emitDiagnostic(options, input);
  }

  /**
   * Emit only the buffered diagnostics whose code is in `codes` and discard
   * the rest. The buffer is empty afterwards either way.
   *
   * For an operation that did real work before its write was rolled back:
   * some buffered diagnostics describe that work and are still true, while
   * others describe rows that no longer exist (anything carrying a `factId`
   * minted inside the aborted transaction). `flush` would emit both and
   * `discard` would drop both; this emits the first set only.
   */
  flushOnly(options: DiagnosticTarget, codes: readonly WikiDiagnosticCode[]): void {
    const pending = this.items;
    this.items = [];
    for (const input of pending) {
      if (codes.includes(input.code)) emitDiagnostic(options, input);
    }
  }

  discard(): void {
    this.items = [];
  }
}

/** Map an `EdgeDrop` to an `edge_dropped` diagnostic input. Omits unknown locators instead of sending nulls. */
export function edgeDropDiagnostic(
  drop: EdgeDrop,
  ctx: {
    entityId: string;
    operation: WikiDiagnosticOperation;
    trigger: WikiDiagnosticTrigger;
    sourceRef?: string;
    factId?: string;
  },
): WikiDiagnosticInput {
  const detail: WikiDiagnosticDetail = { reason: drop.reason };
  const factId = ctx.factId ?? drop.sourceId;
  if (factId) detail.factId = factId;
  if (drop.edgeType) detail.edgeType = drop.edgeType;
  if (drop.sourceNodeType) detail.sourceNodeType = drop.sourceNodeType;
  if (drop.targetNodeType) detail.targetNodeType = drop.targetNodeType;
  if (ctx.sourceRef) detail.sourceRef = ctx.sourceRef;
  return { code: 'edge_dropped', operation: ctx.operation, trigger: ctx.trigger, entityId: ctx.entityId, detail };
}
