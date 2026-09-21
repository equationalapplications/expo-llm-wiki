import type {
  WikiDiagnostic,
  WikiDiagnosticCode,
  WikiDiagnosticDetail,
  WikiDiagnosticOperation,
  WikiDiagnosticSeverity,
  WikiDiagnosticTrigger,
  WikiOptions,
} from '../types';
import type { EdgeDrop } from './ontology';

/** What a call site supplies; severity, message and timestamp are derived from `code`. */
export type WikiDiagnosticInput = Omit<WikiDiagnostic, 'severity' | 'message' | 'at'>;

type DiagnosticTarget = Pick<WikiOptions, 'onDiagnostic'>;

const SEVERITY: Record<WikiDiagnosticCode, WikiDiagnosticSeverity> = {
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
};

// Fixed templates (REQ-DIAG-03): never interpolate content into these.
const MESSAGE: Record<WikiDiagnosticCode, string> = {
  ingest_chunk_failed: 'One or more document chunks failed to parse or generate.',
  fact_rejected: 'An extracted fact failed validation and was not written.',
  task_rejected: 'An extracted task failed validation and was not written.',
  fact_deduplicated: 'An extracted fact duplicated an existing fact and was not written.',
  edge_dropped: 'An extracted edge could not be resolved against the ontology and was not written.',
  embedding_failed: 'A fact could not be embedded.',
  hook_failed: 'A host hook threw or rejected.',
  background_job_failed: 'A background maintenance job failed.',
  heal_skipped: 'Heal skipped a candidate fact.',
  grounding_missing: 'A fact carried no qualifying evidence and was stored as a draft.',
  grounding_failed: 'A fact carried evidence not found in its source and was stored as a draft.',
  classification_low_confidence: 'A classifier answer was below the confidence threshold and was not applied.',
  classification_invalid: 'A classifier answer was invalid and was not applied.',
};

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
