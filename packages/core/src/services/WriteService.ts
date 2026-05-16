import type { SQLiteAdapter } from '../types';
import type { WikiOptions, WikiEvent } from '../types';
import { WikiBusyError } from '../types';
import type { EventRepository } from '../repositories/EventRepository';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import type { JobManager } from './JobManager';
import type { MaintenanceService } from './MaintenanceService';
import { generateId } from '../utils/ids';

export class WriteService {
  constructor(
    private db: SQLiteAdapter,
    private options: WikiOptions,
    private eventRepo: EventRepository,
    private metadataRepo: MetadataRepository,
    private jobManager: JobManager,
    private maintenanceService: MaintenanceService,
  ) {}

  async write(entityId: string, event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>): Promise<void> {
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
      summary: event.summary,
      related_entry_id: event.related_entry_id || null,
      created_at: now,
    };

    let shouldRunLibrarian = false;
    let librarianCount = 0;
    let prevMemoryCheckpoint = 0;

    await this.db.withTransactionAsync(async (tx) => {
      await this.eventRepo.add(newEvent, tx);

      const threshold = this.options.config?.autoLibrarianThreshold || 20;

      const [count, cp] = await Promise.all([
        this.eventRepo.count(entityId, tx),
        this.metadataRepo.getCheckpoint(entityId, tx),
      ]);

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
        this.runLibrarianThenMaybeHeal(entityId, librarianCount)
          .catch(console.error)
          .finally(() => {
            this.jobManager.releaseLock('librarian', entityId);
          });
      } catch (e) {
        if (!(e instanceof WikiBusyError)) throw e;
        await this.metadataRepo.updateCheckpoint(entityId, { memory: prevMemoryCheckpoint }, this.db);
      }
    }
  }

  private async runLibrarianThenMaybeHeal(entityId: string, currentEventCount: number): Promise<void> {
    await this.maintenanceService.doRunLibrarian(entityId);

    const autoHealThreshold = this.options.config?.autoHealThreshold || 100;

    const cp = await this.metadataRepo.getCheckpoint(entityId, this.db);
    let healCheckpoint = cp.heal ?? 0;
    if (healCheckpoint > currentEventCount) healCheckpoint = 0;

    const shouldRunHeal = currentEventCount - healCheckpoint >= autoHealThreshold;

    if (shouldRunHeal && this.jobManager.tryAcquireAutoHealLock(entityId)) {
      try {
        await this.maintenanceService.doRunHeal(entityId);
        await this.metadataRepo.updateCheckpoint(entityId, { heal: currentEventCount }, this.db);
      } finally {
        this.jobManager.releaseLock('heal', entityId);
      }
    }
  }
}
