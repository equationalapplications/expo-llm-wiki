import type {
  SQLiteAdapter,
  WikiOptions,
  PendingMaintenance,
  MaintenanceJob,
  LockedMaintenanceJob,
  MaintenanceStopReason,
  EntityMaintenanceReport,
  RunPendingMaintenanceOptions,
  RunPendingMaintenanceResult,
  HealResult,
  OntologyBackfillResult,
} from '../types';
import { WikiBusyError, isWikiSearchUnavailableError } from '../types';
import { MaintenanceService, MAX_EMBED_ATTEMPTS } from './MaintenanceService';
import type { LibrarianResult } from './librarian';
import { UsageMeter } from '../utils/usage';
import { resolveOntologyJobDefaults } from '../utils/config/ontologyJobDefaults';
import { MetadataRepository } from '../repositories/MetadataRepository';
import { EventRepository } from '../repositories/EventRepository';
import { EntryRepository } from '../repositories/EntryRepository';
import { JobManager } from './JobManager';
import type { VectorRemovalService } from './VectorRemovalService';
import type { VectorRemovalRepository } from '../repositories/VectorRemovalRepository';

/**
 * Read-side report for the deferred maintenance mode: which entities have
 * pending work (librarian events behind the watermark, heal backlog, unembedded
 * facts) without running anything. `run` executes the work (PR-C task 4).
 */
export class MaintenanceScheduler {
  constructor(
    private db: SQLiteAdapter,
    private options: WikiOptions,
    private maintenanceService: MaintenanceService,
    private metadataRepo: MetadataRepository,
    private eventRepo: EventRepository,
    private entryRepo: EntryRepository,
    private jobManager: JobManager,
    private vectorRemovalService: VectorRemovalService,
    private vectorRemovalRepo: VectorRemovalRepository,
  ) {}

  /** Batch size for scheduler-driven ontology passes; resolved once (spec §8). */
  private readonly schedulerBatchSize: number =
    resolveOntologyJobDefaults(this.options.config?.ontology).batchSize;

  /**
   * Entities with **any** pending work only, sorted by `pendingEvents` desc
   * then `entityId` asc. Token estimate is ceil(pending summary chars / 4),
   * matching the auto-trigger's estimator (PR-B).
   */
  async getPending(entityIds?: string[]): Promise<PendingMaintenance[]> {
    const ids = entityIds ?? await this.metadataRepo.getDistinctEntityIds();
    const autoHealThreshold = this.options.config?.autoHealThreshold || 100;
    const canEmbed = typeof this.options.llmProvider.embed === 'function';
    const out: PendingMaintenance[] = [];
    const owed = new Map<string, number>();
    if (this.vectorRemovalService.gate() !== 'none' && (await this.vectorRemovalService.ledgerPresent())) {
      const scope = entityIds === undefined ? undefined : new Set(entityIds);
      // Only entities with a row outside backoff: a failing hook must not keep the list non-empty.
      for (const e of await this.vectorRemovalRepo.entitiesWithDuePending(Date.now())) {
        if (scope !== undefined && !scope.has(e)) continue;
        owed.set(e, (await this.vectorRemovalRepo.pendingStats(e)).count);
      }
    }
    const listed = new Set(ids);
    const scan = [...ids, ...[...owed.keys()].filter((e) => !listed.has(e))];
    for (const entityId of scan) {
      const wm = await this.metadataRepo.getLibrarianWatermark(entityId, this.db);
      const pendingEvents = await this.eventRepo.countAfter(entityId, wm);
      const chars = pendingEvents > 0 ? await this.eventRepo.sumSummaryCharsAfter(entityId, wm) : 0;
      const eventCount = await this.eventRepo.count(entityId);
      const cp = await this.metadataRepo.getCheckpoint(entityId, this.db);
      // Same clamp as WriteService.maybeRunHeal: an out-of-range checkpoint
      // (reachable after runPrune deletes events a heal pass already counted)
      // resets to ZERO, not to the event count — both views must agree that
      // the entity is fully unhealed.
      let healCheckpoint = cp.heal ?? 0;
      if (healCheckpoint > eventCount) healCheckpoint = 0;
      const healDue = eventCount - healCheckpoint >= autoHealThreshold;
      const reembedPending = canEmbed && (await this.entryRepo.countReembedPending(entityId, MAX_EMBED_ATTEMPTS)) > 0;
      const owedCount = owed.get(entityId) ?? 0;
      const ontologyBackfillPending = await this.maintenanceService.pendingOntologyBackfill(entityId);
      if (pendingEvents > 0 || healDue || reembedPending || owedCount > 0 || ontologyBackfillPending > 0) {
        out.push({
          entityId, pendingEvents, pendingTokensEstimate: Math.ceil(chars / 4), healDue, reembedPending,
          ...(owedCount > 0 ? { pendingExternalDeletions: owedCount } : {}),
          ...(ontologyBackfillPending > 0 ? { pendingOntologyBackfill: ontologyBackfillPending } : {}),
        });
      }
    }
    return out.sort((x, y) => (y.pendingEvents - x.pendingEvents) || (x.entityId < y.entityId ? -1 : x.entityId > y.entityId ? 1 : 0));
  }

  /**
   * Execute pending maintenance (spec §6.2): fair-share rounds of at most one
   * unit per entity (librarian batch, else heal batch, else reembed), entities
   * ordered by `getPending` (pendingEvents desc, id asc). Holds the same
   * per-entity `JobManager` locks a manual run would; a busy entity is skipped
   * and reported, never thrown. Nothing is still running when this resolves.
   *
   * Stop precedence (spec §10 items 3-6): `deadline` > `budget_exhausted` >
   * `budget_too_small` > `complete`. `budget_too_small` means a job's smallest
   * unit needs more than the WHOLE budget — that job is skipped this run and
   * the run continues; `budget_exhausted` means a unit needs more than what
   * REMAINS — the run stops. The token budget meters `generateText` calls
   * only; embeddings are never metered.
   */
  async run(opts: RunPendingMaintenanceOptions = {}): Promise<RunPendingMaintenanceResult> {
    if (
      opts.deadlineMs !== undefined &&
      (typeof opts.deadlineMs !== 'number' || !Number.isFinite(opts.deadlineMs) || opts.deadlineMs < 0)
    ) {
      throw new TypeError('deadlineMs must be a finite number >= 0');
    }
    const meter = new UsageMeter(opts.tokenBudget);
    const budget = opts.tokenBudget;
    const deadline = opts.deadlineMs !== undefined ? Date.now() + Math.max(0, opts.deadlineMs) : Infinity;
    const jobs = new Set<MaintenanceJob>(opts.jobs ?? ['librarian', 'heal', 'reembed', 'externalDeletions', 'ontologyBackfill']);
    const externalDeletions = await this.runExternalDeletions(opts.entityIds, jobs.has('externalDeletions'), deadline);
    // Removal-only entities are reported by externalDeletions, not as per-entity maintenance.
    const pending = (await this.getPending(opts.entityIds)).filter((p) => p.pendingEvents > 0 || p.healDue || p.reembedPending || (p.pendingOntologyBackfill ?? 0) > 0);

    type State = { p: PendingMaintenance; report: EntityMaintenanceReport; librarian: boolean; heal: boolean; reembed: boolean; ontology: boolean };
    const states: State[] = pending.map((p) => ({
      p,
      report: { entityId: p.entityId, librarianPasses: 0, factsWritten: 0, healPasses: 0, reembedded: false, ontologyBackfillPasses: 0, typed: 0 },
      librarian: jobs.has('librarian') && p.pendingEvents > 0,
      heal: jobs.has('heal') && p.healDue,
      reembed: jobs.has('reembed') && p.reembedPending,
      ontology: jobs.has('ontologyBackfill') && (p.pendingOntologyBackfill ?? 0) > 0,
    }));

    let stopped: MaintenanceStopReason = { reason: 'complete' };
    let tooSmall: MaintenanceStopReason | null = null;
    const classify = (job: 'librarian' | 'heal' | 'ontologyBackfill', entityId: string, requiredEstimate: number): 'too_small' | 'exhausted' => {
      if (budget !== undefined && requiredEstimate > budget) {
        tooSmall ??= { reason: 'budget_too_small', job, entityId, requiredEstimate };
        return 'too_small';
      }
      return 'exhausted';
    };
    // A unit that ends with the meter exhausted made real awaited LLM calls,
    // so the deadline may have lapsed mid-unit too. Precedence is deadline
    // first (spec §10): the caller must be told to retry as-is, not to raise
    // the budget. Re-checked here because the between-units deadline check
    // only runs before a unit starts, never after one ends.
    const exhaustedStop = (): MaintenanceStopReason =>
      Date.now() >= deadline ? { reason: 'deadline' } : { reason: 'budget_exhausted' };
    const markBusy = (st: State, job: LockedMaintenanceJob) => { (st.report.busy ??= []).push(job); };
    const markSearchUnavailable = (st: State, job: LockedMaintenanceJob) => { (st.report.searchUnavailable ??= []).push(job); };

    // Open job flags across all entities. Flags only ever clear, so a round
    // that clears one (a skip: busy, outage, too small, nothing processed)
    // counts as progress — it must re-run so the entity reaches its later
    // jobs — and the loop still terminates.
    const openJobs = () => states.reduce((n, s) => n + +s.librarian + +s.heal + +s.reembed + +s.ontology, 0);

    rounds: for (;;) {
      let progressed = false;
      const openAtStart = openJobs();
      for (const st of states) {
        if (!st.librarian && !st.heal && !st.reembed && !st.ontology) continue;
        if (Date.now() >= deadline) { stopped = { reason: 'deadline' }; break rounds; }
        const entityId = st.p.entityId;

        if (st.librarian) {
          if (this.jobManager.isBlocked('librarian', entityId)) { st.librarian = false; markBusy(st, 'librarian'); continue; }
          this.jobManager.acquireLock('librarian', entityId);
          let r: LibrarianResult;
          try {
            r = await this.maintenanceService.runLibrarianPass({ entityId, trigger: 'call', meter });
          } catch (err) {
            // Keyword outage: this entity's pass aborted with its watermark kept.
            // Skip it for this run rather than failing every other entity's work.
            if (!isWikiSearchUnavailableError(err)) throw err;
            st.librarian = false;
            markSearchUnavailable(st, 'librarian');
            continue;
          } finally {
            this.jobManager.releaseLock('librarian', entityId);
          }
          if (r.budgetStop) {
            if (classify('librarian', entityId, r.budgetStop.requiredEstimate) === 'exhausted') { stopped = exhaustedStop(); break rounds; }
            st.librarian = false;
            continue;
          }
          if (!r.processedThrough) { st.librarian = false; continue; }
          st.report.librarianPasses++;
          st.report.factsWritten += r.factsWritten;
          if (r.typing) st.report.typedOnWrite = (st.report.typedOnWrite ?? 0) + r.typing.typed;
          progressed = true;
          // Budget exhausted during write-time typing: the pass wrote its facts and
          // recorded them above; the run stops as exhausted rather than 'complete'.
          if ((r.typing?.unattempted ?? 0) > 0) { stopped = exhaustedStop(); break rounds; }
          const wm = await this.metadataRepo.getLibrarianWatermark(entityId, this.db);
          if ((await this.eventRepo.countAfter(entityId, wm)) === 0) st.librarian = false;
          continue;
        }

        if (st.heal) {
          if (this.jobManager.isBlocked('heal', entityId)) { st.heal = false; markBusy(st, 'heal'); continue; }
          this.jobManager.acquireLock('heal', entityId);
          let h: HealResult;
          try {
            h = await this.maintenanceService.doRunHeal(entityId, { trigger: 'call', meter });
            // Write the checkpoint while the heal lock still blocks prune. A
            // prune between the count read and the write would leave heal
            // above the event count, which reads as 0 and starts a full
            // re-heal (spec ops-auto-first-batch §4).
            if (h.remaining === 0 && !(h.budgetStop && h.scanned === 0)) {
              await this.metadataRepo.updateCheckpoint(entityId, { heal: await this.eventRepo.count(entityId) }, this.db);
            }
          } finally {
            this.jobManager.releaseLock('heal', entityId);
          }
          // Defense against future doRunHeal changes: scanned === 0 means the
          // pass bailed before any LLM call, so budgetStop cannot arise there
          // today — but if it ever did, classify it instead of mislabeling a
          // never-started job as exhausted.
          if (h.budgetStop && h.scanned === 0) {
            if (classify('heal', entityId, h.budgetStop.requiredEstimate) === 'exhausted') { stopped = exhaustedStop(); break rounds; }
            st.heal = false;
            continue;
          }
          // Nothing scanned yet candidates remain (e.g. a keyword outage skipped
          // the LLM pass): another round cannot progress, so stop healing this
          // entity for this run instead of looping forever.
          if (h.scanned === 0 && h.remaining > 0) {
            st.heal = false;
            if (h.searchUnavailable) markSearchUnavailable(st, 'heal');
            continue;
          }
          st.report.healPasses++;
          progressed = true;
          if (h.remaining === 0) st.heal = false;
          if (h.budgetStop) { stopped = exhaustedStop(); break rounds; }
          continue;
        }

        if (st.reembed) {
          st.reembed = false;
          try {
            await this.maintenanceService.runReembed(entityId);
            st.report.reembedded = true;
            progressed = true;
          } catch (err) {
            if (err instanceof WikiBusyError) markBusy(st, 'reembed');
            else throw err;
          }
        }

        if (st.ontology) {
          // The between-units deadline check at the top of the entity
          // iteration ran BEFORE librarian/heal/reembed; an awaited unit can
          // lapse the deadline, and the ontology pass must not start against
          // an expired one. Spec §10 precedence: stop with 'deadline'; the
          // caller retries as-is (nothing was spent here).
          if (Date.now() >= deadline) {
            stopped = { reason: 'deadline' };
            break rounds;
          }
          st.ontology = false;
          if (this.jobManager.isBlocked('ontologyBackfill', entityId)) {
            // Same handling as a busy librarian/heal: a held pass is a real
            // scheduler outcome (the lock is owned by another job right now),
            // so report it and tell the host via `ontology_backfill_held`.
            markBusy(st, 'ontologyBackfill');
            this.maintenanceService.noteOntologyBackfillHeld(entityId);
            progressed = true;
            continue;
          }
          this.jobManager.acquireLock('ontologyBackfill', entityId);
          let r: OntologyBackfillResult;
          try {
            r = await this.maintenanceService.doRunOntologyBackfill(entityId, {
              meter,
              batchSize: this.schedulerBatchSize,
            });
          } finally {
            this.jobManager.releaseLock('ontologyBackfill', entityId);
          }
          st.report.ontologyBackfillPasses++;
          st.report.typed += r.typed;
          progressed = true;
          if (r.budgetStop) {
            if (classify('ontologyBackfill', entityId, r.budgetStop.requiredEstimate) === 'exhausted') {
              // Route through exhaustedStop() like the librarian/heal
              // branches: budget exhaustion is only reported when the budget
              // actually ran out — a deadline that lapsed inside the awaited
              // pass outranks it (spec §10 precedence).
              stopped = exhaustedStop();
              break rounds;
            }
            continue;
          }
          if (r.remaining === 0 || r.typed === 0) {
            // Converged, or this pass typed nothing it can ever type (every
            // candidate failed validation) — a further pass would burn rounds
            // without progress, so stop driving the job for this entity.
            continue;
          }
          // More eligible facts remain and this pass made typing progress; the
          // job stays closed for this run — leftover work waits for the next
          // run() (host convergence signal: getPendingMaintenance).
        }
      }
      if (!progressed && openJobs() === openAtStart) break;
    }

    if (stopped.reason === 'complete' && tooSmall) stopped = tooSmall;
    return {
      perEntity: states.map((s) => s.report),
      tokensUsed: meter.used,
      estimated: meter.estimated,
      remaining: budget === undefined ? null : meter.remaining,
      stoppedReason: stopped,
      externalDeletions,
    };
  }

  /**
   * Runs first and outside the token budget: delivers owed vector-index
   * removals per entity (wiped entities included), without backoff. Pending is
   * reported even when the job is not listed or no hook is configured.
   */
  private async runExternalDeletions(
    entityIds: string[] | undefined,
    enabled: boolean,
    deadline: number,
  ): Promise<{ confirmed: number; pending: number }> {
    if (!(await this.vectorRemovalService.ledgerPresent())) return { confirmed: 0, pending: 0 };
    const all = await this.vectorRemovalRepo.entitiesWithPending();
    const scope = entityIds === undefined ? undefined : new Set(entityIds);
    const entities = scope === undefined ? all : all.filter((e) => scope.has(e));
    let confirmed = 0;
    let pending = 0;
    // Entities a drain reported on; the drain already counted their pending rows.
    const counted = new Set<string>();
    if (enabled) {
      for (const e of entities) {
        if (Date.now() >= deadline) break;
        const r = await this.vectorRemovalService.drain(
          { entityId: e },
          { trigger: 'call', ...(deadline === Infinity ? {} : { deadlineAt: deadline }) },
        );
        confirmed += r.confirmed;
        if (!r.transient) {
          pending += r.pending;
          counted.add(e);
        }
        if (r.timedOut) break;
      }
    }
    for (const e of entities) {
      if (!counted.has(e)) pending += (await this.vectorRemovalRepo.pendingStats(e)).count;
    }
    return { confirmed, pending };
  }
}
