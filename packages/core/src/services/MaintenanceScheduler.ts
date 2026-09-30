import type { SQLiteAdapter, WikiOptions, PendingMaintenance } from '../types';
import { MaintenanceService, MAX_EMBED_ATTEMPTS } from './MaintenanceService';
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
      const healCheckpoint = Math.min(cp.heal ?? 0, eventCount);
      const healDue = eventCount - healCheckpoint >= autoHealThreshold;
      const reembedPending = canEmbed && (await this.entryRepo.countReembedPending(entityId, MAX_EMBED_ATTEMPTS)) > 0;
      if (pendingEvents > 0 || healDue || reembedPending) {
        out.push({ entityId, pendingEvents, pendingTokensEstimate: Math.ceil(chars / 4), healDue, reembedPending });
      }
    }
    return out.sort((x, y) => (y.pendingEvents - x.pendingEvents) || (x.entityId < y.entityId ? -1 : x.entityId > y.entityId ? 1 : 0));
  }
}
