import type { ExtractedFactEdge, ExtractedTask, OntologyUpdates, WikiFact, WikiSourcePointer, WikiTask } from '../../../types';
import { WikiSupersedeError } from '../../../types';
import type { TitleIndexEntry } from '../../OntologyService';
import { normalizeTitleKey, type EdgeDrop } from '../../../utils/ontology';
import { edgeDropDiagnostic, type DiagnosticBuffer } from '../../../utils/diagnostics';
import { checkGrounding, groundingOutcome, type GroundingVerdict } from '../../../utils/grounding';
import { generateId } from '../../../utils/ids';
import { TemporalService } from '../../TemporalService';
import type { LibrarianDeps, LibrarianPassContext } from '../types';
import type { GatedCandidate } from './gate';
import type { ResolvedOp } from './resolve';

export interface ApplyInput {
  gated: GatedCandidate[];
  ops: Map<GatedCandidate, ResolvedOp>;
  rejected: GatedCandidate[];
  failed: GatedCandidate[];
  tasks: ExtractedTask[];
  ontologyUpdates?: OntologyUpdates;
  groundingCorpus: string[] | null;
  diagnostics: DiagnosticBuffer;
}

export interface WrittenFact {
  id: string;
  vector: Float32Array | null;
  fact: { id: string; entity_id: string; title: string; body: string; tags: string[] };
}

/**
 * The pointer for one librarian insert (spec §Ops path + §Quote rule).
 * `event_id` comes from the candidate's resolved batch label; `ref` and
 * `position` have no producer and stay null. The `quote` is ops-only and
 * grounding-gated: when grounding is on AND the verdict is grounded, it is
 * the first retained quote that the NAMED event's own corpus part contains
 * (the corpus part index is the batch label's index); otherwise null. A
 * verified quote attributed to no event is the misleading provenance the
 * named-event check exists to prevent.
 */
function buildSourcePointer(
  candidate: GatedCandidate['candidate'],
  verdict: GroundingVerdict | null,
  groundingOn: boolean,
  groundingCorpus: readonly string[] | null,
): WikiSourcePointer | null {
  if (candidate.sourceEventId === null) return null;
  let quote: string | null = null;
  if (groundingOn && verdict?.status === 'grounded' && candidate.sourcePartIndex !== null) {
    const part = groundingCorpus?.[candidate.sourcePartIndex];
    if (part !== undefined) {
      quote = verdict.retained.find((q) => part.includes(q)) ?? null;
    }
  }
  return { event_id: candidate.sourceEventId, ref: null, quote, position: null };
}

/**
 * One transaction, mirrored after legacy's order (spec §5.5). The caller has
 * already split candidates into `gated` (gate decision + optional op) and the
 * smaller `rejected` / `failed` sets; this module is the single write seam.
 *
 * Why one transaction: supersedeInTx validates before writing, so a failed
 * validation rolls back cleanly. Catching only `WikiSupersedeError` means any
 * other error (DB, ontology, embedding) propagates and aborts the whole pass
 * — `supersedeInTx` leaves no partial state to recover.
 */
export async function applyOps(
  deps: LibrarianDeps,
  ctx: LibrarianPassContext,
  input: ApplyInput,
): Promise<{ written: WrittenFact[]; updatedIds: string[] }> {
  const { entityId, trigger } = ctx;
  const diagBase = { entityId, operation: 'librarian' as const, trigger };
  const grounding = deps.promptService.groundingFor('librarian');
  const temporal = new TemporalService(deps.db, deps.options, deps.entryRepo, deps.searchService, deps.embeddingService);
  const rejected = new Set(input.rejected);
  const failed = new Set(input.failed);
  const written: WrittenFact[] = [];
  const updatedIds: string[] = [];
  const now = Date.now();

  await deps.db.withTransactionAsync(async (tx) => {
    let { mode, manifest } = await deps.ontologyService?.getEffectiveState(entityId, tx)
      ?? { mode: 'off' as const, manifest: { node_types: [], edge_types: [] } };
    if (mode === 'emergent' && input.ontologyUpdates && deps.ontologyService) {
      manifest = await deps.ontologyService.mergeEmergentUpdates(entityId, input.ontologyUpdates, tx);
    }
    const titleIndex = new Map<string, TitleIndexEntry>();
    for (const f of await deps.entryRepo.findRecentByEntityId(entityId, 100, tx)) {
      titleIndex.set(normalizeTitleKey(f.title), { id: f.id, okf_type: f.okf_type ?? null });
    }
    const pendingEdges: Array<{ sourceId: string; sourceType: string | null; edges: ExtractedFactEdge[] }> = [];

    const insert = async (g: GatedCandidate, draft: boolean, validFrom: number, overrides?: { title?: string; body?: string }): Promise<string> => {
      const fact = g.candidate.fact;
      const title = overrides?.title ?? fact.title;
      const body = overrides?.body ?? fact.body;
      const id = generateId('fact_');
      const drops: EdgeDrop[] = [];
      const normalized = deps.ontologyService?.validateAndNormalizeFact(fact, manifest, { strict: false, drops })
        ?? { okf_type: null, edges: [] };
      for (const d of drops) input.diagnostics.push(edgeDropDiagnostic(d, { ...diagBase, factId: id }));
      const gVerdict: GroundingVerdict | null = grounding
        ? checkGrounding(fact.evidence, input.groundingCorpus ?? [], grounding)
        : null;
      const g2 = gVerdict ? groundingOutcome(gVerdict, now) : null;
      if (g2?.diagnostic) {
        input.diagnostics.push({
          ...diagBase,
          code: g2.diagnostic.code,
          detail: { factId: id, itemIndex: g.candidate.index, reason: g2.diagnostic.reason },
        });
      }
      const pointer = buildSourcePointer(g.candidate, gVerdict, grounding !== undefined && grounding !== null, input.groundingCorpus);
      const row: WikiFact = {
        id, entity_id: entityId, title, body, tags: fact.tags, confidence: fact.confidence,
        source_type: 'librarian_inferred', source_hash: null, source_ref: null,
        created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
        okf_type: normalized.okf_type,
        source_pointer: pointer,
        ...g2?.trust,
        ...(draft ? { lifecycle_status: 'draft' as const } : {}),
      };
      await deps.entryRepo.upsert(row, tx);
      await deps.entryRepo.setTemporal(id, entityId, { valid_from: validFrom }, tx);
      // Rule 6 fix (spec §Ops path + §Diagnostics): a fact that landed without
      // its pointer is reported, not swallowed. Candidates the gate rejects or
      // merges never reach insert(), so they emit nothing.
      if (g.candidate.pointerUnresolved !== null) {
        input.diagnostics.push({
          ...diagBase,
          factId: id,
          code: 'source_pointer_unresolved',
          detail: { factId: id, itemIndex: g.candidate.index, reason: g.candidate.pointerUnresolved },
        });
      }
      titleIndex.set(normalizeTitleKey(title), { id, okf_type: normalized.okf_type });
      if (normalized.edges.length > 0) pendingEdges.push({ sourceId: id, sourceType: normalized.okf_type, edges: normalized.edges });
      // The gate vector encodes the candidate's own text; when overrides
      // changed what was stored, drop it so the fact is embedded afresh.
      const textChanged = title !== fact.title || body !== fact.body;
      written.push({ id, vector: textChanged ? null : g.vector, fact: { id, entity_id: entityId, title, body, tags: fact.tags } });
      return id;
    };

    for (const g of input.gated) {
      const idx = g.candidate.index;
      const vf = g.candidate.validFrom;
      if (g.decision.kind === 'noop') continue;
      if (g.decision.kind === 'add') { await insert(g, false, vf); continue; }

      if (failed.has(g)) {
        const id = await insert(g, true, vf);
        input.diagnostics.push({ ...diagBase, code: 'resolve_failed', detail: { factId: id, itemIndex: idx } });
        continue;
      }
      const op = input.ops.get(g);
      if (rejected.has(g) || !op) {
        await insert(g, false, vf);
        input.diagnostics.push({ ...diagBase, code: 'librarian_op_rejected', detail: { itemIndex: idx, reason: 'invalid_op' } });
        continue;
      }
      if (op.op === 'NOOP') continue;
      if (op.op === 'ADD') { await insert(g, false, vf); continue; }

      const target = g.neighbours.find((n) => n.id === op.targetId)!;
      if (op.op === 'UPDATE' && target.source_type === 'librarian_inferred') {
        const [existing] = await deps.entryRepo.findByIds([op.targetId], [entityId], tx);
        if (existing) {
          const newTitle = op.title ?? g.candidate.fact.title;
          await deps.entryRepo.upsert({
            ...existing,
            title: newTitle,
            body: op.body ?? g.candidate.fact.body,
            updated_at: now,
          }, tx);
          // Keep the pass-local index in step with the row (as insert() does),
          // so later candidates' edges resolve the new title, not the old one.
          titleIndex.delete(normalizeTitleKey(existing.title));
          titleIndex.set(normalizeTitleKey(newTitle), { id: existing.id, okf_type: existing.okf_type ?? null });
          updatedIds.push(existing.id);
          continue;
        }
      }

      // SUPERSEDE, or UPDATE of a non-librarian target (spec §5.5).
      const supersedeFrom = op.op === 'SUPERSEDE' && op.validFrom !== undefined ? op.validFrom : vf;
      // When the model emitted UPDATE, its `title`/`body` describe the merged
      // target text; the new fact in a SUPERSEDE must reflect them too, not
      // just the candidate's raw text.
      const overrides = op.op === 'UPDATE' ? { title: op.title, body: op.body } : undefined;
      if (target.source_type === 'immutable_document') {
        const id = await insert(g, true, supersedeFrom, overrides);
        input.diagnostics.push({ ...diagBase, code: 'contradicts_document', detail: { factId: id, itemIndex: idx } });
        continue;
      }
      const newId = await insert(g, false, supersedeFrom, overrides);
      try {
        await temporal.supersedeInTx(tx, entityId, op.targetId, newId, supersedeFrom, now);
      } catch (err) {
        if (!(err instanceof WikiSupersedeError)) throw err;
        input.diagnostics.push({
          ...diagBase,
          code: 'librarian_op_rejected',
          detail: { factId: newId, itemIndex: idx, reason: err.reason },
        });
      }
    }

    for (const item of pendingEdges) {
      const resolveDrops: EdgeDrop[] = [];
      await deps.ontologyService?.resolveAndPersistEdges(
        entityId, item.sourceId, item.sourceType, item.edges, manifest, titleIndex, tx, now, resolveDrops,
      );
      for (const d of resolveDrops) input.diagnostics.push(edgeDropDiagnostic(d, diagBase));
    }

    for (const task of input.tasks) {
      const taskObj: WikiTask = {
        id: generateId('task_'), entity_id: entityId, description: task.description, status: 'pending', priority: task.priority,
        created_at: now, updated_at: now, resolved_at: null, deleted_at: null,
      };
      await deps.taskRepo.upsert(taskObj, tx);
    }
  });

  return { written, updatedIds };
}
