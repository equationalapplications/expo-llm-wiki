import type { SQLiteAdapter } from './types';
import type { WikiOutboxEvent } from './outbox/types';
import { setupDatabase } from './db/schema';
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from './db/migrations';
import {
  WikiOptions,
  MemoryBundle,
  MemoryDump,
  WikiEvent,
  EntityStatus,
  ReadOptions,
} from './types';
import { EntryRepository } from './repositories/EntryRepository';
import { OutboxRepository } from './repositories/OutboxRepository';
import { TaskRepository } from './repositories/TaskRepository';
import { EventRepository } from './repositories/EventRepository';
import { MetadataRepository } from './repositories/MetadataRepository';
import { SearchService } from './services/SearchService';
import { JobManager } from './services/JobManager';
import { normalizeSourceRef, normalizeSourceHash, validateFact, validateTask, clip, chunkText } from './utils/pure';
import { IngestionService } from './services/IngestionService';
import { MaintenanceService } from './services/MaintenanceService';
import { ImportExportService } from './services/ImportExportService';
import { EmbeddingService } from './services/EmbeddingService';
import { RetrievalService } from './services/RetrievalService';
import { WriteService } from './services/WriteService';
import { PromptService } from './services/PromptService';

export { WikiBusyError, PrunePartialFailureError, HOOK_TIMEOUT_MARKER } from './types';

/** Typed escape hatch for tests — not part of the supported consumer API. */
export interface WikiMemoryTestAccess {
  embeddingService: EmbeddingService;
  importExportService: ImportExportService;
  ingestionService: IngestionService;
  maintenanceService: MaintenanceService;
  retrievalService: RetrievalService;
  searchService: SearchService;
  writeService: WriteService;
  promptService: PromptService;
  entryRepo: EntryRepository;
  metadataRepo: MetadataRepository;
  jobManager: JobManager;
}

export class WikiMemory {
  /** Emits `__testAccess` console warning at most once per instance when NODE_ENV ≠ "test". */
  #testAccessNonTestEnvWarned = false;

  private db: SQLiteAdapter;
  private prefix: string;
  private options: WikiOptions;
  private entryRepo: EntryRepository;
  private outboxRepo: OutboxRepository;
  private taskRepo: TaskRepository;
  private eventRepo: EventRepository;
  private metadataRepo: MetadataRepository;
  private embeddingService: EmbeddingService;
  private searchService: SearchService;
  private jobManager: JobManager;
  private ingestionService: IngestionService;
  private maintenanceService: MaintenanceService;
  private importExportService: ImportExportService;
  private retrievalService: RetrievalService;
  private writeService: WriteService;
  private promptService: PromptService;

  constructor(db: SQLiteAdapter, options: WikiOptions) {
    this.db = db;
    this.options = options;
    this.prefix = options.config?.tablePrefix || 'llm_wiki_';
    this.outboxRepo = new OutboxRepository(db, this.prefix, !!options.config?.enableOutbox);
    this.entryRepo = new EntryRepository(db, this.prefix, this.outboxRepo);
    this.taskRepo = new TaskRepository(db, this.prefix, this.outboxRepo);
    this.eventRepo = new EventRepository(db, this.prefix);
    this.metadataRepo = new MetadataRepository(db, this.prefix);
    this.embeddingService = new EmbeddingService(this.db, this.options, this.entryRepo, this.metadataRepo);
    this.searchService = new SearchService(this.entryRepo);
    this.jobManager = new JobManager(this.prefix);
    this.promptService = new PromptService(options.config?.prompts);
    this.ingestionService = new IngestionService(
      this.db,
      this.prefix,
      this.options,
      this.entryRepo,
      this.searchService,
      this.jobManager,
      this.embeddingService,
      this.promptService,
    );
    this.maintenanceService = new MaintenanceService(
      this.db,
      this.prefix,
      this.options,
      this.entryRepo,
      this.taskRepo,
      this.eventRepo,
      this.metadataRepo,
      this.searchService,
      this.jobManager,
      this.embeddingService,
      this.promptService,
    );
    this.importExportService = new ImportExportService(
      this.db,
      this.entryRepo,
      this.taskRepo,
      this.eventRepo,
      this.metadataRepo,
      this.searchService,
      this.jobManager,
      this.embeddingService,
    );
    this.retrievalService = new RetrievalService(
      this.options,
      this.entryRepo,
      this.taskRepo,
      this.eventRepo,
      this.metadataRepo,
      this.searchService,
    );
    this.writeService = new WriteService(
      this.db,
      this.options,
      this.eventRepo,
      this.metadataRepo,
      this.jobManager,
      this.maintenanceService,
    );
  }

  /**
   * Explicit escape hatch for test suites: typed access to composed services for mocks/spies.
   * If `NODE_ENV` is not `"test"`, emits a single `console.warn` per instance (skipped when `process` is undefined).
   */
  get __testAccess(): WikiMemoryTestAccess {
    const processEnv = typeof globalThis !== 'undefined'
      ? (globalThis as any).process?.env
      : undefined;

    if (
      processEnv !== undefined &&
      processEnv.NODE_ENV !== 'test' &&
      !this.#testAccessNonTestEnvWarned
    ) {
      this.#testAccessNonTestEnvWarned = true;
      console.warn('Warning: WikiMemory.__testAccess is intended for tests (NODE_ENV !== "test").');
    }
    return {
      embeddingService: this.embeddingService,
      importExportService: this.importExportService,
      ingestionService: this.ingestionService,
      maintenanceService: this.maintenanceService,
      retrievalService: this.retrievalService,
      searchService: this.searchService,
      writeService: this.writeService,
      promptService: this.promptService,
      entryRepo: this.entryRepo,
      metadataRepo: this.metadataRepo,
      jobManager: this.jobManager,
    };
  }

  async setup() {
    const entriesExistedBeforeSetup = await this.metadataRepo.tableExists(`${this.prefix}entries`);

    await setupDatabase(this.db, this.prefix);

    let currentVersion: number;

    if (!entriesExistedBeforeSetup) {
      await this.metadataRepo.setMeta('schema_version', String(CURRENT_SCHEMA_VERSION), this.db);
      currentVersion = CURRENT_SCHEMA_VERSION;
    } else {
      const schemaVersionValue = await this.metadataRepo.getMeta('schema_version');

      if (schemaVersionValue) {
        currentVersion = parseInt(schemaVersionValue, 10);
        if (!Number.isFinite(currentVersion)) currentVersion = 0;
      } else {
        const ftsDdl = await this.metadataRepo.getTableDdl(`${this.prefix}entries_fts`);
        const hasPorter = /tokenize\s*=\s*['"]porter\s+unicode61['"]/i.test(ftsDdl ?? '');
        currentVersion = hasPorter ? 1 : 0;
      }
    }

    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        await migration.run(this.db, this.prefix);
        await this.metadataRepo.setMeta('schema_version', String(migration.version), this.db);
        currentVersion = migration.version;
      }
    }

    if (entriesExistedBeforeSetup) {
      const schemaVersionCheck = await this.metadataRepo.getMeta('schema_version');
      if (!schemaVersionCheck) {
        await this.metadataRepo.setMeta('schema_version', String(currentVersion), this.db);
      }
    }

    if (entriesExistedBeforeSetup) {
      await this.importExportService.assertNoLegacySourceTypes();
    }

    const rows = await this.entryRepo.findRowsForSourceRefMigration();
    await this.db.withTransactionAsync(async (tx) => {
      for (const row of rows) {
        const normalized = normalizeSourceRef(row.source_ref);
        if (normalized !== row.source_ref) {
          await this.entryRepo.updateSourceRefByRowid(row.rowid, normalized, tx);
        }
      }
    });

    await this.searchService.sync();
  }

  async hasChanged(entityId: string, sourceRef: string, sourceHash: string): Promise<boolean> {
    const normalizedRef = normalizeSourceRef(sourceRef);
    if (!normalizedRef) {
      throw new Error(`Invalid sourceRef: "${sourceRef}"`);
    }
    const normalizedHash = normalizeSourceHash(sourceHash);
    if (!normalizedHash) {
      throw new Error(`Invalid sourceHash: must be a 64-character hex string (normalized to lowercase)`);
    }
    const storedHash = await this.entryRepo.findLatestSourceHash(entityId, normalizedRef);
    if (storedHash === null) return true;
    const normalizedStoredHash = normalizeSourceHash(storedHash);
    return normalizedStoredHash !== normalizedHash;
  }

  async runPrune(
    entityId: string,
    options?: {
      retainSoftDeletedFor?: number | null;
      retainEventsFor?: number | null;
      vacuum?: boolean;
    },
  ): Promise<{ entries: number; tasks: number; events: number }> {
    return this.maintenanceService.runPrune(entityId, options);
  }

  async read(entityId: string | string[], query: string, options?: ReadOptions): Promise<MemoryBundle> {
    return this.retrievalService.read(entityId, query, options);
  }

  async getMemoryBundle(entityId: string): Promise<MemoryBundle> {
    return this.importExportService.getFullBundle(entityId, { maxEvents: 10 });
  }

  async write(entityId: string, event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>): Promise<void> {
    return this.writeService.write(entityId, event);
  }

  /**
   * @param options.promptOverride - Applies only to this manual call. Does NOT affect
   * WriteService-triggered auto-runs. For persistent prompt customization across auto-runs,
   * set `options.config.prompts.librarianSystemPrompt` at WikiMemory construction time.
   */
  async runLibrarian(entityId: string, options?: { promptOverride?: string }): Promise<void> {
    return this.maintenanceService.runLibrarian(entityId, options);
  }

  /**
   * @param options.promptOverride - Applies only to this manual call. Does NOT affect
   * WriteService-triggered auto-runs. For persistent prompt customization across auto-runs,
   * set `options.config.prompts.healSystemPrompt` at WikiMemory construction time.
   */
  async runHeal(entityId: string, options?: { promptOverride?: string }): Promise<void> {
    return this.maintenanceService.runHeal(entityId, options);
  }

  async runReembed(entityId?: string, opts?: { force?: boolean; skipExisting?: boolean }): Promise<{ embedded: number; skipped: number; failed: number }> {
    return this.maintenanceService.runReembed(entityId, opts);
  }

  getEntityStatus(entityId: string): EntityStatus {
    return this.jobManager.getEntityStatus(entityId);
  }

  subscribeEntityStatus(
    entityId: string,
    callback: (status: EntityStatus) => void,
  ): () => void {
    return this.jobManager.subscribeEntityStatus(entityId, callback);
  }

  clearVectorCache(): void {
    this.searchService.evictCache();
  }

  async exportDump(entityIds?: string[]): Promise<MemoryDump> {
    return this.importExportService.exportDump(entityIds);
  }

  async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
    return this.importExportService.importDump(dump, opts);
  }

  async forget(entityId: string, params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean }): Promise<{ deleted: { entries: number; tasks: number } }> {
    return this.maintenanceService.forget(entityId, params);
  }

  /**
   * @param params.promptOverride - Overrides the system prompt for this ingest call only.
   * For persistent customization, set `options.config.prompts.ingestSystemPrompt` at
   * WikiMemory construction time.
   */
  async ingestDocument(
    entityId: string,
    params: {
      sourceRef: string;
      sourceHash: string;
      documentChunk: string;
      maxChunkLength?: number;
      chunkOverlap?: number;
      chunkConcurrency?: number;
      promptOverride?: string;
    }
  ): Promise<{ truncated: boolean; chunks: number }> {
    return this.ingestionService.ingestDocument(entityId, params);
  }

  /**
   * Returns up to `limit` unprocessed outbox events, oldest first.
   * Works regardless of enableOutbox value — allows draining after disabling.
   */
  async getUnprocessedOutboxEvents(limit = 100): Promise<WikiOutboxEvent[]> {
    const rows = await this.outboxRepo.fetchPending(limit);
    return rows.map(row => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // corrupted row — surface null payload rather than poisoning the batch
      }
      return { ...row, payload } as WikiOutboxEvent;
    });
  }

  /**
   * Deletes the given event IDs from the outbox table.
   * Call after successfully committing events to the external system.
   */
  async markOutboxEventsProcessed(eventIds: string[]): Promise<void> {
    await this.outboxRepo.acknowledge(eventIds);
  }
}

export const __testables = { validateFact, validateTask, clip, chunkText };
