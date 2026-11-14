import type { ExtractedFactWithOntology, ExtractedTask, OntologyUpdates, WikiEvent } from '../../../types';
import type { LibrarianWatermark } from '../../../repositories/MetadataRepository';
import type { WikiDiagnosticInput } from '../../../utils/diagnostics';
import { callLlm } from '../../../utils/llmCall';
import { estimateTokens, type UsageMeter } from '../../../utils/usage';
import { parseJsonResponse, validateFact, validateTask, factRejectionReason, taskRejectionReason } from '../../../utils/pure';
import type { LibrarianDeps, LibrarianPassContext } from '../types';
import { labelEvents, parseValidFrom, type LabeledEvent } from './text';

export const OPS_MAX_EVENTS_PER_PASS = 50;
export const OPS_MAX_EXTRACT_CHARS = 24_000;
/** A batch is extracted only when this multiple of its prompt estimate fits, leaving room for the resolve call. */
const RESOLVE_RESERVE_FACTOR = 2;

export interface Candidate {
  index: number;
  fact: ExtractedFactWithOntology;
  sourceLabel: string | null;
  /** Resolved source event id for the pointer (spec §Ops path); null when unresolved. */
  sourceEventId: string | null;
  /** The named event's own grounding-corpus part index (batch order); null when unresolved. */
  sourcePartIndex: number | null;
  /** Why the pointer is null, for the `source_pointer_unresolved` diagnostic; null when resolved. */
  pointerUnresolved: 'missing' | 'unknown_label' | null;
  validFrom: number;
}

export interface ExtractOutcome {
  batch: LabeledEvent[];
  candidates: Candidate[];
  tasks: ExtractedTask[];
  ontologyUpdates?: OntologyUpdates;
  groundingCorpus: string[] | null;
  diagnostics: WikiDiagnosticInput[];
}

const estimatePrompt = (p: { systemPrompt: string; userPrompt: string }) =>
  estimateTokens(p.systemPrompt) + estimateTokens(p.userPrompt);

export async function selectBatch(
  deps: LibrarianDeps,
  entityId: string,
  wm: LibrarianWatermark | null,
  meter?: UsageMeter,
  guidance?: string,
): Promise<{ batch: LabeledEvent[] } | { budgetStop: { requiredEstimate: number } }> {
  const events: WikiEvent[] = await deps.eventRepo.getAfter(entityId, wm, OPS_MAX_EVENTS_PER_PASS);
  if (events.length === 0) return { batch: [] };

  let n = 0;
  let chars = 0;
  for (const e of events) {
    if (n > 0 && chars + e.summary.length > OPS_MAX_EXTRACT_CHARS) break;
    chars += e.summary.length;
    n++;
  }
  let batch = labelEvents(events.slice(0, n));

  if (meter && meter.budget !== undefined) {
    const ontologyContext = (await deps.ontologyService?.buildPromptContext(entityId)) ?? null;
    for (;;) {
      const need = RESOLVE_RESERVE_FACTOR * estimatePrompt(deps.promptService.buildOpsExtractPrompt(batch, ontologyContext, guidance));
      if (meter.fits(need)) break;
      if (batch.length === 1) return { budgetStop: { requiredEstimate: need } };
      batch = labelEvents(events.slice(0, Math.max(1, Math.floor(batch.length / 2))));
    }
  }
  return { batch };
}

export async function runExtract(deps: LibrarianDeps, ctx: LibrarianPassContext, batch: LabeledEvent[]): Promise<ExtractOutcome> {
  const { entityId, trigger } = ctx;
  const ontologyContext = (await deps.ontologyService?.buildPromptContext(entityId)) ?? null;
  const prompt = deps.promptService.buildOpsExtractPrompt(batch, ontologyContext, ctx.guidance);
  const text = await callLlm(deps.options, { operation: 'librarian', entityId, trigger, meter: ctx.meter }, prompt);
  const parsed = parseJsonResponse<{ facts?: unknown; tasks?: unknown; ontology_updates?: OntologyUpdates }>(text);

  const base = { entityId, operation: 'librarian' as const, trigger };
  const diagnostics: WikiDiagnosticInput[] = [];
  const byLabel = new Map(batch.map((l) => [l.label, l]));
  // Newest real-world date in the batch, never later than now (spec import-followups §2).
  // Batch order is created_at; `at` is occurred_at ?? created_at, so the last element is not the newest.
  let newestAt = batch[0].at;
  for (const l of batch) if (l.at > newestAt) newestAt = l.at;
  const defaultValidFrom = Math.min(newestAt, Date.now());

  const candidates: Candidate[] = [];
  (Array.isArray(parsed.facts) ? parsed.facts : []).forEach((raw: unknown, index: number) => {
    const fact = validateFact(raw) as ExtractedFactWithOntology | null;
    if (!fact) {
      diagnostics.push({ ...base, code: 'fact_rejected', detail: { itemIndex: index, reason: factRejectionReason(raw) } });
      return;
    }
    const r = raw as { source_event?: unknown; valid_from?: unknown };
    // Source-pointer resolution (spec §One pointer, not a list). The split
    // replaces the old single expression (`extract.ts:89`) so the two rule-6
    // reasons are distinguishable: absent-or-null → 'missing' (ops contract
    // requires the field); present-but-not-a-batch-label-string →
    // 'unknown_label'. The label space is batch-local, so the id resolves at
    // extract time, before any write.
    let sourceEventId: string | null = null;
    let sourcePartIndex: number | null = null;
    let pointerUnresolved: 'missing' | 'unknown_label' | null;
    const rawSourceEvent = r.source_event;
    if (rawSourceEvent === undefined || rawSourceEvent === null) {
      pointerUnresolved = 'missing';
    } else if (typeof rawSourceEvent === 'string' && byLabel.has(rawSourceEvent)) {
      const labeled = byLabel.get(rawSourceEvent)!;
      sourceEventId = labeled.event.id;
      sourcePartIndex = batch.findIndex((b) => b.label === rawSourceEvent);
      pointerUnresolved = null;
    } else {
      pointerUnresolved = 'unknown_label';
    }
    const sourceLabel = typeof rawSourceEvent === 'string' && byLabel.has(rawSourceEvent) ? rawSourceEvent : null;
    const validFrom = parseValidFrom(r.valid_from) ?? (sourceLabel ? byLabel.get(sourceLabel)!.at : defaultValidFrom);
    candidates.push({ index, fact, sourceLabel, sourceEventId, sourcePartIndex, pointerUnresolved, validFrom });
  });

  const tasks: ExtractedTask[] = [];
  (Array.isArray(parsed.tasks) ? parsed.tasks : []).forEach((raw: unknown, index: number) => {
    const task = validateTask(raw);
    if (task) tasks.push(task);
    else diagnostics.push({ ...base, code: 'task_rejected', detail: { itemIndex: index, reason: taskRejectionReason(raw) } });
  });

  return {
    batch,
    candidates,
    tasks,
    ...(parsed.ontology_updates ? { ontologyUpdates: parsed.ontology_updates } : {}),
    groundingCorpus: prompt.groundingCorpus ?? null,
    diagnostics,
  };
}
