import { DiagnosticBuffer } from '../../../utils/diagnostics';
import { WikiBudgetExhausted } from '../../../utils/usage';
import type { LibrarianStrategy } from '../types';
import { runExtract, selectBatch } from './extract';
import { gateCandidates, resolveGateConfig } from './gate';
import { runResolve } from './resolve';
import { applyOps } from './apply';

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
  const sel = await selectBatch(deps, entityId, wm, ctx.meter);
  if ('budgetStop' in sel) return { processedThrough: null, factsWritten: 0, budgetStop: sel.budgetStop };
  if (sel.batch.length === 0) return { processedThrough: null, factsWritten: 0 };

  let ex;
  try {
    ex = await runExtract(deps, ctx, sel.batch);
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

  const res = await runResolve(deps, ctx, gated.filter((g) => g.decision.kind === 'ambiguous'));
  if (res.budgetStop) {
    diagnostics.discard();
    return { processedThrough: null, factsWritten: 0, budgetStop: res.budgetStop };
  }

  const { written, updatedIds } = await applyOps(deps, ctx, {
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

  const last = sel.batch[sel.batch.length - 1].event;
  return {
    processedThrough: { at: last.created_at, id: last.id },
    factsWritten: written.length + updatedIds.length,
  };
};
