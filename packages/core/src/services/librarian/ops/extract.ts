import type { ExtractedFactWithOntology, ExtractedTask, OntologyUpdates, WikiEvent } from '../../../types';
import type { LibrarianWatermark } from '../../../repositories/MetadataRepository';
import type { WikiDiagnosticInput } from '../../../utils/diagnostics';
import { callLlm } from '../../../utils/llmCall';
import { isContextOverflowError } from '../../BoundedLlmCall';
import { estimateTokens, type UsageMeter } from '../../../utils/usage';
import { resolveMaxPromptChars } from '../../../config/context';
import type { ContextBudget } from '../../../utils/contextBudget';
import { parseJsonResponse, validateFact, validateTask, factRejectionReason, taskRejectionReason } from '../../../utils/pure';
import type { LibrarianDeps, LibrarianPassContext } from '../types';
import { labelEvents, parseValidFrom, type LabeledEvent } from './text';

export const OPS_MAX_EVENTS_PER_PASS = 50;
/** Re-exported from `utils/contextCaps` (specs/context-budget T3); consumers keep importing this name. */
export { OPS_MAX_EXTRACT_CHARS } from '../../../utils/contextCaps';
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
  /** Events in `batch` skipped for context overflow (nothing extracted from them). */
  skippedEvents: number;
  /** Raw fact / task item counts in the model response(s), for merged diagnostic itemIndex offsets. */
  factItems: number;
  taskItems: number;
}

/** Floor for recursive segmentation: a segment below this many chars is skipped, not split. */
const MIN_SEGMENT_CHARS = 500;

/** Max segment `extractOnce` calls per lone oversized event; past it the event is skipped. */
const MAX_SEGMENT_CALLS = 8;

const estimatePrompt = (p: { systemPrompt: string; userPrompt: string }) =>
  estimateTokens(p.systemPrompt) + estimateTokens(p.userPrompt);

export async function selectBatch(
  deps: LibrarianDeps,
  entityId: string,
  wm: LibrarianWatermark | null,
  meter?: UsageMeter,
  guidance?: string,
  budget?: ContextBudget,
  /** Write-time typing engaged for this pass (type-on-write §5): the manifest leaves the prompt. Same value as `runExtract`. */
  engaged = false,
): Promise<{ batch: LabeledEvent[] } | { budgetStop: { requiredEstimate: number } }> {
  const events: WikiEvent[] = await deps.eventRepo.getAfter(entityId, wm, OPS_MAX_EVENTS_PER_PASS);
  if (events.length === 0) return { batch: [] };

  const extractCap = resolveMaxPromptChars(budget ?? { mode: 'legacy', charsPerToken: 4, safetyFraction: 0.9, outputReserveTokens: 4000 }, 'extract');
  let n = 0;
  let chars = 0;
  for (const e of events) {
    if (n > 0 && chars + e.summary.length > extractCap) break;
    chars += e.summary.length;
    n++;
  }
  let batch = labelEvents(events.slice(0, n));

  if (meter && meter.budget !== undefined) {
    const ontologyContext = (await deps.ontologyService?.buildWritePromptContext(entityId, { engaged })) ?? null;
    for (;;) {
      const need = RESOLVE_RESERVE_FACTOR * estimatePrompt(deps.promptService.buildOpsExtractPrompt(batch, ontologyContext, guidance));
      if (meter.fits(need)) break;
      if (batch.length === 1) return { budgetStop: { requiredEstimate: need } };
      batch = labelEvents(events.slice(0, Math.max(1, Math.floor(batch.length / 2))));
    }
  }
  return { batch };
}

type OntologyCtx = Awaited<ReturnType<NonNullable<LibrarianDeps['ontologyService']>['buildWritePromptContext']>> | null;

/** Split a summary into two halves at the whitespace boundary nearest the middle (hard split when none). */
function splitSummary(summary: string): [string, string] {
  const mid = Math.floor(summary.length / 2);
  let cut = -1;
  for (let d = 0; d <= mid; d++) {
    if (/\s/.test(summary[mid - d] ?? '')) { cut = mid - d; break; }
    if (/\s/.test(summary[mid + d] ?? '')) { cut = mid + d; break; }
  }
  if (cut <= 0 || cut >= summary.length - 1) cut = mid;
  return [summary.slice(0, cut), summary.slice(cut)];
}

function dedupeByType<T extends { type: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.type) ? false : (seen.add(x.type), true)));
}

/**
 * Model-supplied `ontology_updates` is untrusted: fields may be missing, non-arrays,
 * or contain null entries. Normalize to the shape mergeOutcomes/mergeOntologyUpdates
 * expect (arrays of objects with a non-empty string `type`), mirroring the
 * `if (!type) continue` contract in utils/ontology.ts. Non-object input → undefined
 * (absent), so 'ontology_updates absent' semantics are preserved.
 */
function normalizeOntologyUpdates(raw: unknown): OntologyUpdates | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as { node_types?: unknown; edge_types?: unknown };
  // Filter keeps whole entries; the predicate only validates `type`, other
  // properties pass through untouched for downstream application.
  const pick = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter(
      (x): x is { type: string } => !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string' && (x as { type: string }).type.length > 0,
    ) as unknown[];
  const node_types = pick(r.node_types) as NonNullable<OntologyUpdates['node_types']>;
  const edge_types = pick(r.edge_types) as NonNullable<OntologyUpdates['edge_types']>;
  return {
    ...(node_types.length ? { node_types } : {}),
    ...(edge_types.length ? { edge_types } : {}),
  };
}

function mergeOutcomes(a: ExtractOutcome, b: ExtractOutcome): ExtractOutcome {
  // Invariant: both halves carry a corpus or neither does, so the offset equals a's corpus length.
  if ((a.groundingCorpus === null) !== (b.groundingCorpus === null)) {
    throw new Error('ops extract: merge corpus invariant violated (only one half has a grounding corpus)');
  }
  const partOffset = a.groundingCorpus?.length ?? a.batch.length;
  // Candidates and fact_rejected diagnostics share the raw per-response fact-index
  // space (both are indices into parsed.facts), and diagnostics are already shifted
  // by a.factItems below — so b's candidates must shift by the same amount.
  const indexOffset = a.factItems;
  const candidates = [
    ...a.candidates,
    ...b.candidates.map((c) => ({
      ...c,
      index: c.index + indexOffset,
      sourcePartIndex: c.sourcePartIndex === null ? null : c.sourcePartIndex + partOffset,
    })),
  ];
  let ontologyUpdates: OntologyUpdates | undefined;
  if (a.ontologyUpdates || b.ontologyUpdates) {
    const nodes = dedupeByType([...(a.ontologyUpdates?.node_types ?? []), ...(b.ontologyUpdates?.node_types ?? [])]);
    const edges = dedupeByType([...(a.ontologyUpdates?.edge_types ?? []), ...(b.ontologyUpdates?.edge_types ?? [])]);
    ontologyUpdates = {
      ...(nodes.length ? { node_types: nodes } : {}),
      ...(edges.length ? { edge_types: edges } : {}),
    };
  }
  const shiftedDiags = b.diagnostics.map((d) => {
    const detail = d.detail as { itemIndex?: number } | undefined;
    if (typeof detail?.itemIndex !== 'number') return d;
    const off = d.code === 'fact_rejected' ? a.factItems : d.code === 'task_rejected' ? a.taskItems : 0;
    return off ? { ...d, detail: { ...detail, itemIndex: detail.itemIndex + off } } : d;
  });
  return {
    batch: [...a.batch, ...b.batch],
    candidates,
    tasks: [...a.tasks, ...b.tasks],
    ...(ontologyUpdates ? { ontologyUpdates } : {}),
    groundingCorpus: a.groundingCorpus || b.groundingCorpus ? [...(a.groundingCorpus ?? []), ...(b.groundingCorpus ?? [])] : null,
    diagnostics: [...a.diagnostics, ...shiftedDiags],
    skippedEvents: a.skippedEvents + b.skippedEvents,
    factItems: a.factItems + b.factItems,
    taskItems: a.taskItems + b.taskItems,
  };
}

/**
 * Extract one batch; on the FIRST context-overflow error a minimal-prompt probe runs
 * (before the retry tree); then, on overflow, halve and merge (sequential,
 * so the meter sees ordered spend). A lone oversized event is segmented into
 * `<label>#1` / `<label>#2` prompts that both resolve to the same event id; if
 * a segment still overflows, the event is returned as SKIPPED (no candidates,
 * `context_overflow_skipped` diagnostic, still in `batch`) so the watermark
 * advances past it instead of stalling the librarian (errata E3).
 */
async function extractWithOverflowRetry(
  deps: LibrarianDeps, ctx: LibrarianPassContext, ontologyContext: OntologyCtx, batch: LabeledEvent[],
  probe: { checked: boolean },
): Promise<ExtractOutcome> {
  try {
    return await extractOnce(deps, ctx, ontologyContext, batch);
  } catch (err) {
    if (!isContextOverflowError(err)) throw err;
    if (!probe.checked) {
      // First overflow of the run: probe once with a minimal prompt, BEFORE the retry tree,
      // to tell an event-caused overflow (probe succeeds: retry tree proceeds) from a
      // fixed-prompt one (probe also overflows: throw, visible config failure, watermark held).
      probe.checked = true;
      const probePrompt = deps.promptService.buildOpsExtractPrompt(
        [{ ...batch[0], event: { ...batch[0].event, summary: 'x' } }], ontologyContext, ctx.guidance,
      );
      // Metered like every other model call (INTENT rule 7, one token budget):
      // exhaustion throws WikiBudgetExhausted, which surfaces upstream as a budgetStop.
      try {
        await callLlm(deps.options, { operation: 'librarian', entityId: ctx.entityId, trigger: ctx.trigger, meter: ctx.meter }, probePrompt);
      } catch (e) {
        if (!isContextOverflowError(e)) throw e;
        throw new Error('ops extract: minimal-prompt probe also overflowed (fixed prompt part exceeds the model window?)');
      }
    }
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      // If the second half throws WikiBudgetExhausted, the first half's
      // result is discarded (data-correct; its spend is re-paid next pass),
      // matching the runBatched contract.
      const a = await extractWithOverflowRetry(deps, ctx, ontologyContext, batch.slice(0, mid), probe);
      const b = await extractWithOverflowRetry(deps, ctx, ontologyContext, batch.slice(mid), probe);
      return mergeOutcomes(a, b);
    }
    const lone = batch[0];
    const skipDiag = (): WikiDiagnosticInput => ({
      entityId: ctx.entityId, operation: 'librarian', trigger: ctx.trigger,
      code: 'context_overflow_skipped', detail: { sourceRef: lone.event.id },
    });
    const segLabel = (label: string, n: number) => (label.includes('#') ? `${label}.${n}` : `${label}#${n}`);
    let segCalls = 0;
    // Returns null when the segment (and every sub-segment) was skipped.
    const extractSegment = async (label: string, text: string, alreadyOverflowed: boolean): Promise<ExtractOutcome | null | 'partial'> => {
      if (!alreadyOverflowed) {
        if (segCalls >= MAX_SEGMENT_CALLS) return null; // fan-out cap: stop splitting, skip
        segCalls++;
        try {
          return await extractOnce(deps, ctx, ontologyContext, [{ label, at: lone.at, event: { ...lone.event, summary: text } }]);
        } catch (e) {
          if (!isContextOverflowError(e)) throw e;
        }
      }
      if (text.length < 2 * MIN_SEGMENT_CHARS) return null;
      const [h1, h2] = splitSummary(text);
      if (h1.length < MIN_SEGMENT_CHARS || h2.length < MIN_SEGMENT_CHARS) return null;
      const a = await extractSegment(segLabel(label, 1), h1, false);
      const b = await extractSegment(segLabel(label, 2), h2, false);
      if (a === 'partial' || b === 'partial') return 'partial';
      if (!a && !b) return null;
      if (!a || !b) return 'partial'; // one segment extracted, its sibling skipped
      return mergeOutcomes(a, b);
    };
    const merged = await extractSegment(lone.label, lone.event.summary, true);
    // E3: every segment extracts, or the whole event is skipped (partial candidates dropped).
    if (!merged || merged === 'partial') {
      // Carry this event's own corpus entry so merged partOffset math stays aligned to batch slots.
      const corpus = deps.promptService.buildOpsExtractPrompt([lone], ontologyContext, ctx.guidance).groundingCorpus ?? null;
      return {
        batch: [lone], candidates: [], tasks: [], groundingCorpus: corpus, diagnostics: [skipDiag()],
        skippedEvents: 1, factItems: 0, taskItems: 0,
      };
    }
    return { ...merged, batch: [lone] };
  }
}

export async function runExtract(deps: LibrarianDeps, ctx: LibrarianPassContext, batch: LabeledEvent[], engaged = false): Promise<ExtractOutcome> {
  const ontologyContext = (await deps.ontologyService?.buildWritePromptContext(ctx.entityId, { engaged })) ?? null;
  return extractWithOverflowRetry(deps, ctx, ontologyContext, batch, { checked: false });
}

async function extractOnce(deps: LibrarianDeps, ctx: LibrarianPassContext, ontologyContext: OntologyCtx, batch: LabeledEvent[]): Promise<ExtractOutcome> {
  const { entityId, trigger } = ctx;
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

  const ontologyUpdates = normalizeOntologyUpdates(parsed.ontology_updates);
  return {
    batch,
    candidates,
    tasks,
    ...(ontologyUpdates ? { ontologyUpdates } : {}),
    groundingCorpus: prompt.groundingCorpus ?? null,
    diagnostics,
    skippedEvents: 0,
    factItems: Array.isArray(parsed.facts) ? parsed.facts.length : 0,
    taskItems: Array.isArray(parsed.tasks) ? parsed.tasks.length : 0,
  };
}
