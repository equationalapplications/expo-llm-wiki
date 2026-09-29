/**
 * Legacy librarian pass (spec 2026-09-29 §5.1, §5.8).
 *
 * Verbatim move of `MaintenanceService.doRunLibrarian` as it existed at PR-S
 * cut. The body here must stay byte-for-byte equivalent to the pre-move
 * implementation; the only mechanical changes are:
 *
 *   - `this.x` → `deps.x` for every member access.
 *   - `this.options.llmProvider.generateText(...)` →
 *       `callLlm(deps.options, { operation, entityId, trigger, meter }, ...)`
 *       wrapped in a try/catch that converts `WikiBudgetExhausted` into the
 *       `LibrarianResult.budgetStop` field instead of letting it bubble.
 *   - The trailing `this.searchService.evictCache(entityId)` is followed
 *     by a `LibrarianResult` return.
 *
 * Parity is enforced by `__tests__/librarianLegacyParity.test.ts` whose
 * snapshot was recorded *before* this file was created; if the snapshot
 * changes after the move, the move was not equivalent.
 */

import { parseJsonResponse, validateFact, validateTask, titleTokens, jaccardScore, factRejectionReason, taskRejectionReason } from '../../utils/pure';
import { checkGrounding, groundingOutcome } from '../../utils/grounding';
import { normalizeTitleKey, type EdgeDrop } from '../../utils/ontology';
import { DiagnosticBuffer, edgeDropDiagnostic } from '../../utils/diagnostics';
import { generateId } from '../../utils/ids';
import { callLlm } from '../../utils/llmCall';
import { WikiBudgetExhausted } from '../../utils/usage';
import { FUZZY_THRESHOLD, MIN_TOKENS_TO_QUALIFY } from './constants';
import type { LibrarianStrategy, LibrarianResult, EventCursor, TitleIndexEntry } from './types';
import type { ExtractedFact, ExtractedFactWithOntology, ExtractedTask, WikiFact, WikiTask, OntologyUpdates } from '../../types';

export const runLegacyLibrarianPass: LibrarianStrategy = async (deps, ctx) => {
    const { entityId, trigger } = ctx;
    const promptOverride = ctx.promptOverride;
    const events = await deps.eventRepo.getRecent(entityId, 50);
    const currentFactsRows = await deps.entryRepo.findRecentByEntityId(entityId, 100);

    const currentFacts = currentFactsRows.map(f => {
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      return {
        ...rest,
        tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags,
      };
    });

    const ontologyContext = await deps.ontologyService?.buildPromptContext(entityId) ?? null;

    const promptEvents = events.reverse();
    const librarianGrounding = deps.promptService.groundingFor('librarian');

    // groundingCorpus (spec §6.3) is built with the prompt, from the event
    // summaries that prompt actually shows.
    const { systemPrompt, userPrompt, groundingCorpus: librarianCorpus = [] } = deps.promptService.buildLibrarianPrompt(
      promptEvents,
      currentFacts,
      promptOverride,
      ontologyContext,
    );

    let responseText: string;
    try {
      responseText = await callLlm(
        deps.options,
        { operation: 'librarian', entityId, trigger, meter: ctx.meter },
        { systemPrompt, userPrompt },
      );
    } catch (err) {
      if (err instanceof WikiBudgetExhausted) {
        return { processedThrough: null, factsWritten: 0, budgetStop: { requiredEstimate: err.requiredEstimate } };
      }
      throw err;
    }

    const result = parseJsonResponse<{
      facts: ExtractedFact[];
      tasks: ExtractedTask[];
      ontology_updates?: OntologyUpdates;
    }>(responseText);
    const facts = Array.isArray(result.facts) ? result.facts : [];
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    const ontologyUpdates = result.ontology_updates;

    const diagBuffer = new DiagnosticBuffer();
    const diagBase = { entityId, operation: 'librarian' as const, trigger };
    const validFacts: ExtractedFact[] = [];
    const validFactItemIndexes: number[] = [];
    facts.forEach((raw, itemIndex) => {
      const valid = validateFact(raw);
      if (valid) {
        validFacts.push(valid);
        validFactItemIndexes.push(itemIndex);
      } else {
        diagBuffer.push({ ...diagBase, code: 'fact_rejected', detail: { itemIndex, reason: factRejectionReason(raw) } });
      }
    });
    const validTasks: ExtractedTask[] = [];
    tasks.forEach((raw, itemIndex) => {
      const valid = validateTask(raw);
      if (valid) validTasks.push(valid);
      else diagBuffer.push({ ...diagBase, code: 'task_rejected', detail: { itemIndex, reason: taskRejectionReason(raw) } });
    });

    const now = Date.now();
    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];

    await deps.db.withTransactionAsync(async (tx) => {
      let { mode, manifest } = await deps.ontologyService?.getEffectiveState(entityId, tx)
        ?? { mode: 'off' as const, manifest: { node_types: [], edge_types: [] } };

      if (mode === 'emergent' && ontologyUpdates && deps.ontologyService) {
        manifest = await deps.ontologyService.mergeEmergentUpdates(entityId, ontologyUpdates, tx);
      }

      const titleIndex = new Map<string, TitleIndexEntry>();
      for (const existing of currentFactsRows) {
        titleIndex.set(normalizeTitleKey(existing.title), {
          id: existing.id,
          okf_type: existing.okf_type ?? null,
        });
      }

      const factsForDedupe = await deps.entryRepo.findRecentByEntityId(entityId, 100, tx);

      const pendingEdges: Array<{
        sourceId: string;
        sourceType: string | null;
        edges: ExtractedFactWithOntology['edges'];
      }> = [];

      for (const [k, fact] of validFacts.entries()) {
        const newTokens = titleTokens(fact.title);
        let skip = false;

        if (newTokens.size >= MIN_TOKENS_TO_QUALIFY) {
          for (const existing of factsForDedupe) {
            if (existing.source_type !== 'librarian_inferred') continue;
            const existingTokens = titleTokens(existing.title);
            if (existingTokens.size >= MIN_TOKENS_TO_QUALIFY) {
              if (jaccardScore(newTokens, existingTokens) >= FUZZY_THRESHOLD) {
                skip = true;
                break;
              }
            }
          }
        }

        if (skip) {
          diagBuffer.push({ ...diagBase, code: 'fact_deduplicated', detail: { itemIndex: validFactItemIndexes[k], reason: 'fuzzy_title' } });
          continue;
        }

        const ontologyFact = fact as ExtractedFactWithOntology;
        const id = generateId('fact_');
        const validationDrops: EdgeDrop[] = [];
        const normalized = deps.ontologyService?.validateAndNormalizeFact(ontologyFact, manifest, { strict: false, drops: validationDrops })
          ?? { okf_type: null, edges: [] };
        for (const drop of validationDrops) diagBuffer.push(edgeDropDiagnostic(drop, { ...diagBase, factId: id }));

        const grounding = librarianGrounding
          ? groundingOutcome(checkGrounding(fact.evidence, librarianCorpus, librarianGrounding), now)
          : null;
        if (grounding?.diagnostic) {
          diagBuffer.push({ ...diagBase, code: grounding.diagnostic.code, detail: { factId: id, itemIndex: validFactItemIndexes[k], reason: grounding.diagnostic.reason } });
        }

        const factObj: WikiFact = {
          id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
          source_type: 'librarian_inferred', source_hash: null, source_ref: null,
          created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
          okf_type: normalized.okf_type,
          ...grounding?.trust,
        };

        await deps.entryRepo.upsert(factObj, tx);
        insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
        factsForDedupe.push(factObj);

        titleIndex.set(normalizeTitleKey(fact.title), { id, okf_type: normalized.okf_type });

        if (normalized.edges.length > 0) {
          pendingEdges.push({ sourceId: id, sourceType: normalized.okf_type, edges: normalized.edges });
        }
      }

      for (const item of pendingEdges) {
        const resolveDrops: EdgeDrop[] = [];
        await deps.ontologyService?.resolveAndPersistEdges(
          entityId, item.sourceId, item.sourceType, item.edges ?? [], manifest, titleIndex, tx, now, resolveDrops,
        );
        for (const drop of resolveDrops) diagBuffer.push(edgeDropDiagnostic(drop, diagBase));
      }

      for (const task of validTasks) {
        const id = generateId('task_');
        const taskObj: WikiTask = {
          id, entity_id: entityId, description: task.description, status: 'pending', priority: task.priority,
          created_at: now, updated_at: now, resolved_at: null, deleted_at: null
        };
        await deps.taskRepo.upsert(taskObj, tx);
      }
    });

    diagBuffer.flush(deps.options);

    // The transaction only inserts (fresh generateId('fact_') rows); tasks and
    // edges are not indexed, so insertedFacts is the complete mutation set and
    // the index update is O(inserted), not O(entity) (spec §2.3).
    await deps.searchService.syncEntries(entityId, insertedFacts.map((f) => f.id));

    for (const fact of insertedFacts) {
      await deps.embeddingService.embedFact(fact, { operation: 'librarian', trigger });
    }

    deps.searchService.evictCache(entityId);

    // After `events.reverse()`, the array is oldest-first; the last element is
    // the newest event the pass read. Empty event log → null. Post-move
    // refinement (sanctioned): the cursor carries the event's `created_at`
    // alongside its id, so callers can advance checkpoints without re-querying.
    const processedThrough: EventCursor | null =
      events.length > 0 ? { at: events[events.length - 1].created_at, id: events[events.length - 1].id } : null;
    const out: LibrarianResult = { processedThrough, factsWritten: insertedFacts.length };
    return out;
  };
