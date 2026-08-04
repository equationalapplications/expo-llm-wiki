import type { SQLiteAdapter } from './types';
import type { WikiOutboxEvent } from './outbox/types';
import { setupDatabase } from './db/schema';
import { withSerializedTransactions } from './db/serializedAdapter';
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
import { EdgeRepository } from './repositories/EdgeRepository';
import { MetadataRepository, entitySummaryMetaKey } from './repositories/MetadataRepository';
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
import { OntologyService } from './services/OntologyService';
import { GraphTraversalService } from './services/GraphTraversalService';
import type { OntologyManifest, OntologyMode, GraphTraversalOptions, GraphNeighborhood, OntologyBackfillResult, HealResult } from './types';

export { WikiBusyError, WikiTransactionError, PrunePartialFailureError, HOOK_TIMEOUT_MARKER } from './types';

const TABLE_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,30}_$/;

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
  graphTraversalService: GraphTraversalService;
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
  private edgeRepo: EdgeRepository;
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
  private ontologyService: OntologyService;
  private graphTraversalService: GraphTraversalService;

  constructor(db: SQLiteAdapter, options: WikiOptions) {
    // Serialize transactions on the single shared connection before the adapter
    // reaches any repository or service. See docs/superpowers/specs/2026-07-09-transaction-serialization-spec.md.
    this.db = withSerializedTransactions(db);
    this.options = options;
    this.prefix = options.config?.tablePrefix ?? 'llm_wiki_';
    if (!TABLE_PREFIX_PATTERN.test(this.prefix)) {
      throw new Error(
        `Invalid tablePrefix: ${JSON.stringify(this.prefix)}. ` +
          `Must match ${TABLE_PREFIX_PATTERN} (letter, then alphanumeric/underscore, ending in "_", max 32 chars total).`,
      );
    }
    this.outboxRepo = new OutboxRepository(this.db, this.prefix, !!options.config?.enableOutbox);
    this.entryRepo = new EntryRepository(this.db, this.prefix, this.outboxRepo);
    this.taskRepo = new TaskRepository(this.db, this.prefix, this.outboxRepo);
    this.eventRepo = new EventRepository(this.db, this.prefix);
    this.edgeRepo = new EdgeRepository(this.db, this.prefix);
    this.metadataRepo = new MetadataRepository(this.db, this.prefix);
    this.ontologyService = new OntologyService(
      this.metadataRepo,
      this.edgeRepo,
      options.config?.ontology,
    );
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
      this.ontologyService,
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
      this.ontologyService,
    );
    this.importExportService = new ImportExportService(
      this.db,
      this.entryRepo,
      this.taskRepo,
      this.eventRepo,
      this.edgeRepo,
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
      this.entryRepo,
      this.eventRepo,
      this.metadataRepo,
      this.jobManager,
      this.maintenanceService,
    );
    this.graphTraversalService = new GraphTraversalService(
      this.edgeRepo,
      this.entryRepo,
      this.options.config ?? {},
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
      graphTraversalService: this.graphTraversalService,
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
      throw new Error(`Invalid sourceRef: ${JSON.stringify(sourceRef)}`);
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

  async traverseGraph(entityId: string, options: GraphTraversalOptions): Promise<GraphNeighborhood> {
    return this.graphTraversalService.traverseGraph(entityId, options);
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
   * Reviews stored facts with the LLM: removes orphans, downgrades stale
   * inferences, synthesizes corrections.
   *
   * Bounded per call: covers at most `batchSize` candidates (default 25), so
   * one call no longer sweeps the whole entity. Hosts own the cadence; loop
   * `while (result.remaining > 0)` for convergence.
   *
   * `remaining === 0` means "every mutable fact is inside the 7-day recheck
   * cooldown", not "there is no more work" — heal's candidate set is the live
   * mutable corpus, not a draining backlog, so it climbs back as the cooldown
   * lapses and as new facts are written. Do not write a loop expecting a drain.
   *
   * @param options.promptOverride - Applies only to this manual call. Does NOT affect
   * WriteService-triggered auto-runs. For persistent prompt customization across auto-runs,
   * set `options.config.prompts.healSystemPrompt` at WikiMemory construction time.
   * @param options.batchSize - Candidates per run (default 25) for providers with
   * tighter context limits.
   */
  async runHeal(
    entityId: string,
    options?: { promptOverride?: string; batchSize?: number },
  ): Promise<HealResult> {
    return this.maintenanceService.runHeal(entityId, options);
  }

  /**
   * Types already-persisted untyped facts (okf_type IS NULL) in place via one
   * librarian-style LLM call. Strictly additive: never creates, deletes, or
   * rewrites facts; never overwrites an existing okf_type. Free when there is
   * nothing to do (ontology off, or zero eligible untyped facts).
   *
   * Hosts own the trigger cadence (e.g. after each sync); loop `while
   * result.remaining > 0` for convergence. Throws WikiBusyError when another
   * backfill (or conflicting maintenance op) is running for the entity.
   *
   * @param options.promptOverride - Applies only to this call. For persistent
   * customization set `options.config.prompts.ontologyBackfillSystemPrompt`.
   * @param options.batchSize - Facts per run (default 25) for providers with
   * tighter context limits.
   */
  async runOntologyBackfill(
    entityId: string,
    options?: { promptOverride?: string; batchSize?: number },
  ): Promise<OntologyBackfillResult> {
    return this.maintenanceService.runOntologyBackfill(entityId, options);
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

  /** Entity summary prose persisted from an OKF profile ≥ 1 import; null when none stored. */
  async getEntitySummary(entityId: string): Promise<string | null> {
    return this.metadataRepo.getMeta(entitySummaryMetaKey(entityId));
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
    if (Number.isFinite(limit) && limit <= 0) return [];
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : 100;
    const rows = await this.outboxRepo.fetchPending(safeLimit);
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

  /**
   * Returns the effective ontology mode and manifest for an entity.
   * Resolution order: persisted DB row → `WikiConfig.ontology.seedManifests[entityId]` → `null`.
   */
  async getOntologyManifest(entityId: string): Promise<{
    mode: OntologyMode;
    manifest: OntologyManifest;
  } | null> {
    const row = await this.metadataRepo.getManifest(entityId);
    if (row) return { mode: this.ontologyService.resolveMode(row.mode), manifest: row.manifest };
    const seed = this.options.config?.ontology?.seedManifests?.[entityId];
    if (seed) {
      return {
        mode: this.ontologyService.resolveMode(seed.mode),
        manifest: seed.manifest,
      };
    }
    return null;
  }

  /**
   * Seeds or replaces an entity's ontology manifest and optional mode override.
   * Validates manifest invariants (unique type slugs, edge endpoints reference node types).
   * Invalidates the in-memory ontology cache for this entity.
   */
  async setOntologyManifest(
    entityId: string,
    manifest: OntologyManifest,
    options?: { mode?: OntologyMode },
  ): Promise<void> {
    const mode = options?.mode ?? this.ontologyService.resolveMode();
    await this.db.withTransactionAsync(tx =>
      this.metadataRepo.setManifest(entityId, { mode, manifest }, tx),
    );
    this.ontologyService.invalidateCache(entityId);
  }
}

export const __testables = { validateFact, validateTask, clip, chunkText };
