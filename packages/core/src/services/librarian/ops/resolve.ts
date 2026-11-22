import { callLlm, callClassify } from '../../../utils/llmCall';
import { validateClassifierAnswer, classifierStateForFact } from '../../../utils/classifier';
import { WikiBudgetExhausted } from '../../../utils/usage';
import { resolveSystemOneResolve, resolveResolveMinConfidence, warnOnce } from '../../../utils/engineDefaults';
import type { ClassifyRequest, ClassifyResponse, ClassifierQuestion } from '../../../types';
import { clip, parseJsonResponse, safeSlice } from '../../../utils/pure';
import { runBatched, isContextOverflowError } from '../../BoundedLlmCall';
import { OPS_RESOLVE_MAX_PROMPT_CHARS } from '../../../utils/contextCaps';
import { resolveMaxPromptChars } from '../../../config/context';
import type { ContextBudget } from '../../../utils/contextBudget';
import type { LibrarianDeps, LibrarianPassContext } from '../types';
import type { GatedCandidate } from './gate';
import { OPS_NEIGHBOUR_BODY_CHARS, parseValidFrom } from './text';

export type ResolvedOp =
  | { op: 'ADD' }
  | { op: 'UPDATE'; targetId: string; title?: string; body?: string }
  | { op: 'SUPERSEDE'; targetId: string; validFrom?: number }
  | { op: 'NOOP'; targetId: string };

export interface ResolveOutcome {
  ops: Map<GatedCandidate, ResolvedOp>;
  rejected: GatedCandidate[];
  failed: GatedCandidate[];
  /** Merged-extract batch indexes of candidates skipped for context overflow; the pass-level DiagnosticBuffer owns their emission. */
  overflowSkipped: number[];
  /** Merged-extract batch indexes of candidates the classifier screen settled as NOOP; the pass-level DiagnosticBuffer owns their receipts. */
  classifierSettled: number[];
  budgetStop?: { requiredEstimate: number };
}

export interface ScreenResult {
  settled: Map<GatedCandidate, ResolvedOp>;
  rest: GatedCandidate[];
  warnReason?: 'no-classifier' | 'no-floor';
  budgetStop?: { requiredEstimate: number };
}

/**
 * Screening prologue (resolution-system-one §4, §5). Pure apart from the
 * injected `ask`. For each candidate that has a neighbour, asks ONE binary
 * duplicate-only question about `neighbours[0]`; a confident YES
 * (`probability >= floor`) settles a terminal NOOP on that neighbour. Everything
 * else stays in `rest` for the generative resolve. All-or-nothing: any throw
 * discards partial results and the whole input falls through, except a
 * `WikiBudgetExhausted`, which surfaces as `budgetStop`.
 */
export async function screenResolveCandidates(
  ambiguous: GatedCandidate[],
  mode: 'auto' | 'llm',
  floor: number | undefined,
  ask: ((request: ClassifyRequest) => Promise<ClassifyResponse>) | undefined,
): Promise<ScreenResult> {
  const whole = (warnReason?: 'no-classifier' | 'no-floor'): ScreenResult =>
    warnReason ? { settled: new Map(), rest: ambiguous, warnReason } : { settled: new Map(), rest: ambiguous };
  if (mode !== 'auto') return whole();
  if (floor === undefined) return whole('no-floor');
  if (!ask) return whole('no-classifier');

  const settled = new Map<GatedCandidate, ResolvedOp>();
  const rest: GatedCandidate[] = [];
  for (const g of ambiguous) {
    const best = g.neighbours[0];
    if (!best) {
      rest.push(g);
      continue;
    }
    const question: ClassifierQuestion = {
      kind: 'binary',
      instructions:
        `Does this candidate add NO information beyond neighbour ${best.ref} (a pure duplicate: same claims, no new content)?\n` +
        `Neighbour ${best.ref} title: ${best.title}\n` +
        `Neighbour ${best.ref} body: ${safeSlice(best.body, 0, OPS_NEIGHBOUR_BODY_CHARS)}`,
    };
    let response: ClassifyResponse;
    try {
      response = await ask({
        state: classifierStateForFact({ title: g.candidate.fact.title, body: g.candidate.fact.body, tags: [] }),
        questions: { [best.ref]: question },
      });
    } catch (err) {
      if (err instanceof WikiBudgetExhausted) {
        return { settled: new Map(), rest: ambiguous, budgetStop: { requiredEstimate: err.requiredEstimate } };
      }
      return whole('no-classifier');
    }
    const checked = validateClassifierAnswer(response, best.ref, question);
    if (checked.ok && checked.answer.kind === 'binary' && checked.answer.probability >= floor) {
      settled.set(g, { op: 'NOOP', targetId: best.id });
    } else {
      rest.push(g);
    }
  }
  return { settled, rest };
}

/**
 * Pure: validate one raw op against ONE candidate's alias map.
 *
 * The alias map is per-candidate, so an op for item *i* may only name one of
 * item *i*'s own `n1…nk` refs. An op that names a label not in this map (even
 * one that is a valid id in the DB) is rejected — that's the scoping rule the
 * model can subvert when batches share labels, and that the brief's test
 * "rejects aliases outside THIS candidate map (per-candidate scoping)"
 * verifies.
 *
 * Anything that does not match the schema returns null. The caller decides
 * what to do with a rejected op (per spec §5.4: ADD with librarian_op_rejected).
 */
export function validateOp(raw: unknown, aliases: ReadonlyMap<string, string>): ResolvedOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.op === 'ADD') return { op: 'ADD' };
  if (r.op !== 'UPDATE' && r.op !== 'SUPERSEDE' && r.op !== 'NOOP') return null;
  const targetId = typeof r.target === 'string' ? aliases.get(r.target) : undefined;
  if (!targetId) return null;
  if (r.op === 'NOOP') return { op: 'NOOP', targetId };
  if (r.op === 'SUPERSEDE') {
    const validFrom = parseValidFrom(r.valid_from);
    return validFrom === undefined ? { op: 'SUPERSEDE', targetId } : { op: 'SUPERSEDE', targetId, validFrom };
  }
  const update: { op: 'UPDATE'; targetId: string; title?: string; body?: string } = { op: 'UPDATE', targetId };
  if (typeof r.title === 'string' && r.title.trim() !== '') update.title = clip(r.title, 80);
  if (typeof r.body === 'string' && r.body.trim() !== '') update.body = clip(r.body, 800);
  return update;
}

const aliasMapOf = (g: GatedCandidate): Map<string, string> =>
  new Map(g.neighbours.map((n) => [n.ref, n.id]));

/**
 * Reconcile the ambiguous candidates (gate step could not decide) in one
 * batched LLM call (spec §5.4). Items restart at 0 in every batch, so the op
 * list is indexed by `item` *within the result's own batch* — not across the
 * whole pass — and each candidate is validated against its own alias map.
 *
 * Behaviour mirrors `gateCandidates`: an empty input skips the LLM call
 * entirely, a budget stop surfaces upward without skipping the items, and a
 * malformed response at a single-item batch lands that candidate in `failed`.
 */
export async function runResolve(
  deps: LibrarianDeps,
  ctx: LibrarianPassContext,
  ambiguous: GatedCandidate[],
  budget?: ContextBudget,
): Promise<ResolveOutcome> {
  const out: ResolveOutcome = { ops: new Map(), rejected: [], failed: [], overflowSkipped: [], classifierSettled: [] };
  if (ambiguous.length === 0) return out;
  const { entityId, trigger } = ctx;

  const mode = resolveSystemOneResolve(deps.options.config);
  const floor = resolveResolveMinConfidence(deps.options.config);
  const provider = deps.options.llmProvider;
  const ask =
    mode === 'auto' && typeof provider.classify === 'function'
      ? (request: ClassifyRequest) =>
          callClassify(deps.options, { operation: 'librarian', entityId, trigger, meter: ctx.meter }, request)
      : undefined;
  const screen = await screenResolveCandidates(ambiguous, mode, floor, ask);
  if (screen.budgetStop) return { ...out, budgetStop: screen.budgetStop };
  // 'no-floor' was already warned by resolveResolveMinConfidence (once per process).
  if (screen.warnReason === 'no-classifier') {
    warnOnce(
      '[core-llm-wiki] systemOne: `systemOne.resolve` is \'auto\' but the provider has no usable classify() ' +
        '(absent or it threw); ambiguous candidates fall through to the generative resolve.',
    );
  }
  for (const [g, op] of screen.settled) {
    out.ops.set(g, op);
    out.classifierSettled.push(g.candidate.index);
  }
  if (screen.rest.length === 0) return out;

  const outcome = await runBatched<GatedCandidate, { batch: GatedCandidate[]; ops: unknown[] }>({
    items: screen.rest,
    buildPrompt: (batch) =>
      deps.promptService.buildOpsResolvePrompt(
        batch.map((g, i) => ({
          item: i,
          candidate: { title: g.candidate.fact.title, body: g.candidate.fact.body },
          existing: g.neighbours.map((n) => ({
            ref: n.ref,
            title: n.title,
            body: safeSlice(n.body, 0, OPS_NEIGHBOUR_BODY_CHARS),
          })),
        })),
      ),
    call: (prompts) => callLlm(deps.options, { operation: 'librarian', entityId, trigger, meter: ctx.meter }, prompts),
    parse: (text, batch) => {
      const parsed = parseJsonResponse<{ ops?: unknown }>(text);
      if (!Array.isArray(parsed.ops)) throw new Error('resolve: ops missing');
      return { batch, ops: parsed.ops };
    },
    onSkip: (g, err) => {
      // No direct emission: the pass-level DiagnosticBuffer in ops/index.ts
      // pushes these so a budget stop discards them with the pass instead of
      // re-emitting the same diagnostic on the next pass.
      if (isContextOverflowError(err)) out.overflowSkipped.push(g.candidate.index);
    },
    maxPromptChars: budget ? resolveMaxPromptChars(budget, 'resolve') : OPS_RESOLVE_MAX_PROMPT_CHARS,
    maxOutputTokens: deps.options.llmProvider.maxOutputTokens,
  });

  if (outcome.budgetStop) return { ...out, budgetStop: outcome.budgetStop };

  for (const { batch, ops } of outcome.results) {
    // Items restart at 0 in every batch; first op per item wins.
    const byItem = new Map<number, unknown>();
    for (const raw of ops) {
      const item = (raw as { item?: unknown } | null)?.item;
      if (
        typeof item === 'number' &&
        Number.isInteger(item) &&
        item >= 0 &&
        item < batch.length &&
        !byItem.has(item)
      ) {
        byItem.set(item, raw);
      }
    }
    batch.forEach((g, i) => {
      const op = validateOp(byItem.get(i), aliasMapOf(g));
      if (op) out.ops.set(g, op);
      else out.rejected.push(g);
    });
  }
  // A transient provider error (429, 5xx, reset) is not a resolve failure:
  // storing it as a draft would advance the watermark past a candidate that
  // never got an answer. Abort the pass so the watermark stays put, matching
  // what runBatched already does for the same error on a multi-item batch.
  if (outcome.skipped.some((s) => s.reason === 'call_error')) {
    throw new Error('resolve: transient provider error; retry the pass');
  }
  for (const s of outcome.skipped) out.failed.push(s.item);
  return out;
}
