import { callLlm } from '../../../utils/llmCall';
import { clip, parseJsonResponse, safeSlice } from '../../../utils/pure';
import { runBatched } from '../../BoundedLlmCall';
import type { LibrarianDeps, LibrarianPassContext } from '../types';
import type { GatedCandidate } from './gate';
import { OPS_NEIGHBOUR_BODY_CHARS, parseValidFrom } from './text';

const OPS_RESOLVE_MAX_PROMPT_CHARS = 40_000;

export type ResolvedOp =
  | { op: 'ADD' }
  | { op: 'UPDATE'; targetId: string; title?: string; body?: string }
  | { op: 'SUPERSEDE'; targetId: string; validFrom?: number }
  | { op: 'NOOP'; targetId: string };

export interface ResolveOutcome {
  ops: Map<GatedCandidate, ResolvedOp>;
  rejected: GatedCandidate[];
  failed: GatedCandidate[];
  budgetStop?: { requiredEstimate: number };
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
): Promise<ResolveOutcome> {
  const out: ResolveOutcome = { ops: new Map(), rejected: [], failed: [] };
  if (ambiguous.length === 0) return out;
  const { entityId, trigger } = ctx;

  const outcome = await runBatched<GatedCandidate, { batch: GatedCandidate[]; ops: unknown[] }>({
    items: ambiguous,
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
    maxPromptChars: OPS_RESOLVE_MAX_PROMPT_CHARS,
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
  for (const s of outcome.skipped) out.failed.push(s.item);
  return out;
}
