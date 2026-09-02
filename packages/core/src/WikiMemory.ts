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
  WikiSourceRefHashCollision,
} from './types';
import { EntryRepository } from './repositories/EntryRepository';
import { OutboxRepository } from './repositories/OutboxRepository';
import { SourceRefIndexRepository } from './repositories/SourceRefIndexRepository';
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
import { OkfTrustWritesRepository } from './db/okf-trust-writes';
import { validateManifest } from './utils/ontology';
import type { OntologyManifest, OntologyMode, GraphTraversalOptions, GraphNeighborhood, OntologyBackfillResult, HealResult, IngestDocumentResult } from './types';

export { WikiBusyError, WikiTransactionError, PrunePartialFailureError, HOOK_TIMEOUT_MARKER, WikiStrictOntologyViolation, WikiSourceRefHashCollision, WikiParseError, WikiIngestEmptyError } from './types';

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
  sourceRefIndexRepo: SourceRefIndexRepository;
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
  private sourceRefIndexRepo: SourceRefIndexRepository;
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
  private readonly okfTrustWrites: OkfTrustWritesRepository;

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
    this.sourceRefIndexRepo = new SourceRefIndexRepository(this.db, this.prefix);
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
      this.sourceRefIndexRepo,
      this.metadataRepo,
      this.edgeRepo,
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
      this.sourceRefIndexRepo,
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
    this.okfTrustWrites = new OkfTrustWritesRepository(this.db, this.prefix);
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
      sourceRefIndexRepo: this.sourceRefIndexRepo,
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

  async hasChanged(
    entityId: string,
    sourceRef: string,
    sourceHash: string,
  ): Promise<boolean>;
  /**
   * Batched overload.
   *
   * `duplicateOf`, when present, is the canonical stored DIFFERENT `source_ref`
   * holding the same hash — never the incoming ref itself (the incoming ref is
   * excluded from the canonical-sort set so a self-reference is impossible).
   * `duplicateOf` reflects the *DB-side* normalized spelling; `sourceRef` in
   * each result echoes the raw caller value. Hosts should not compare these
   * two fields directly to infer canonical status.
   */
  async hasChanged(
    entityId: string,
    entries: Array<{ sourceRef: string; sourceHash: string }>,
  ): Promise<Array<{ sourceRef: string; changed: boolean; duplicateOf?: string }>>;
  async hasChanged(
    entityId: string,
    sourceRefOrEntries: string | Array<{ sourceRef: string; sourceHash: string }>,
    sourceHashArg?: string,
  ): Promise<boolean | Array<{ sourceRef: string; changed: boolean; duplicateOf?: string }>> {
    // Single-doc path: delegate to existing semantics.
    if (typeof sourceRefOrEntries === 'string') {
      const sourceRef = normalizeSourceRef(sourceRefOrEntries);
      if (!sourceRef) {
        throw new Error(`Invalid sourceRef: ${JSON.stringify(sourceRefOrEntries)}`);
      }
      const sourceHash = normalizeSourceHash(sourceHashArg!);
      if (!sourceHash) {
        throw new Error('Invalid sourceHash: must be a 64-character hex string (normalized to lowercase)');
      }
      const storedHash = await this.entryRepo.findLatestSourceHash(entityId, sourceRef);
      if (storedHash === null) return true;
      const normalizedStoredHash = normalizeSourceHash(storedHash);
      return normalizedStoredHash !== sourceHash;
    }

    // Batched path: empty input -> empty result, zero SQL calls.
    const entries = sourceRefOrEntries;
    if (entries.length === 0) return [];

    // Normalize all inputs (validation up front). Preserve the raw ref so the
    // result echoes the caller's spelling (DB refs are normalized on setup,
    // but the caller hasn't seen that normalization yet).
    const normalized = entries.map(e => {
      const r = normalizeSourceRef(e.sourceRef);
      if (!r) throw new Error(`Invalid sourceRef: ${JSON.stringify(e.sourceRef)}`);
      const h = normalizeSourceHash(e.sourceHash);
      if (!h) throw new Error('Invalid sourceHash: must be a 64-character hex string (normalized to lowercase)');
      return { rawSourceRef: e.sourceRef, sourceRef: r, sourceHash: h };
    });

    // 1 + H SQL queries: one batched latest-hash lookup, plus one source_ref_index
    // lookup per distinct input hash. Lookups are issued in parallel — the bound
    // is the SQL-query count, not the await count.
    const latestHashes = await this.entryRepo.findLatestSourceHashes(entityId, normalized.map(e => e.sourceRef));

    const distinctHashes = Array.from(new Set(normalized.map(e => e.sourceHash)));
    const dupRefs = await Promise.all(
      distinctHashes.map(h => this.sourceRefIndexRepo.findActiveByEntityAndHash(entityId, h)),
    );
    const dupMap = new Map<string, string | null>(); // hash -> canonical sourceRef (or null)
    for (let i = 0; i < distinctHashes.length; i++) {
      dupMap.set(distinctHashes[i], dupRefs[i]);
    }

    return normalized.map(e => {
      const stored = latestHashes.get(e.sourceRef);
      const changed = stored === undefined || stored === null || normalizeSourceHash(stored) !== e.sourceHash;
      const canonical = dupMap.get(e.sourceHash) ?? null;
      if (canonical === null || canonical === e.sourceRef) {
        return { sourceRef: e.rawSourceRef, changed };
      }
      // Canonical: the single sourceRef from source_ref_index that holds
      // this hash, if any. Because the partial UNIQUE index allows at most
      // one live row per (entity, hash), the canonical cannot be the
      // incoming ref (it would be the same sourceRef) — we filter that out
      // above. Non-ASCII sourceRefs are still compared by the DB's
      // source_ref index, so the canonical matches the DB ordering.
      return { sourceRef: e.rawSourceRef, changed, duplicateOf: canonical };
    });
  }

  /**
   * Returns the live source_refs for an entity, one row per ref, with the most
   * recently-updated live `source_hash` and a live fact count. Refs are sorted
   * `COLLATE BINARY` (no locale dependency). Used by hosts to reconcile stored
   * state against a live source, or audit duplicate-hash collisions via
   * `findSourceRefsByHash`.
   */
  async listSourceRefs(entityId: string): Promise<Array<{
    sourceRef: string;
    sourceHash: string | null;
    factCount: number;
    lastIngestedAt: number;
  }>> {
    return this.entryRepo.listSourceRefs(entityId);
  }

  /**
   * Returns the live source_refs for an entity that hold the given source_hash.
   * With v9, source_ref_index is the source of truth for the sourceRef-level
   * TOCTOU-race invariant: at most one sourceRef can hold a given
   * (entity_id, source_hash). The result is either a single-element array
   * (one canonical ref) or empty (no live ref holds the hash). Returned as
   * an array to preserve the existing public-API shape used by hosts
   * auditing duplicate-content collisions.
   */
  async findSourceRefsByHash(entityId: string, sourceHash: string): Promise<string[]> {
    const canonical = await this.sourceRefIndexRepo.findActiveByEntityAndHash(entityId, sourceHash);
    return canonical === null ? [] : [canonical];
  }

  /**
   * Returns the set of `entity_id` values with at least one row in this
   * database, INCLUDING entities whose only remaining rows are soft-deleted
   * — sorted ascending `entity_id COLLATE BINARY`. Empty array when the
   * database has no entities.
   *
   * The deliberate inclusion of soft-deleted-only entities closes the
   * decommissioned-scope leak: a scoped namespace whose documents have all
   * been forgotten or superseded must still appear so host maintenance
   * sweeps (`runLibrarian`, `runHeal`, `runOntologyBackfill`, `runPrune`)
   * can visit it and reap the soft-deleted rows.
   *
   * Read-only. Never acquires a lock. Never opens a transaction. Propagates
   * underlying read errors.
   *
   * @param options.prefix - Optional string filter applied as
   *   `id.startsWith(prefix)`. O(n) over distinct ids because the
   *   `(entity_id, source_ref)` index is not seekable on `entity_id`-only
   *   prefix. Empty-string prefix matches every id.
   *
   * Note: this widens the coverage of `exportDump` (which delegates to
   * `MetadataRepository.getDistinctEntityIds`); exported dumps now include
   * orphaned entities. This is a deliberate widening for backup/migration
   * coverage, not a breaking change to `exportDump`'s return shape.
   */
  async listEntityIds(options?: { prefix?: string }): Promise<string[]> {
    const ids = await this.metadataRepo.getDistinctEntityIds();
    if (options?.prefix === undefined) return ids;
    return ids.filter(id => id.startsWith(options.prefix!));
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

  async forget(
    entityId: string,
    params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean },
    opts?: { dryRun?: boolean },
  ): Promise<{ deleted: { entries: number; tasks: number }; metadataReset?: boolean }> {
    return this.maintenanceService.forget(entityId, params, opts);
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
    },
    opts?: { onDuplicateHash?: 'ingest' | 'skip' | 'throw' },
  ): Promise<IngestDocumentResult> {
    return this.ingestionService.ingestDocument(entityId, params, opts);
  }

  /**
   * Deterministic write path into the graph. Accepts caller-supplied
   * `(nodes, edges)` and writes them under `(sourceRef, sourceHash)`
   * semantics identical to `ingestDocument`, minus the LLM extraction step.
   *
   * MUST be called from inside an open `db.withTransactionAsync` callback —
   * the third argument is the caller's `tx`. The method does not open a
   * nested transaction, does not acquire any lock, and does not perform
   * post-commit work (search sync, embedding, cache eviction). Hosts that
   * want embeddings synced should drive the existing maintenance sweep
   * (`runLibrarian` / `runHeal` / `runOntologyBackfill` / `runPrune`,
   * scoped via `listEntityIds`).
   *
   * Contract (full pre-flight validation lives inside
   * `IngestionService.upsertGraphCore`, which this method delegates to):
   * - C2: no-op when `(entityId, sourceHash)` is already mapped to
   *   `params.sourceRef`; throws `WikiSourceRefHashCollision` if mapped to
   *   a different `sourceRef`.
   * - C3: edges with dangling `targetId` are stored verbatim (no FK, no
   *   resolution).
   * - C4: under persisted ontology mode `'strict'`, an out-of-manifest node
   *   or edge `type` throws `WikiStrictOntologyViolation` (pre-flight,
   *   all-or-nothing — NONE written on failure).
   *
   * @returns Counts: nodesWritten (validated nodes persisted), edgesWritten
   *   (manifest-valid edges persisted), superseded (prior facts soft-deleted
   *   plus prior source-ref edges hard-deleted).
   */
  async upsertGraph(
    entityId: string,
    params: {
      sourceRef: string;
      sourceHash: string;
      nodes: readonly { id: string; type: string; title: string; body?: string }[];
      edges: readonly { type: string; sourceId: string; targetId: string; id?: string }[];
    },
    adapter: SQLiteAdapter,
  ): Promise<{ nodesWritten: number; edgesWritten: number; superseded: number }> {
    const sourceRef = normalizeSourceRef(params.sourceRef);
    if (!sourceRef) throw new Error('Invalid sourceRef');
    const sourceHash = normalizeSourceHash(params.sourceHash);
    if (!sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

    // C2 probe — runs inside the caller's tx so it sees the in-flight state.
    const canonical = await this.sourceRefIndexRepo.findActiveByEntityAndHash(entityId, sourceHash, adapter);
    if (canonical !== null && canonical === sourceRef) {
      return { nodesWritten: 0, edgesWritten: 0, superseded: 0 };
    }
    if (canonical !== null && canonical !== sourceRef) {
      throw new WikiSourceRefHashCollision({
        entityId,
        sourceHash,
        existingSourceRef: canonical,
        attemptedSourceRef: sourceRef,
      });
    }

    // Delegate to upsertGraphCore for steps a–j (manifest read, validation,
    // supersession, writes, returns counts). No opts.strict override — let
    // the persisted ontology mode drive strictness per the spec.
    return this.ingestionService.upsertGraphCore(
      entityId,
      { sourceRef, sourceHash, nodes: params.nodes, edges: params.edges },
      adapter,
    );
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

  /**
   * Write several entities' ontology manifests in a single transaction.
   *
   * All succeed or none do. The transaction is opened on this instance's
   * serialized adapter — callers pass data, never a transaction handle, because
   * a consumer holds the unwrapped adapter and a transaction opened on it would
   * bypass the serialization mutex applied in the constructor.
   *
   * Returns which entities were written. `skipped` is only ever non-empty under
   * `opts.ifAbsent`.
   */
  async setOntologyManifests(
    entries: Array<{
      entityId: string;
      manifest: OntologyManifest;
      mode?: OntologyMode;
    }>,
    opts?: { ifAbsent?: boolean },
  ): Promise<{ written: string[]; skipped: string[] }> {
    // Nothing to do — and deliberately no transaction, so an empty batch never
    // takes the serialization mutex.
    if (entries.length === 0) return { written: [], skipped: [] };

    // Two entries naming one entity express ambiguous intent. Applying the last
    // one silently would hide a caller bug whose symptom — a manifest that is
    // not the one the caller believed it wrote — surfaces far from its cause.
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.entityId)) {
        throw new Error(`Duplicate entityId in batch: ${entry.entityId}`);
      }
      seen.add(entry.entityId);
    }

    // Validate every manifest BEFORE opening the transaction, so a doomed batch
    // never reaches the database and never takes the mutex. `setManifest`
    // validates again inside the transaction; that is the invariant protecting
    // every other repository caller, and is not redundant with this gate.
    for (const entry of entries) {
      validateManifest(entry.manifest);
    }

    const written: string[] = [];
    const skipped: string[] = [];

    await this.db.withTransactionAsync(async (tx) => {
      for (const entry of entries) {
        const mode = entry.mode ?? this.ontologyService.resolveMode();
        const wrote = await this.metadataRepo.setManifest(
          entry.entityId,
          { mode, manifest: entry.manifest },
          tx,
        );
        (wrote ? written : skipped).push(entry.entityId);
      }
    });

    // After commit, and for EVERY entry: a skipped entry means another writer
    // won the race, so this instance's cached copy may be stale — dropping it
    // is more correct than keeping it. Invalidation is safe regardless of the
    // transaction's outcome, because it only removes a cached copy and the next
    // read goes to the database.
    for (const entry of entries) {
      this.ontologyService.invalidateCache(entry.entityId);
    }

    return { written, skipped };
  }

  /** Append a verification event to a fact. Does NOT touch `updated_at`. */
  async writeOkfTrust(entryId: string, entityId: string, verified: { by: string; at: string }[]): Promise<void> {
    return this.okfTrustWrites.writeOkfTrust(entryId, entityId, verified);
  }

  /** Replace a fact's source list. Does NOT touch `updated_at`. */
  async writeOkfSources(entryId: string, entityId: string, sources: Array<{ resource: string; [k: string]: unknown }>): Promise<void> {
    return this.okfTrustWrites.writeOkfSources(entryId, entityId, sources as any);
  }

  /** Set a fact's OKF v0.2 lifecycle status. Does NOT touch `updated_at`. */
  async setLifecycleStatus(entryId: string, entityId: string, status: 'draft' | 'stable' | 'deprecated'): Promise<void> {
    return this.okfTrustWrites.setLifecycleStatus(entryId, entityId, status);
  }

  /** Set a fact's stale_after (epoch ms) or clear it. Does NOT touch `updated_at`. */
  async setStaleAfter(entryId: string, entityId: string, date: number | null): Promise<void> {
    return this.okfTrustWrites.setStaleAfter(entryId, entityId, date);
  }

  /** Set a fact's generated_by actor string. Does NOT touch `updated_at`. */
  async setGeneratedBy(entryId: string, entityId: string, actor: string): Promise<void> {
    return this.okfTrustWrites.setGeneratedBy(entryId, entityId, actor);
  }

  /** Task variants of the same five DAO methods. Symmetric per spec §2.5. */
  async writeOkfTrustTask(taskId: string, entityId: string, verified: { by: string; at: string }[]): Promise<void> {
    return this.okfTrustWrites.writeOkfTrustTask(taskId, entityId, verified);
  }
  async writeOkfSourcesTask(taskId: string, entityId: string, sources: Array<{ resource: string; [k: string]: unknown }>): Promise<void> {
    return this.okfTrustWrites.writeOkfSourcesTask(taskId, entityId, sources as any);
  }
  async setLifecycleStatusTask(taskId: string, entityId: string, status: 'draft' | 'stable' | 'deprecated'): Promise<void> {
    return this.okfTrustWrites.setLifecycleStatusTask(taskId, entityId, status);
  }
  async setStaleAfterTask(taskId: string, entityId: string, date: number | null): Promise<void> {
    return this.okfTrustWrites.setStaleAfterTask(taskId, entityId, date);
  }
  async setGeneratedByTask(taskId: string, entityId: string, actor: string): Promise<void> {
    return this.okfTrustWrites.setGeneratedByTask(taskId, entityId, actor);
  }
}

export const __testables = { validateFact, validateTask, clip, chunkText };
