import { DiagnosticBuffer } from '../../../utils/diagnostics';
import { WikiBudgetExhausted } from '../../../utils/usage';
import type { LibrarianStrategy } from '../types';
import { runExtract, selectBatch } from './extract';
import { gateCandidates, gateNeedsKeyword, resolveGateConfig } from './gate';
import { WikiSearchUnavailableError } from '../../../types';
import { runResolve } from './resolve';
import { resolveContextBudget } from '../../../config/context';
import { applyOps } from './apply';
import { resolveTypingMinConfidence } from '../../../utils/engineDefaults';
import {
  canEngageWriteTyping, classifyFactsForWrite, emptyTypingCounters, tallyTypingOutcome,
  volunteeredTypeResolves, type TypingOutcome,
} from '../../typing/typeOnWrite';
import type { GatedCandidate } from './gate';

/**
 * Op-based, similarity-gated librarian (spec §5.2–§5.7, §10.3). Extract
 * candidates from events after the watermark with no existing facts in the
 * prompt, gate each candidate against its top-k current neighbours without
 * the LLM, resolve only ambiguous candidates in one batched call returning
 * ADD / UPDATE / SUPERSEDE / NOOP, apply everything in one transaction, and
 * advance the watermark to the final batch event.
 *
 * Ordering notes (mirrored by Appendix A.5):
 *  - The watermark is anchored to the batch's newest `event.created_at` (not
 *    `occurred_at`): the watermark orders the log, and the log's timestamp
 *    is `created_at` (see `EventRepository.findSliced`).
 *  - A draft reuses its gate vector. The vector encodes the fact's text, and
 *    draft status doesn't change the text — so a separate `embedFact` call
 *    would recompute the same vector and trigger an extra provider round
 *    trip for nothing.
 */
export const runOpsLibrarianPass: LibrarianStrategy = async (deps, ctx) => {
  const { entityId, trigger } = ctx;
  const cfg = resolveGateConfig(deps.options.config?.librarian?.gate);

  await deps.seedWatermark(entityId);
  const wm = await deps.getWatermark(entityId);
  // Write-time typing (specs/type-on-write §2): resolved once per pass. The same
  // `engaged` value feeds the selectBatch reserve estimate and the extract prompt,
  // so the estimate is computed from the prompt actually sent.
  const typingState = deps.ontologyService ? await deps.ontologyService.getEffectiveState(entityId) : undefined;
  const engaged = typingState !== undefined
    && canEngageWriteTyping(deps.options.config, deps.options.llmProvider, typingState.mode, typingState.manifest);
  const sel = await selectBatch(deps, entityId, wm, ctx.meter, ctx.guidance, resolveContextBudget(deps.options.config), engaged);
  if ('budgetStop' in sel) return { processedThrough: null, factsWritten: 0, budgetStop: sel.budgetStop };
  if (sel.batch.length === 0) return { processedThrough: null, factsWritten: 0 };

  // Keyword outage: abort BEFORE paying for extraction, but only when this
  // pass could need keyword mode - an unconditional abort would stall the
  // librarian and hold back event pruning (spec #280 rev 10 M4). Throwing
  // keeps the watermark, like resolve's transient-error abort.
  if (!deps.searchService.isKeywordAvailable() && (await gateNeedsKeyword(deps, entityId))) {
    throw new WikiSearchUnavailableError('librarian: keyword search unavailable and this pass may need it; retry the pass');
  }

  let ex;
  try {
    ex = await runExtract(deps, ctx, sel.batch, engaged);
  } catch (err) {
    if (err instanceof WikiBudgetExhausted) {
      return { processedThrough: null, factsWritten: 0, budgetStop: { requiredEstimate: err.requiredEstimate } };
    }
    throw err;
  }

  const diagnostics = new DiagnosticBuffer();
  for (const d of ex.diagnostics) diagnostics.push(d);

  const { gated, inBatchDuplicates, gateDiagnostic } = await gateCandidates(deps, ctx, ex.candidates, cfg);
  for (const dup of inBatchDuplicates) {
    diagnostics.push({
      code: 'fact_deduplicated', operation: 'librarian', trigger, entityId,
      detail: { itemIndex: dup.index, reason: 'in_batch' },
    });
  }
  diagnostics.push(gateDiagnostic);

  const res = await runResolve(deps, ctx, gated.filter((g) => g.decision.kind === 'ambiguous'), resolveContextBudget(deps.options.config));
  // Resolve reported overflow skips without emitting (so a budget stop can
  // discard them with the pass buffer); buffer them BEFORE the budgetStop check.
  for (const itemIndex of res.overflowSkipped) {
    diagnostics.push({
      entityId, operation: 'librarian', trigger, code: 'context_overflow_skipped',
      detail: { itemIndex }, // (index into the merged extract batch)
    });
  }
  // Classifier-settled NOOPs get one receipt each, buffered here (like the
  // overflow skips above) so a budget stop discards them with the pass.
  for (const itemIndex of res.classifierSettled) {
    diagnostics.push({
      entityId, operation: 'librarian', trigger, code: 'fact_deduplicated',
      detail: { itemIndex, reason: 'classifier' }, // (index into the merged extract batch)
    });
  }
  if (res.budgetStop) {
    diagnostics.discard();
    return { processedThrough: null, factsWritten: 0, budgetStop: res.budgetStop };
  }

  // Typing step (§3): between resolve and the transaction. Candidates are exactly
  // the set applyOps will insert (not gate-NOOP, not resolve-NOOP); an
  // UPDATE-in-place candidate, or one applyOps later drops because its own
  // source event vanished (source_event_gone), is asked and its answer
  // unused (both disclosed). No
  // database write; a budget stop here never discards the pass (§3).
  const typingCounters = engaged ? emptyTypingCounters() : undefined;
  const typingOutcomes = new Map<GatedCandidate, TypingOutcome>();
  if (engaged && typingState && typingCounters) {
    const failed = new Set(res.failed);
    const rejected = new Set(res.rejected);
    const asked = gated.filter((g) => {
      if (g.decision.kind === 'noop') return false;
      if (volunteeredTypeResolves((g.candidate.fact as { okf_type?: unknown }).okf_type, typingState.manifest)) return false;
      if (g.decision.kind === 'add' || failed.has(g)) return true;
      const op = res.ops.get(g);
      if (rejected.has(g) || !op) return true;
      return op.op !== 'NOOP';
    });
    const outcomes = await classifyFactsForWrite(
      deps.options,
      { entityId, trigger, meter: ctx.meter, operation: 'librarian' },
      asked.map((g) => g.candidate.fact), typingState.manifest, resolveTypingMinConfidence(deps.options.config),
    );
    asked.forEach((g, n) => { typingOutcomes.set(g, outcomes[n]); tallyTypingOutcome(typingCounters, outcomes[n]); });
  }

  const { written, updatedIds, supersededIds } = await applyOps(deps, ctx, {
    typing: typingCounters ? { outcomes: typingOutcomes, counters: typingCounters } : undefined,
    gated,
    ops: res.ops,
    rejected: res.rejected,
    failed: res.failed,
    tasks: ex.tasks,
    ontologyUpdates: ex.ontologyUpdates,
    groundingCorpus: ex.groundingCorpus,
    diagnostics,
  });
  diagnostics.flush(deps.options);

  await deps.searchService.syncEntries(entityId, [...written.map((w) => w.id), ...updatedIds]);
  const embedCtx = { operation: 'librarian' as const, trigger };
  for (const w of written) {
    if (w.vector) await deps.embeddingService.storeFactVector(w.fact, w.vector, embedCtx);
    else await deps.embeddingService.embedFact(w.fact, embedCtx);
  }
  if (updatedIds.length > 0) {
    for (const f of await deps.entryRepo.findByIds(updatedIds, [entityId])) {
      await deps.embeddingService.embedFact(
        { id: f.id, entity_id: f.entity_id, title: f.title, body: f.body, tags: f.tags },
        embedCtx,
      );
    }
  }
  deps.searchService.evictCache(entityId);

  const last = ex.batch[ex.batch.length - 1].event;
  return {
    processedThrough: { at: last.created_at, id: last.id },
    factsWritten: written.length + updatedIds.length,
    ...(typingCounters ? { typing: typingCounters } : {}),
    rewrittenIds: updatedIds,
    supersededIds,
  };
};
