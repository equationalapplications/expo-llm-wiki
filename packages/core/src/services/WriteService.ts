import type { SQLiteAdapter } from '../types';
import type { WikiOptions, WikiEvent } from '../types';
import { WikiBusyError } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { EventRepository } from '../repositories/EventRepository';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import type { JobManager } from './JobManager';
import type { MaintenanceService } from './MaintenanceService';
import { generateId } from '../utils/ids';
import { clip } from '../utils/pure';

export class WriteService {
  constructor(
    private db: SQLiteAdapter,
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private eventRepo: EventRepository,
    private metadataRepo: MetadataRepository,
    private jobManager: JobManager,
    private maintenanceService: MaintenanceService,
  ) {}

  async write(entityId: string, event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>): Promise<void> {
    if (typeof entityId !== 'string' || entityId.length === 0 || entityId.length > 200 || entityId.includes('\0')) {
      throw new TypeError(
        `Invalid entityId: must be a non-empty string at most 200 chars with no null bytes; got ${JSON.stringify(entityId)}.`,
      );
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('Invalid event: must be a non-null object.');
    }
    if (typeof event.summary !== 'string') {
      throw new TypeError('Invalid event.summary: must be a string.');
    }
    const summary = clip(event.summary, 4000);

    let relatedEntryId: string | null = null;
    const rawRelatedEntryId = event.related_entry_id;
    if (rawRelatedEntryId != null && rawRelatedEntryId !== '') {
      if (
        typeof rawRelatedEntryId !== 'string' ||
        rawRelatedEntryId.length > 200 ||
        rawRelatedEntryId.includes('\0')
      ) {
        relatedEntryId = null;
      } else {
        const existing = await this.entryRepo.findByIds([rawRelatedEntryId], [entityId]);
        relatedEntryId = existing.length > 0 ? rawRelatedEntryId : null;
      }
    }

    const id = generateId('evt_');
    const now = Date.now();

    let eventType = event.event_type;
    if (!['observation', 'decision', 'action', 'outcome'].includes(eventType)) {
      eventType = 'observation';
    }

    const newEvent: WikiEvent = {
      id,
      entity_id: entityId,
      event_type: eventType,
      summary,
      related_entry_id: relatedEntryId,
      created_at: now,
    };

    let shouldRunLibrarian = false;
    let librarianCount = 0;
    let prevMemoryCheckpoint = 0;
    let eventCount = 0;

    await this.db.withTransactionAsync(async (tx) => {
      await this.eventRepo.add(newEvent, tx);

      const threshold = this.options.config?.autoLibrarianThreshold || 20;

      const [count, cp] = await Promise.all([
        this.eventRepo.count(entityId, tx),
        this.metadataRepo.getCheckpoint(entityId, tx),
      ]);
      eventCount = count;

      let memoryCheckpoint = cp.memory ?? 0;
      if (memoryCheckpoint > count) memoryCheckpoint = 0;

      if (count - memoryCheckpoint >= threshold) {
        if (!this.jobManager.isBlocked('librarian', entityId)) {
          shouldRunLibrarian = true;
          librarianCount = count;
          prevMemoryCheckpoint = memoryCheckpoint;
          await this.metadataRepo.updateCheckpoint(entityId, { memory: count }, tx);
        }
      }
    });

    if (shouldRunLibrarian) {
      try {
        this.jobManager.acquireLock('librarian', entityId);
        this.runLibrarianThenMaybeHeal(entityId, librarianCount, prevMemoryCheckpoint)
          .catch(console.error)
          .finally(() => {
            this.jobManager.releaseLock('librarian', entityId);
          });
      } catch (e) {
        if (!(e instanceof WikiBusyError)) throw e;
        await this.metadataRepo.updateCheckpoint(entityId, { memory: prevMemoryCheckpoint }, this.db);
      }
    } else if (!this.jobManager.isBlocked('librarian', entityId)) {
      // Auto-heal is evaluated on every write, not only on writes that also
      // trigger a librarian pass. doRunHeal is bounded to HEAL_BATCH_SIZE
      // candidates (#67) and a non-converged pass deliberately holds its
      // checkpoint back, so the gap stays above autoHealThreshold; gating the
      // retry on a librarian pass would stall a partial sweep until the next
      // librarian threshold crossing (another autoLibrarianThreshold events),
      // or forever if no further librarian pass runs.
      //
      // heal and librarian can overlap (deliberate mutex split in
      // JobManager.acquireLock). This check only reduces redundant passes — a
      // librarian pass already calls maybeRunHeal when it finishes, so losing
      // the race costs a duplicate pass, not correctness. Correctness rests on
      // heal's dedupe read being inside its transaction (#69).
      // tryAcquireAutoHealLock inside maybeRunHeal prevents a burst of writes
      // from stacking passes.
      this.maybeRunHeal(entityId, eventCount).catch(console.error);
    }
  }

  private async runLibrarianThenMaybeHeal(entityId: string, currentEventCount: number, prevCheckpoint: number): Promise<void> {
    try {
      await this.maintenanceService.doRunLibrarian(entityId);
      // Only advance checkpoint after successful librarian run
      await this.metadataRepo.updateCheckpoint(entityId, { memory: currentEventCount }, this.db);
    } catch (e) {
      // Rollback checkpoint on failure so events can be retried
      await this.metadataRepo.updateCheckpoint(entityId, { memory: prevCheckpoint }, this.db);
      throw e;
    }

    await this.maybeRunHeal(entityId, currentEventCount);
  }

  /**
   * Run one bounded auto-heal pass if the heal checkpoint has fallen
   * `autoHealThreshold` events behind. Called after every write (see
   * {@link write}) so a partial pass retries on the next write.
   */
  private async maybeRunHeal(entityId: string, currentEventCount: number): Promise<void> {
    const autoHealThreshold = this.options.config?.autoHealThreshold || 100;

    const cp = await this.metadataRepo.getCheckpoint(entityId, this.db);
    let healCheckpoint = cp.heal ?? 0;
    if (healCheckpoint > currentEventCount) healCheckpoint = 0;

    const shouldRunHeal = currentEventCount - healCheckpoint >= autoHealThreshold;

    if (shouldRunHeal && this.jobManager.tryAcquireAutoHealLock(entityId)) {
      try {
        const result = await this.maintenanceService.doRunHeal(entityId);
        // Advance only when the pass converged. doRunHeal is bounded to
        // HEAL_BATCH_SIZE candidates (#67); advancing unconditionally would cap
        // auto-heal at one batch per autoHealThreshold events and leave most of
        // a large corpus never auto-healed. Held back, the checkpoint gap stays
        // above the threshold, so the next write runs another bounded pass —
        // cost per write stays bounded while the corpus still converges.
        //
        // Sits inside the try, after the call: on a throw the checkpoint is not
        // advanced, exactly as before this change.
        if (result.remaining === 0) {
          await this.metadataRepo.updateCheckpoint(entityId, { heal: currentEventCount }, this.db);
        }
      } finally {
        this.jobManager.releaseLock('heal', entityId);
      }
    }
  }
}
