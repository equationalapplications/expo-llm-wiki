import type { ExtractedFactEdge, ExtractedTask, OntologyUpdates, WikiFact, WikiSourcePointer, WikiTask } from '../../../types';
import { WikiSupersedeError } from '../../../types';
import type { TitleIndexEntry } from '../../OntologyService';
import { normalizeTitleKey, type EdgeDrop } from '../../../utils/ontology';
import { edgeDropDiagnostic, type DiagnosticBuffer } from '../../../utils/diagnostics';
import { checkGrounding, groundingOutcome, type GroundingVerdict } from '../../../utils/grounding';
import { generateId } from '../../../utils/ids';
import { dedupeEventIds } from '../../../utils/derivedEvents';
import { TemporalService } from '../../TemporalService';
import type { LibrarianDeps, LibrarianPassContext } from '../types';
import type { GatedCandidate } from './gate';
import type { ResolvedOp } from './resolve';
import { normalizeForWrite, type TypingCounters, type TypingOutcome } from '../../typing/typeOnWrite';

export interface ApplyInput {
  gated: GatedCandidate[];
  ops: Map<GatedCandidate, ResolvedOp>;
  rejected: GatedCandidate[];
  failed: GatedCandidate[];
  tasks: ExtractedTask[];
  ontologyUpdates?: OntologyUpdates;
  groundingCorpus: string[] | null;
  diagnostics: DiagnosticBuffer;
  /** Write-time typing outcomes keyed by candidate, and the pass counters `typed` is added to (type-on-write §4). Absent when not engaged. */
  typing?: { outcomes: Map<GatedCandidate, TypingOutcome>; counters: TypingCounters };
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
    // `sourcePartIndex` is the batch index, and the grounding corpus is built
    // one entry per batch event in the same order (PromptService builds it
    // from the same batch array). `events.summary` is TEXT NOT NULL, so
    // buildGroundingCorpus's non-string filter can never drop an entry and
    // shift a later index. Keep these two invariants paired: if either
    // changes, quotes attribute to the wrong event silently.
    const part = groundingCorpus?.[candidate.sourcePartIndex];
    if (part !== undefined) {
      quote = verdict.retained.find((q) => part.includes(q)) ?? null;
    }
  }
  return { event_id: candidate.sourceEventId, ref: null, quote, position: null };
}

/**
 * §2 UPDATE in place: the existing list plus the candidate's contributing
 * event, deduplicated; an id equal to the pointer's event is not added (it is
 * already the pointer). Returns the list to write, or undefined when there is
 * no change to make (key left absent so a stored list is untouched).
 */
function mergeDerivedEvents(existing: WikiFact, contributing: string | null): string[] | undefined {
  if (contributing === null || contributing === existing.source_pointer?.event_id) return undefined;
  const prior = existing.derived_events ?? [];
  if (prior.includes(contributing)) return undefined;
  return dedupeEventIds([...prior, contributing]);
}

/**
 * §2 UPDATE converted to SUPERSEDE: the replacement's merged text rests on the
 * target, so it inherits the target's pointer event and list, minus its own
 * pointer event. Empty result = key absent.
 */
function inheritedDerivedEvents(target: WikiFact | undefined, ownEventId: string | null): { derived_events?: string[] } {
  if (!target) return {};
  const list = dedupeEventIds([target.source_pointer?.event_id, ...(target.derived_events ?? [])])
    .filter((id) => id !== ownEventId);
  return list.length > 0 ? { derived_events: list } : {};
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
): Promise<{ written: WrittenFact[]; updatedIds: string[]; supersededIds: string[] }> {
  const { entityId, trigger } = ctx;
  const diagBase = { entityId, operation: 'librarian' as const, trigger };
  const grounding = deps.promptService.groundingFor('librarian');
  const temporal = new TemporalService(deps.db, deps.options, deps.entryRepo, deps.searchService, deps.embeddingService);
  const rejected = new Set(input.rejected);
  const failed = new Set(input.failed);
  const written: WrittenFact[] = [];
  const updatedIds: string[] = [];
  const supersededIds: string[] = [];
  const now = Date.now();

  await deps.db.withTransactionAsync(async (tx) => {
    let { mode, manifest } = await deps.ontologyService?.getEffectiveState(entityId, tx)
      ?? { mode: 'off' as const, manifest: { node_types: [], edge_types: [] } };
    if (mode === 'emergent' && input.ontologyUpdates && deps.ontologyService) {
      const { manifest: merged, rejected } = await deps.ontologyService.mergeEmergentUpdates(entityId, input.ontologyUpdates, tx);
      manifest = merged;
      for (const reason of rejected) {
        input.diagnostics.push({ ...diagBase, code: 'ontology_update_rejected', detail: { reason } });
      }
    } else if (mode === 'strict' && input.ontologyUpdates) {
      const proposalCount = (Array.isArray(input.ontologyUpdates.node_types) ? input.ontologyUpdates.node_types.length : 0)
        + (Array.isArray(input.ontologyUpdates.edge_types) ? input.ontologyUpdates.edge_types.length : 0);
      for (let i = 0; i < proposalCount; i++) {
        input.diagnostics.push({ ...diagBase, code: 'ontology_update_rejected', detail: { reason: 'mode_strict' } });
      }
    }
    const titleIndex = new Map<string, TitleIndexEntry>();
    for (const f of await deps.entryRepo.findRecentByEntityId(entityId, 100, tx)) {
      titleIndex.set(normalizeTitleKey(f.title), { id: f.id, okf_type: f.okf_type ?? null });
    }
    const pendingEdges: Array<{ sourceId: string; sourceType: string | null; edges: ExtractedFactEdge[] }> = [];

    const insert = async (
      g: GatedCandidate, draft: boolean, validFrom: number,
      overrides?: { title?: string; body?: string },
      inheritFrom?: WikiFact,
    ): Promise<string> => {
      const fact = g.candidate.fact;
      const title = overrides?.title ?? fact.title;
      const body = overrides?.body ?? fact.body;
      const id = generateId('fact_');
      // Model-door receipts (spec §4) plus the type-on-write door (specs/type-on-write
      // §4, §8): never throws in any mode; suppressed at 'off'.
      const { normalized, drops, receipts: doorReceipts, typedByClassifier } = normalizeForWrite(
        deps.ontologyService, fact, manifest, mode, input.typing?.outcomes.get(g), diagBase, id,
      );
      for (const receipt of doorReceipts) input.diagnostics.push(receipt);
      if (typedByClassifier && input.typing) input.typing.counters.typed++;
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
        // §2: only an UPDATE converted to SUPERSEDE inherits (the merged text
        // rests on the target); ADD and plain SUPERSEDE carry no list.
        ...(inheritedDerivedEvents(inheritFrom, pointer?.event_id ?? null)),
        ...g2?.trust,
        ...(draft ? { lifecycle_status: 'draft' as const } : {}),
      };
      await deps.entryRepo.upsert(row, tx);
      await deps.entryRepo.setTemporal(id, entityId, { valid_from: validFrom }, tx);
      // Rule 6 fix (spec §Ops path + §Diagnostics): a fact that landed without
      // its pointer is reported, not swallowed. Candidates the gate rejects or
      // merges never reach insert(), so they emit nothing (merges report at the UPDATE branch).
      if (g.candidate.pointerUnresolved !== null) {
        input.diagnostics.push({
          ...diagBase,
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

    // §3: drop candidates whose source event no longer exists (a host-side
    // delete the engine's locks cannot see). One indexed SELECT per pass.
    const sourceIds = [...new Set(input.gated.map((g) => g.candidate.sourceEventId).filter((x): x is string => x !== null))];
    const presentIds = sourceIds.length > 0 ? await deps.eventRepo.findExistingIds(entityId, sourceIds, tx) : new Set<string>();
    const gatedLive: GatedCandidate[] = [];
    for (const g of input.gated) {
      const ev = g.candidate.sourceEventId;
      if (ev !== null && !presentIds.has(ev)) {
        input.diagnostics.push({ ...diagBase, code: 'source_event_gone', detail: { itemIndex: g.candidate.index, sourceRef: ev } });
        continue;
      }
      gatedLive.push(g);
    }

    for (const g of gatedLive) {
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
          // §2: record the contributing event beside the (unchanged) pointer.
          // An unattributable candidate leaves the list as is and is reported,
          // where this merge used to be silent (rule 6).
          const contributing = g.candidate.sourceEventId;
          if (contributing === null && g.candidate.pointerUnresolved !== null) {
            input.diagnostics.push({
              ...diagBase,
              code: 'source_pointer_unresolved',
              detail: { factId: existing.id, itemIndex: idx, reason: g.candidate.pointerUnresolved },
            });
          }
          const derived = mergeDerivedEvents(existing, contributing);
          await deps.entryRepo.upsert({
            ...existing,
            title: newTitle,
            body: op.body ?? g.candidate.fact.body,
            updated_at: now,
            ...(derived ? { derived_events: derived } : {}),
          }, tx);
          // Keep the pass-local index in step with the row (as insert() does),
          // so later candidates' edges resolve the new title, not the old one.
          titleIndex.delete(normalizeTitleKey(existing.title));
          titleIndex.set(normalizeTitleKey(newTitle), { id: existing.id, okf_type: existing.okf_type ?? null });
          updatedIds.push(existing.id);
          // Rule 12 (type-on-write §9): the old text is gone; the receipt carries ids only.
          input.diagnostics.push({ ...diagBase, code: 'librarian_rewritten', detail: { factId: existing.id } });
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
        const docTarget = op.op === 'UPDATE'
          ? (await deps.entryRepo.findByIds([op.targetId], [entityId], tx))[0]
          : undefined;
        const id = await insert(g, true, supersedeFrom, overrides, docTarget);
        input.diagnostics.push({ ...diagBase, code: 'contradicts_document', detail: { factId: id, itemIndex: idx } });
        continue;
      }
      const inheritFrom = op.op === 'UPDATE'
        ? (await deps.entryRepo.findByIds([op.targetId], [entityId], tx))[0]
        : undefined;
      const newId = await insert(g, false, supersedeFrom, overrides, inheritFrom);
      try {
        const { replacedScheduledEnd } = await temporal.supersedeInTx(tx, entityId, op.targetId, newId, supersedeFrom, now);
        supersededIds.push(op.targetId);
        input.diagnostics.push({ ...diagBase, code: 'librarian_superseded', detail: { factId: op.targetId, replacementId: newId } });
        if (replacedScheduledEnd != null) {
          input.diagnostics.push({
            ...diagBase,
            code: 'supersede_scheduled_end_replaced',
            detail: { factId: op.targetId, priorValidTo: replacedScheduledEnd },
          });
        }
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

  return { written, updatedIds, supersededIds };
}
