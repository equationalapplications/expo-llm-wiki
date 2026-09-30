import type {
  SQLiteAdapter,
  WikiOptions,
  PendingMaintenance,
  MaintenanceJob,
  MaintenanceStopReason,
  EntityMaintenanceReport,
  RunPendingMaintenanceOptions,
  RunPendingMaintenanceResult,
  HealResult,
} from '../types';
import { WikiBusyError } from '../types';
import { MaintenanceService, MAX_EMBED_ATTEMPTS } from './MaintenanceService';
import type { LibrarianResult } from './librarian';
import { UsageMeter } from '../utils/usage';
import { MetadataRepository } from '../repositories/MetadataRepository';
import { EventRepository } from '../repositories/EventRepository';
import { EntryRepository } from '../repositories/EntryRepository';
import { JobManager } from './JobManager';

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
  ) {}

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
    for (const entityId of ids) {
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
      if (pendingEvents > 0 || healDue || reembedPending) {
        out.push({ entityId, pendingEvents, pendingTokensEstimate: Math.ceil(chars / 4), healDue, reembedPending });
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
    const jobs = new Set<MaintenanceJob>(opts.jobs ?? ['librarian', 'heal', 'reembed']);
    const pending = await this.getPending(opts.entityIds);

    type State = { p: PendingMaintenance; report: EntityMaintenanceReport; librarian: boolean; heal: boolean; reembed: boolean };
    const states: State[] = pending.map((p) => ({
      p,
      report: { entityId: p.entityId, librarianPasses: 0, factsWritten: 0, healPasses: 0, reembedded: false },
      librarian: jobs.has('librarian') && p.pendingEvents > 0,
      heal: jobs.has('heal') && p.healDue,
      reembed: jobs.has('reembed') && p.reembedPending,
    }));

    let stopped: MaintenanceStopReason = { reason: 'complete' };
    let tooSmall: MaintenanceStopReason | null = null;
    const classify = (job: 'librarian' | 'heal', entityId: string, requiredEstimate: number): 'too_small' | 'exhausted' => {
      if (budget !== undefined && requiredEstimate > budget) {
        tooSmall ??= { reason: 'budget_too_small', job, entityId, requiredEstimate };
        return 'too_small';
      }
      return 'exhausted';
    };
    const markBusy = (st: State, job: MaintenanceJob) => { (st.report.busy ??= []).push(job); };

    rounds: for (;;) {
      let progressed = false;
      for (const st of states) {
        if (!st.librarian && !st.heal && !st.reembed) continue;
        if (Date.now() >= deadline) { stopped = { reason: 'deadline' }; break rounds; }
        const entityId = st.p.entityId;

        if (st.librarian) {
          if (this.jobManager.isBlocked('librarian', entityId)) { st.librarian = false; markBusy(st, 'librarian'); continue; }
          this.jobManager.acquireLock('librarian', entityId);
          let r: LibrarianResult;
          try {
            r = await this.maintenanceService.runLibrarianPass({ entityId, trigger: 'call', meter });
          } finally {
            this.jobManager.releaseLock('librarian', entityId);
          }
          if (r.budgetStop) {
            if (classify('librarian', entityId, r.budgetStop.requiredEstimate) === 'exhausted') { stopped = { reason: 'budget_exhausted' }; break rounds; }
            st.librarian = false;
            continue;
          }
          if (!r.processedThrough) { st.librarian = false; continue; }
          st.report.librarianPasses++;
          st.report.factsWritten += r.factsWritten;
          progressed = true;
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
          } finally {
            this.jobManager.releaseLock('heal', entityId);
          }
          if (h.budgetStop && h.scanned === 0) {
            if (classify('heal', entityId, h.budgetStop.requiredEstimate) === 'exhausted') { stopped = { reason: 'budget_exhausted' }; break rounds; }
            st.heal = false;
            continue;
          }
          st.report.healPasses++;
          progressed = true;
          if (h.remaining === 0) {
            st.heal = false;
            await this.metadataRepo.updateCheckpoint(entityId, { heal: await this.eventRepo.count(entityId) }, this.db);
          }
          if (h.budgetStop) { stopped = { reason: 'budget_exhausted' }; break rounds; }
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
      }
      if (!progressed) break;
    }

    if (stopped.reason === 'complete' && tooSmall) stopped = tooSmall;
    return {
      perEntity: states.map((s) => s.report),
      tokensUsed: meter.used,
      estimated: meter.estimated,
      remaining: budget === undefined ? null : meter.remaining,
      stoppedReason: stopped,
    };
  }
}
