# Spec: Phase 3.5 - Repository Pattern

**Date:** May 15, 2026
**Status:** Implemented

This is a classic "God Object" scenario. You’ve successfully implemented the Repository pattern (Phase 3), which abstract away the raw SQLite queries, but `WikiMemory.ts` is still acting as a massive orchestrator that holds too much domain logic—especially for reading/ranking and importing/exporting.

Since `WikiMemory` already delegates beautifully to `MaintenanceService` and `IngestionService`, we can follow that exact same pattern to break down the rest of the file.

Here is a proposed plan to split `WikiMemory.ts` into a series of focused, domain-specific services, reducing it to a clean facade.

### Step 1: Extract `RetrievalService` (or `ReadService`)

The `read()` method and its associated helpers form the largest chunk of logic in the file (handling pre-filtering, vector ranking, hybrid search, tier weights, and fallback mechanisms).

- **Move to:** `src/services/RetrievalService.ts`
    
- **Methods to Extract:**
    
    - `read()`
        
    - `_rankWithVectorRanker()`
        
    - `_filterScoredEntities()`
        
    - `_tieBreakSort()` and `_compareScoredRows()`
        
    - `_hydrateFactsByIds()`
        
    - `_sanitizeRankerError()`
        
- **Dependencies to Inject:** `EntryRepository`, `TaskRepository`, `EventRepository`, `SearchService`, `MetadataRepository`, and the LLM/Ranker options.
    

### Step 2: Extract `ImportExportService`

The dump import/export logic is incredibly dense because it handles data normalization, LWW (Last-Write-Wins) merging, soft-delete tracking, and blob serialization inside massive transactions.

- **Move to:** `src/services/ImportExportService.ts`
    
- **Methods to Extract:**
    
    - `importDump()`
        
    - `_doImportEntity()` (This is a massive ~250 line method on its own)
        
    - `exportDump()`
        
    - `_getFullBundle()`
        
    - `_normalizeImportedSourceType()`
        
    - `_warnCrossEntityCollision()`
        
- **Dependencies to Inject:** `EntryRepository`, `TaskRepository`, `EventRepository`, `MetadataRepository`, `JobManager`, `SearchService`, and the `EmbeddingService` (see Step 3).
    

### Step 3: Extract `EmbeddingService` (or `VectorManager`)

There is significant logic dedicated to maintaining vector sync, handling model dimension changes, and triggering external ranker hooks.

- **Move to:** `src/services/EmbeddingService.ts`
    
- **Methods to Extract:**
    
    - `embedFact()`
        
    - `storeEmbeddingDimension()`
        
    - `_reconcileEmbeddingDimension()`
        
    - `_notifyEmbeddingPersisted()`
        
    - `_notifyEmbeddingPersistedOrThrow()`
        
- **Dependencies to Inject:** `EntryRepository`, `MetadataRepository`, and the LLM options.
    

### Step 4: Extract `WriteService` (or `EventOrchestrator`)

The writing of events and the subsequent evaluation of whether to trigger the Librarian or Heal jobs is a distinct responsibility.

- **Move to:** `src/services/WriteService.ts`
    
- **Methods to Extract:**
    
    - `write()`
        
    - `runLibrarianThenMaybeHeal()`
        
- **Dependencies to Inject:** `EventRepository`, `MetadataRepository`, `JobManager`, and `MaintenanceService`.
    

---

### The Resulting Architecture

Once these extractions are complete, `WikiMemory.ts` becomes a pure, lightweight Facade. Its constructor will look something like this:

TypeScript

```
constructor(db: SQLiteAdapter, options: WikiOptions) {
    // ... initialize repositories ...

    // Initialize Services
    this.searchService = new SearchService(this.entryRepo);
    this.embeddingService = new EmbeddingService(...);
    this.retrievalService = new RetrievalService(...);
    this.importExportService = new ImportExportService(...);
    this.writeService = new WriteService(...);
    // ... Ingestion and Maintenance ...
}
```

And its class methods will simply pass through to the services:

TypeScript

```
async read(entityId: string | string[], query: string, options?: ReadOptions) {
    return this.retrievalService.read(entityId, query, options);
}

async importDump(dump: MemoryDump, opts?: { merge?: boolean }) {
    return this.importExportService.importDump(dump, opts);
}
```

### Recommended Execution Order

1. **Start with `ImportExportService`**: It is highly isolated and removing it instantly clears out ~350 lines of complex transaction logic from the bottom of the file.
    
2. **Tackle `RetrievalService` next**: It is the most complex conceptually, but its dependencies are strictly read-only, making it safe to move.
    
3. **Move `EmbeddingService`**: This will require updating `MaintenanceService` and `IngestionService` to accept the new `EmbeddingService` instead of bound `WikiMemory` methods (`this.embedFact.bind(this)`).
    
4. **Finish with `WriteService` & `Setup` logic**.
    

Would you like me to draft the code for the `RetrievalService` or `ImportExportService` extraction first?

---

Here is the code to extract the `ImportExportService`. Since this handles the massive, transaction-heavy dumping and hydration logic, moving it immediately clears out nearly 400 lines from the bottom of `WikiMemory.ts`.

### 1. Create `src/services/ImportExportService.ts`

This new service will take the repositories, external services, and a few binding callbacks for embedding logic via its constructor.

TypeScript

```
import type { SQLiteAdapter } from '../types';
import { MemoryBundle, MemoryDump, WikiFact } from '../types';
import { EntryRepository } from '../repositories/EntryRepository';
import { TaskRepository } from '../repositories/TaskRepository';
import { EventRepository } from '../repositories/EventRepository';
import { MetadataRepository } from '../repositories/MetadataRepository';
import { SearchService } from './SearchService';
import { JobManager } from './JobManager';

export class ImportExportService {
    constructor(
        private db: SQLiteAdapter,
        private entryRepo: EntryRepository,
        private taskRepo: TaskRepository,
        private eventRepo: EventRepository,
        private metadataRepo: MetadataRepository,
        private searchService: SearchService,
        private jobManager: JobManager,
        // Callbacks for embedding hooks that still live in WikiMemory (or the future EmbeddingService)
        private embedFact: (fact: { id: string; entity_id: string; title: string; body: string; tags: string | string[] }) => Promise<boolean>,
        private notifyEmbeddingPersisted: (entityId: string, factId: string, vector: Float32Array | null) => Promise<void>,
        private storeEmbeddingDimension: (dim: number) => Promise<void>,
        private reconcileEmbeddingDimension: () => Promise<void>
    ) {}

    async exportDump(entityIds?: string[]): Promise<MemoryDump> {
        let ids: string[];
        if (entityIds && entityIds.length > 0) {
            ids = Array.from(new Set(entityIds));
        } else {
            ids = await this.metadataRepo.getDistinctEntityIds();
        }

        const entities: Record<string, MemoryBundle> = {};
        const BATCH = 3;
        for (let i = 0; i < ids.length; i += BATCH) {
            const batch = ids.slice(i, i + BATCH);
            const batchResults = await Promise.all(
                batch.map(async (id): Promise<[string, MemoryBundle]> => [
                    id,
                    await this._getFullBundle(id, { includeBlobs: true })
                ])
            );
            for (const [id, bundle] of batchResults) {
                entities[id] = bundle;
            }
        }

        return { generatedAt: Date.now(), entities };
    }

    async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
        const merge = opts?.merge ?? false;
        const entityIds = Object.keys(dump.entities);

        this.jobManager.acquireImportLocks(entityIds);
        try {
            await this.assertNoLegacySourceTypes();
            for (const [entityId, bundle] of Object.entries(dump.entities)) {
                await this._doImportEntity(entityId, bundle, merge);
            }
        } finally {
            this.jobManager.releaseImportLocks(entityIds);
        }
    }

    private async _getFullBundle(entityId: string, opts?: { maxEvents?: number; includeBlobs?: boolean }): Promise<MemoryBundle> {
        const [factsRaw, tasks, events] = await Promise.all([
            this.entryRepo.findAllByEntityId(entityId),
            this.taskRepo.findAllByEntityId(entityId),
            this.eventRepo.getByEntityId(entityId, opts?.maxEvents),
        ]);

        const facts = factsRaw.map(f => {
            const { embedding: _embedding, embedding_blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: Uint8Array };
            const safeBlobCopy = opts?.includeBlobs && embedding_blob
                ? (() => {
                      const c = new ArrayBuffer(embedding_blob.byteLength);
                      new Uint8Array(c).set(embedding_blob);
                      return new Uint8Array(c);
                  })()
                : undefined;

            const factBase = safeBlobCopy ? { ...rest, embedding_blob: safeBlobCopy } : rest;
            return {
                ...factBase,
                tags: typeof factBase.tags === 'string' ? JSON.parse(factBase.tags) : factBase.tags,
            };
        });

        return { facts, tasks, events };
    }

    private async _doImportEntity(entityId: string, bundle: MemoryBundle, merge: boolean): Promise<void> {
        const upsertedFactIds = new Set<string>();
        const upsertedDeletedFactIds = new Set<string>();
        const factsWithPreservedBlob = new Map<string, Uint8Array>();
        const preservedBlobDims = new Set<number>();
        const softDeletedFactIds: string[] = [];

        await this.db.withTransactionAsync(async (tx) => {
            if (!merge) {
                const deletedLiveFactIds = await this.entryRepo.findIdsBySource(entityId, null, null, tx, false);
                softDeletedFactIds.push(...deletedLiveFactIds);
                await this.entryRepo.bulkSoftDeleteByEntityId(entityId, tx);
                await this.taskRepo.bulkSoftDeleteByEntityId(entityId, tx);
                await this.metadataRepo.deleteCheckpoint(entityId, tx);
            }

            const factIds = bundle.facts.map((fact) => fact.id);
            const existingFactsById = new Map<string, { id: string; entity_id: string; updated_at: number }>();
            const existingFacts = await this.entryRepo.findExistingMetadataByIds(factIds, tx);
            for (const existingFact of existingFacts) {
                existingFactsById.set(existingFact.id, existingFact);
            }

            for (const fact of bundle.facts) {
                const sourceType = this._normalizeImportedSourceType(String(fact.source_type), {
                    entityId,
                    factId: fact.id,
                });

                const safeUpdatedAt = Number.isFinite(fact.updated_at) ? fact.updated_at : 0;
                const existing = existingFactsById.get(fact.id);

                const rawBlobRaw = (fact as WikiFact & { embedding_blob?: unknown }).embedding_blob;
                let rawBlob: Uint8Array | null = null;

                if (rawBlobRaw instanceof Uint8Array) {
                    rawBlob = rawBlobRaw;
                } else if (rawBlobRaw !== null && rawBlobRaw !== undefined && typeof rawBlobRaw === 'object') {
                    const obj = rawBlobRaw as Record<string, unknown>;
                    if (obj['type'] === 'Buffer' && Array.isArray(obj['data'])) {
                        rawBlob = new Uint8Array(obj['data'] as number[]);
                    } else if (!Array.isArray(rawBlobRaw)) {
                        const entries = Object.keys(obj);
                        if (entries.length > 0 && entries.every(k => /^\d+$/.test(k))) {
                            const len = entries.length;
                            rawBlob = new Uint8Array(len);
                            for (let i = 0; i < len; i++) rawBlob[i] = (obj[String(i)] as number) ?? 0;
                        }
                    }
                }

                let blobData: Uint8Array | null = null;
                if (rawBlob !== null && rawBlob.byteLength > 0 && rawBlob.byteLength % 4 === 0) {
                    const copy = new ArrayBuffer(rawBlob.byteLength);
                    const alignedBlob = new Uint8Array(copy);
                    alignedBlob.set(rawBlob);
                    const floats = new Float32Array(copy, 0, rawBlob.byteLength / 4);

                    let allFinite = true;
                    for (let i = 0; i < floats.length; i++) {
                        if (!isFinite(floats[i])) {
                            allFinite = false;
                            break;
                        }
                    }
                    if (allFinite) {
                        blobData = alignedBlob;
                    }
                }

                if (existing) {
                    if (existing.entity_id !== entityId) {
                        this._warnCrossEntityCollision('entry', fact.id, existing.entity_id, entityId);
                        continue;
                    }
                    if (merge && safeUpdatedAt <= existing.updated_at) continue;
                }

                const factObj: WikiFact = {
                    id: fact.id,
                    entity_id: entityId,
                    title: fact.title,
                    body: fact.body,
                    tags: Array.isArray(fact.tags) ? fact.tags : [],
                    confidence: fact.confidence,
                    source_type: sourceType,
                    source_hash: fact.source_hash,
                    source_ref: fact.source_ref,
                    created_at: fact.created_at,
                    updated_at: safeUpdatedAt,
                    last_accessed_at: fact.last_accessed_at,
                    access_count: fact.access_count,
                    deleted_at: fact.deleted_at,
                    embedding_blob: blobData ?? undefined,
                };

                await this.entryRepo.upsertForImport(factObj, tx);

                if (blobData != null) {
                    factsWithPreservedBlob.set(fact.id, blobData);
                    if (!fact.deleted_at) preservedBlobDims.add(blobData.byteLength / 4);
                }

                existingFactsById.set(fact.id, { id: fact.id, entity_id: entityId, updated_at: safeUpdatedAt });
                upsertedFactIds.add(fact.id);
                if (fact.deleted_at) upsertedDeletedFactIds.add(fact.id);
            }

            const taskIds = bundle.tasks.map((task) => task.id);
            const existingTasksById = new Map<string, { id: string; entity_id: string; updated_at: number }>();
            const existingTasks = await this.taskRepo.findExistingMetadataByIds(taskIds, tx);

            for (const existingTask of existingTasks) {
                existingTasksById.set(existingTask.id, existingTask);
            }

            for (const task of bundle.tasks) {
                const safeUpdatedAt = Number.isFinite(task.updated_at) ? task.updated_at : 0;
                const existing = existingTasksById.get(task.id);

                if (existing) {
                    if (existing.entity_id !== entityId) {
                        this._warnCrossEntityCollision('task', task.id, existing.entity_id, entityId);
                        continue;
                    }
                    if (merge && safeUpdatedAt <= existing.updated_at) continue;
                }

                await this.taskRepo.upsertForImport(
                    {
                        id: task.id,
                        entity_id: entityId,
                        description: task.description,
                        status: task.status,
                        priority: task.priority,
                        created_at: task.created_at,
                        updated_at: safeUpdatedAt,
                        resolved_at: task.resolved_at,
                        deleted_at: task.deleted_at,
                    },
                    tx,
                    safeUpdatedAt
                );
            }

            for (const event of bundle.events) {
                await this.eventRepo.addIgnoreDuplicate({
                    id: event.id,
                    entity_id: entityId,
                    event_type: event.event_type,
                    summary: event.summary,
                    related_entry_id: event.related_entry_id ?? null,
                    created_at: event.created_at,
                }, tx);
            }
        });

        await this.searchService.sync(entityId);

        for (const fact of bundle.facts) {
            if (!fact.deleted_at && upsertedFactIds.has(fact.id) && !factsWithPreservedBlob.has(fact.id)) {
                await this.embedFact({
                    id: fact.id,
                    entity_id: entityId,
                    title: fact.title,
                    body: fact.body,
                    tags: Array.isArray(fact.tags) || typeof fact.tags === 'string' ? fact.tags : [],
                });
            }
        }

        for (const fact of bundle.facts) {
            const blobData = factsWithPreservedBlob.get(fact.id);
            if (blobData && !fact.deleted_at && upsertedFactIds.has(fact.id)) {
                try {
                    const float32Vector = new Float32Array(blobData.buffer, blobData.byteOffset, blobData.byteLength / 4);
                    await this.notifyEmbeddingPersisted(entityId, fact.id, float32Vector);
                } catch (hookErr) {
                    console.warn(`[WikiMemory] onEmbeddingPersisted hook failed for preserved-blob fact ${fact.id}:`, hookErr);
                }
            }
        }

        for (const factId of softDeletedFactIds) {
            if (!upsertedFactIds.has(factId) || upsertedDeletedFactIds.has(factId)) {
                try {
                    await this.notifyEmbeddingPersisted(entityId, factId, null);
                } catch (hookErr) {
                    console.warn(`[WikiMemory] onEmbeddingPersisted(vector=null) hook failed for soft-deleted fact ${factId}:`, hookErr);
                }
            }
        }

        try {
            const canonicalDimValue = await this.metadataRepo.getMeta('embedding_dimension');
            const canonicalDim = canonicalDimValue ? parseInt(canonicalDimValue, 10) : null;

            if (preservedBlobDims.size === 1) {
                const preservedDim = [...preservedBlobDims][0];
                if (canonicalDim === null || canonicalDim === preservedDim) {
                    await this.storeEmbeddingDimension(preservedDim);
                    const staleMismatchValue = await this.metadataRepo.getMeta('embedding_dimension_mismatch');
                    if (staleMismatchValue && parseInt(staleMismatchValue, 10) !== preservedDim) {
                        await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(preservedDim), this.db);
                    }
                    await this.reconcileEmbeddingDimension();
                } else {
                    await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(canonicalDim), this.db);
                }
            } else if (preservedBlobDims.size > 1) {
                if (canonicalDim === null) {
                    const sortedPreservedBlobDims = [...preservedBlobDims].sort((a, b) => a - b);
                    await this.storeEmbeddingDimension(sortedPreservedBlobDims[0]);
                    await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(sortedPreservedBlobDims[0]), this.db);
                } else {
                    await this.metadataRepo.setMeta('embedding_dimension_mismatch', String(canonicalDim), this.db);
                }
            }
        } finally {
            this.searchService.evictCache(entityId);
        }
    }

    private _warnCrossEntityCollision(type: 'entry' | 'task', id: string, existingEntityId: string, targetEntityId: string): void {
        console.warn(`[WikiMemory] importDump: ${type} id "${id}" already belongs to entity "${existingEntityId}"; skipping for entity "${targetEntityId}"`);
    }

    private _normalizeImportedSourceType(raw: string, ctx?: { entityId: string; factId: string }): WikiFact['source_type'] {
        if (raw === 'user_document') return 'immutable_document';
        if (raw === 'agent_inferred') return 'librarian_inferred';

        const allowed: WikiFact['source_type'][] = ['user_stated', 'librarian_inferred', 'user_confirmed', 'immutable_document'];
        if ((allowed as string[]).includes(raw)) return raw as WikiFact['source_type'];

        const where = ctx !== undefined ? ` for entity "${ctx.entityId}" fact "${ctx.factId}"` : '';
        throw new Error(`importDump: invalid source_type "${raw}"${where} (expected one of: ${allowed.join(', ')}, or legacy aliases user_document / agent_inferred)`);
    }

    public async assertNoLegacySourceTypes(): Promise<void> {
        if (!(await this.entryRepo.hasLegacySourceTypes())) return;

        const count = await this.entryRepo.countLegacySourceTypes();
        throw new Error(
            `Database contains ${count} entries with legacy source_type values ('user_document' or 'agent_inferred'). ` +
            `These enum values were renamed in this release. Running without migration would allow legacy 'user_document' facts to bypass ` +
            `immutability guards, causing data corruption.\n\n${this.entryRepo.getLegacyMigrationSQL()}\n\n` +
            `After running the migration SQL, restart your application.`
        );
    }
}
```

---

### 2. Update `WikiMemory.ts`

Now, add the private instance variable to the class, instantiate it in the constructor, and update the existing implementations to be pass-throughs. _Make sure to delete the original implementations of those exact methods._

**In the Class definition:**

TypeScript

```
import { ImportExportService } from './services/ImportExportService';

export class WikiMemory {
    // ... existing repos ...
    private importExportService: ImportExportService;
    // ...
```

**In the constructor:**

TypeScript

```
        // Keep existing initializations
        this.searchService = new SearchService(this.entryRepo);
        this.jobManager = new JobManager(this.prefix);

        // Add ImportExportService
        this.importExportService = new ImportExportService(
            this.db,
            this.entryRepo,
            this.taskRepo,
            this.eventRepo,
            this.metadataRepo,
            this.searchService,
            this.jobManager,
            this.embedFact.bind(this),
            this._notifyEmbeddingPersisted.bind(this),
            this.storeEmbeddingDimension.bind(this),
            this._reconcileEmbeddingDimension.bind(this)
        );

        // Keep Ingestion/Maintenance bindings...
```

**Replace these facade methods:**

TypeScript

```
    async getMemoryBundle(entityId: string): Promise<MemoryBundle> {
        // Technically _getFullBundle is inside ImportExport, you could either 
        // expose it as public on the service, or move getMemoryBundle over to it entirely.
        // Easiest is to make it public or export it natively:
        return this.importExportService['_getFullBundle'](entityId, { maxEvents: 10 });
    }

    async exportDump(entityIds?: string[]): Promise<MemoryDump> {
        return this.importExportService.exportDump(entityIds);
    }

    async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
        return this.importExportService.importDump(dump, opts);
    }
    
    // Make sure `assertNoLegacySourceTypes` inside WikiMemory delegates if it's used in setup()
    private async assertNoLegacySourceTypes(): Promise<void> {
        return this.importExportService.assertNoLegacySourceTypes();
    }
```

---

That cuts a huge chunk of procedural code right out of your class! Should we knock out the `RetrievalService` (which handles the `.read()` logic) next?

Here is the extraction for `RetrievalService`. This pulls out `read()` and all of its complex ranking, hydration, and fallback logic, which removes another massive chunk (~450 lines) from `WikiMemory.ts`.

### 1. Create `src/services/RetrievalService.ts`

This new service focuses exclusively on orchestrating reads. It takes the repositories, search service, and options via the constructor.

TypeScript

```
import type { SQLiteAdapter } from '../types';
import { WikiOptions, MemoryBundle, WikiFact, ReadOptions } from '../types';
import { EntryRepository, EntryRowMetadata, EntryRowWithEmbeddings } from '../repositories/EntryRepository';
import { TaskRepository } from '../repositories/TaskRepository';
import { EventRepository } from '../repositories/EventRepository';
import { MetadataRepository } from '../repositories/MetadataRepository';
import { SearchService } from './SearchService';
import { applyTierWeight, normalizeEntityIds, sanitizeTierWeights, shouldExposeReadMetadata } from '../readOptions';

type ReadCandidateRowMetadata = EntryRowMetadata;
type ReadCandidateRowWithEmbeddings = EntryRowWithEmbeddings;

export class RetrievalService {
    constructor(
        private options: WikiOptions,
        private entryRepo: EntryRepository,
        private taskRepo: TaskRepository,
        private eventRepo: EventRepository,
        private metadataRepo: MetadataRepository,
        private searchService: SearchService
    ) {}

    async read(entityId: string | string[], query: string, options?: ReadOptions): Promise<MemoryBundle> {
        const config = this.options.config;
        const entityIds = normalizeEntityIds(entityId);
        const sanitizedTierWeights = shouldExposeReadMetadata(entityId) ? sanitizeTierWeights(entityIds, options?.tierWeights) : undefined;
        const exposeMetadata = shouldExposeReadMetadata(entityId);

        if (entityIds.length === 0) {
            const empty: MemoryBundle = { facts: [], tasks: [], events: [] };
            if (exposeMetadata) {
                empty.metadata = { query, entityIds: [] };
                if (sanitizedTierWeights && Object.keys(sanitizedTierWeights).length > 0) empty.metadata.tierWeights = sanitizedTierWeights;
            }
            return empty;
        }

        const MAX_ENTITY_IDS = 100;
        if (entityIds.length > MAX_ENTITY_IDS) {
            throw new RangeError(`read() accepts at most ${MAX_ENTITY_IDS} entity IDs; received ${entityIds.length}`);
        }
        const nullByteId = entityIds.find(id => id.includes('\x00'));
        if (nullByteId !== undefined) {
            throw new TypeError(`entity_id values must not contain the null byte (\\x00); got "${nullByteId}"`);
        }

        const rawMaxResults = options?.maxResults ?? config?.maxResults ?? config?.maxFtsResults ?? 10;
        const maxResults = Number.isFinite(rawMaxResults) ? Math.max(0, Math.trunc(rawMaxResults)) : 10;
        const rawPreFilterLimit = options?.preFilterLimit === null ? undefined : (options?.preFilterLimit ?? config?.preFilterLimit);
        const effectivePreFilterLimit = rawPreFilterLimit === undefined ? undefined : Number.isFinite(rawPreFilterLimit) ? Math.max(0, Math.trunc(rawPreFilterLimit)) : undefined;

        const hybridWeight = options?.hybridWeight ?? config?.hybridWeight;
        const weight = hybridWeight !== undefined && !Number.isNaN(hybridWeight) ? Math.max(0, Math.min(1, hybridWeight)) : undefined;
        const skipEmbed = weight === 0;

        const embedFn = this.options.llmProvider.embed;
        const trimmedQuery = query.trim();

        let facts: WikiFact[] = [];
        let scoreByFactId: Map<string, number> | undefined;

        if (maxResults === 0) {
            // Fast-path: a zero-capacity result window can never return any facts.
        } else if (trimmedQuery) {
            let usedEmbed = false;
            const scoredEntityIds = this._filterScoredEntities(entityIds, sanitizedTierWeights, options?.includeZeroWeightEntities);

            if (scoredEntityIds.length === 0) {
                usedEmbed = true;
            } else if (!skipEmbed && embedFn) {
                let rankerShouldRethrow = false;
                let pendingRankerFallbackError: Error | undefined;

                try {
                    const queryVec = await embedFn(trimmedQuery);
                    
                    if (queryVec.length === 0 || !queryVec.every(v => typeof v === 'number' && isFinite(v))) {
                        throw new Error('embed() returned an empty or non-finite vector. Falling back to keyword search.');
                    }

                    const storedDimValue = await this.metadataRepo.getMeta('embedding_dimension');
                    if (storedDimValue) {
                        const storedDim = parseInt(storedDimValue, 10);
                        if (storedDim !== queryVec.length) {
                            throw new Error(`Embedding dimension mismatch: stored ${storedDim}, query has ${queryVec.length}. ` +
                                `Call runReembed() to rebuild embeddings with the new model.`);
                        }
                    }

                    const mismatchedCount = await this.entryRepo.countDimensionMismatched(scoredEntityIds, queryVec.length);
                    if (mismatchedCount > 0) {
                        throw new Error(`Some facts have embeddings that do not match the current model dimension. ` +
                            `Call runReembed() to rebuild all embeddings consistently.`);
                    }

                    const useRanker = Boolean(this.options.vectorRanker);
                    let candidateRows: ReadCandidateRowMetadata[] | ReadCandidateRowWithEmbeddings[] | null;
                    let populateCache = entityIds.length === 1;
                    let miniSearchScores: Map<string, number> | undefined;

                    if (effectivePreFilterLimit !== undefined) {
                        populateCache = false;
                        const preResults = this.searchService.searchKeyword(trimmedQuery, scoredEntityIds, Number.MAX_SAFE_INTEGER);
                        if (preResults.length === 0) {
                            candidateRows = null;
                        } else {
                            const topKResults = preResults.slice(0, effectivePreFilterLimit);
                            if (topKResults.length === 0) {
                                candidateRows = null;
                            } else {
                                const topKIds = topKResults.map(r => r.id);
                                if (useRanker) {
                                    candidateRows = await this.entryRepo.findMetadataByIds(topKIds);
                                } else {
                                    candidateRows = await this.entryRepo.findWithEmbeddingsByIds(topKIds);
                                }
                                if (weight !== undefined && weight < 1) {
                                    const maxMsScore = Math.max(1, topKResults[0]?.score ?? 1);
                                    miniSearchScores = new Map(topKResults.map(r => [r.id, r.score / maxMsScore]));
                                }
                            }
                        }
                    } else {
                        if (useRanker) {
                            candidateRows = await this.entryRepo.findMetadataByEntityIds(scoredEntityIds);
                        } else {
                            candidateRows = await this.entryRepo.findWithEmbeddingsByEntityIds(scoredEntityIds);
                        }
                        if (weight !== undefined && weight < 1) {
                            miniSearchScores = this.searchService.getMiniSearchScores(trimmedQuery, scoredEntityIds);
                        }
                    }

                    if (candidateRows === null) {
                        usedEmbed = true;
                    } else {
                        const entityCacheKey = entityIds.length === 1 ? entityIds[0] : entityIds.join('\x00');
                        let scored: Array<{ id: string; entity_id: string; score: number; updated_at?: number | null; access_count?: number | null }>;

                        if (useRanker) {
                            const candidateRowsByEntity = new Map<string, ReadCandidateRowMetadata[]>();
                            for (const row of candidateRows as ReadCandidateRowMetadata[]) {
                                const rows = candidateRowsByEntity.get(row.entity_id) ?? [];
                                rows.push(row);
                                candidateRowsByEntity.set(row.entity_id, rows);
                            }

                            try {
                                const rankerResultsByEntity = await Promise.all(
                                    scoredEntityIds.filter(id => (candidateRowsByEntity.get(id)?.length ?? 0) > 0).map(async scopedEntityId => {
                                        const rowsForEntity = candidateRowsByEntity.get(scopedEntityId) ?? [];
                                        const candidateIds = effectivePreFilterLimit !== undefined ? rowsForEntity.map(row => row.id) : undefined;
                                        const ranked = await this._rankWithVectorRanker({
                                            entityId: scopedEntityId,
                                            queryVec,
                                            candidateIds,
                                            candidateRows: rowsForEntity,
                                            weight,
                                            miniSearchScores,
                                            limit: Math.max(maxResults * 2, maxResults + 50),
                                        });
                                        return ranked.map(row => ({ ...row, entity_id: scopedEntityId }));
                                    }),
                                );

                                scored = rankerResultsByEntity.flat();
                                const scoredIds = new Set(scored.map(s => s.id));
                                const metadataById = new Map(
                                    (candidateRows as ReadCandidateRowMetadata[])
                                        .filter(row => scoredIds.has(row.id))
                                        .map(row => [row.id, row])
                                );

                                scored = scored.map(row => {
                                    const metadata = metadataById.get(row.id);
                                    return { ...row, updated_at: metadata?.updated_at ?? null, access_count: metadata?.access_count ?? null };
                                });

                                const isHybrid = weight !== undefined && weight < 1;
                                const maxBackfill = isHybrid ? maxResults : Math.max(0, maxResults - scored.length);

                                if (maxBackfill > 0) {
                                    if (isHybrid) {
                                        type CandidateRow = typeof candidateRows[number];
                                        const topK: Array<{ row: CandidateRow; kwScore: number }> = [];

                                        for (const row of candidateRows) {
                                            if (scoredIds.has(row.id)) continue;
                                            const kwScore = miniSearchScores?.get(row.id) ?? 0;
                                            const candidate = { row, kwScore };

                                            if (topK.length < maxBackfill) {
                                                let insertIdx = topK.length;
                                                for (let i = 0; i < topK.length; i++) {
                                                    const cmp = this._compareScoredRows(
                                                        { id: candidate.row.id, score: candidate.kwScore, updated_at: candidate.row.updated_at, access_count: candidate.row.access_count },
                                                        { id: topK[i].row.id, score: topK[i].kwScore, updated_at: topK[i].row.updated_at, access_count: topK[i].row.access_count }
                                                    );
                                                    if (cmp < 0) { insertIdx = i; break; }
                                                }
                                                topK.splice(insertIdx, 0, candidate);
                                            } else {
                                                const cmpWorst = this._compareScoredRows(
                                                    { id: candidate.row.id, score: candidate.kwScore, updated_at: candidate.row.updated_at, access_count: candidate.row.access_count },
                                                    { id: topK[maxBackfill - 1].row.id, score: topK[maxBackfill - 1].kwScore, updated_at: topK[maxBackfill - 1].row.updated_at, access_count: topK[maxBackfill - 1].row.access_count }
                                                );
                                                if (cmpWorst < 0) {
                                                    let insertIdx = maxBackfill - 1;
                                                    for (let i = 0; i < topK.length; i++) {
                                                        const cmp = this._compareScoredRows(
                                                            { id: candidate.row.id, score: candidate.kwScore, updated_at: candidate.row.updated_at, access_count: candidate.row.access_count },
                                                            { id: topK[i].row.id, score: topK[i].kwScore, updated_at: topK[i].row.updated_at, access_count: topK[i].row.access_count }
                                                        );
                                                        if (cmp < 0) { insertIdx = i; break; }
                                                    }
                                                    topK.splice(insertIdx, 0, candidate);
                                                    topK.pop();
                                                }
                                            }
                                        }

                                        for (const { row, kwScore } of topK) {
                                            scored.push({ id: row.id, entity_id: row.entity_id, score: (1 - weight) * kwScore, updated_at: row.updated_at, access_count: row.access_count });
                                        }
                                    } else {
                                        const omitted: Array<{ id: string; entity_id: string; score: number; updated_at: number | null; access_count: number | null }> = [];
                                        for (const row of candidateRows) {
                                            if (scoredIds.has(row.id)) continue;
                                            omitted.push({ id: row.id, entity_id: row.entity_id, score: -2, updated_at: row.updated_at, access_count: row.access_count });
                                        }
                                        if (omitted.length > 0) {
                                            this._tieBreakSort(omitted);
                                            scored.push(...omitted.slice(0, maxBackfill));
                                        }
                                    }
                                }
                            } catch (rankerErr) {
                                const rankerError = rankerErr instanceof Error ? rankerErr : new Error(String(rankerErr));
                                const policy = this.options.vectorRankerFallback ?? 'js-cosine';
                                this.options.onVectorRankerFallback?.({ error: this._sanitizeRankerError(rankerError), policy });

                                if (policy === 'throw') {
                                    rankerShouldRethrow = true;
                                    throw rankerError;
                                } else if (policy === 'js-cosine') {
                                    let fallbackRows = candidateRows;
                                    if (fallbackRows && fallbackRows.length > 0 && !('embedding_blob' in fallbackRows[0])) {
                                        const rowIds = fallbackRows.map(r => r.id);
                                        const embeddingRows = await this.entryRepo.findEmbeddingsByIds(rowIds);
                                        const embeddingsMap = new Map(embeddingRows.map(row => [row.id, row]));
                                        fallbackRows = fallbackRows.map(r => ({
                                            ...r,
                                            embedding_blob: embeddingsMap.get(r.id)?.embedding_blob ?? null,
                                            embedding: embeddingsMap.get(r.id)?.embedding ?? null,
                                        })) as ReadCandidateRowWithEmbeddings[];
                                    }
                                    scored = await this.searchService.rankSemantic({
                                        entityId: entityCacheKey, queryVec, candidateRows: fallbackRows as ReadCandidateRowWithEmbeddings[], weight, miniSearchScores, populateCache, limit: fallbackRows.length, skipSort: true,
                                    });
                                } else if (policy === 'keyword') {
                                    const keywordOversampledLimit = Math.max(maxResults * 2, maxResults + 50);
                                    const topResults = this.searchService.searchKeyword(trimmedQuery, scoredEntityIds, keywordOversampledLimit);
                                    const topResultIds = new Set(topResults.map(r => r.id));
                                    const candidateMap = new Map(candidateRows.filter(r => topResultIds.has(r.id)).map(row => [row.id, row]));
                                    
                                    scored = topResults.map(result => {
                                        const metadata = candidateMap.get(result.id);
                                        const entityForScore = metadata?.entity_id ?? (result as unknown as { entity_id: string }).entity_id ?? '';
                                        return { id: result.id, entity_id: entityForScore, score: result.score ?? 0, access_count: metadata?.access_count ?? null, updated_at: metadata?.updated_at ?? null };
                                    });
                                } else {
                                    scored = [];
                                }

                                if (this.options.propagateRankerFailureToRetrievalFallback) {
                                    pendingRankerFallbackError = new Error('Vector ranker failed, falling back', { cause: this._sanitizeRankerError(rankerErr) });
                                }
                            }
                        } else {
                            const jsCosineNeedsTierSort = sanitizedTierWeights !== undefined && Object.values(sanitizedTierWeights).some(w => w !== 1);
                            scored = await this.searchService.rankSemantic({
                                entityId: entityCacheKey, queryVec, candidateRows: candidateRows as ReadCandidateRowWithEmbeddings[], weight, miniSearchScores, populateCache, limit: jsCosineNeedsTierSort ? candidateRows.length : maxResults, skipSort: jsCosineNeedsTierSort,
                            });
                        }

                        if (scored.length > 0) {
                            scored = scored.map(row => ({
                                ...row,
                                score: applyTierWeight(row.score, row.entity_id, sanitizedTierWeights),
                            }));
                            
                            this._tieBreakSort(scored);
                            
                            const selectedScored = scored.slice(0, maxResults);
                            const topIds = selectedScored.map(s => s.id);

                            if (exposeMetadata && trimmedQuery) {
                                scoreByFactId = new Map(selectedScored.map(s => [s.id, Number.isFinite(s.score) ? s.score : 0]));
                            }

                            if (topIds.length > 0) {
                                const facts2 = await this._hydrateFactsByIds(topIds, entityIds);
                                if (facts2.length < topIds.length) {
                                    const hydrationById = new Set(facts2.map(f => f.id));
                                    const missingIds = topIds.filter(id => !hydrationById.has(id));
                                    const missingCount = missingIds.length;
                                    const sample = missingIds.slice(0, 5);
                                    const sampleSuffix = sample.length > 0 ? ` Missing ID sample: ${sample.join(', ')}${missingIds.length > sample.length ? ', ...' : ''}.` : '';
                                    const error = new Error(`Phase 2 fact hydration returned ${missingCount} fewer row(s) than ranked IDs. ` +
                                        `Rows may have been concurrently soft-deleted or filtered by deleted_at during hydration, ` +
                                        `or vector ranker output may include IDs that do not exist in requested entities.` + sampleSuffix);
                                    this.options.onRetrievalFallback?.(error);
                                }
                                facts = facts2;
                            }

                            if (pendingRankerFallbackError) {
                                this.options.onRetrievalFallback?.(pendingRankerFallbackError);
                                pendingRankerFallbackError = undefined;
                            }
                            usedEmbed = true;
                        } else {
                            if (pendingRankerFallbackError) {
                                this.options.onRetrievalFallback?.(pendingRankerFallbackError);
                                pendingRankerFallbackError = undefined;
                            }
                            usedEmbed = true;
                        }
                    }
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    if (rankerShouldRethrow) throw error;
                    if (pendingRankerFallbackError) {
                        (error as any).cause = pendingRankerFallbackError;
                        pendingRankerFallbackError = undefined;
                    }
                    this.options.onRetrievalFallback?.(error);
                }
            }

            if (!usedEmbed && scoredEntityIds.length > 0) {
                const fallbackOversampledLimit = Math.max(maxResults * 2, maxResults + 50);
                const results = this.searchService.searchKeyword(trimmedQuery, scoredEntityIds, fallbackOversampledLimit);
                const candidates = results.map(r => ({
                    id: r.id as string,
                    entity_id: (r as unknown as { entity_id: string }).entity_id,
                    score: applyTierWeight(r.score ?? 0, (r as unknown as { entity_id: string }).entity_id, sanitizedTierWeights),
                    updated_at: null as number | null,
                    access_count: null as number | null,
                }));
                this._tieBreakSort(candidates);
                
                const topCandidates = candidates.slice(0, maxResults);
                const topIds = topCandidates.map(c => c.id);
                if (topIds.length > 0) {
                    facts = await this._hydrateFactsByIds(topIds, entityIds);
                    if (exposeMetadata) {
                        scoreByFactId = new Map(topCandidates.map(c => [c.id, Number.isFinite(c.score) ? c.score : 0]));
                    }
                }
            }

            if (facts.length > 0) {
                const ids = facts.map(f => f.id);
                await this.entryRepo.trackAccess(ids, Date.now());
            }

        } else {
            facts = await this.entryRepo.findRecentByEntityIds(entityIds, maxResults);
        }

        const eventsLimit = Math.min(10 * entityIds.length, 100);
        const [tasks, events] = await Promise.all([
            this.taskRepo.findAllPending(entityIds as string[], entityIds.length === 1 ? undefined : Math.min(20 * entityIds.length, 200)),
            entityIds.length === 1 ? this.eventRepo.getRecent(entityIds[0], eventsLimit) : this.eventRepo.getRecentForEntities(entityIds as string[], eventsLimit),
        ]);

        let factScores: Record<string, number> | undefined;
        if (exposeMetadata && trimmedQuery && scoreByFactId) {
            factScores = Object.fromEntries(facts.map(fact => [fact.id, scoreByFactId!.get(fact.id) ?? 0]));
        }

        const bundle: MemoryBundle = { facts, tasks, events: events.reverse() };
        if (exposeMetadata) {
            bundle.metadata = { query, entityIds };
            if (sanitizedTierWeights && Object.keys(sanitizedTierWeights).length > 0) bundle.metadata.tierWeights = sanitizedTierWeights;
            if (factScores && Object.keys(factScores).length > 0) bundle.factScores = factScores;
        }

        return bundle;
    }

    private _filterScoredEntities(entityIds: readonly string[], sanitizedTierWeights: Record<string, number> | undefined, includeZeroWeightEntities?: boolean): string[] {
        return entityIds.filter(id => {
            const w = sanitizedTierWeights?.[id] ?? 1;
            return includeZeroWeightEntities === true || w !== 0;
        });
    }

    private _tieBreakSort<T extends { id: string; score: number; updated_at?: number | null; access_count?: number | null }>(items: T[]): void {
        items.sort((a, b) => this._compareScoredRows(a, b));
    }

    private _compareScoredRows(a: { id: string; score: number; updated_at?: number | null; access_count?: number | null }, b: { id: string; score: number; updated_at?: number | null; access_count?: number | null }): number {
        const scoreDiff = b.score - a.score;
        if (!Number.isNaN(scoreDiff) && scoreDiff !== 0) return scoreDiff;
        
        const accessCountDiff = (b.access_count ?? 0) - (a.access_count ?? 0);
        if (accessCountDiff !== 0) return accessCountDiff;
        
        const updatedAtDiff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
        if (updatedAtDiff !== 0) return updatedAtDiff;
        
        return a.id.localeCompare(b.id);
    }

    private async _hydrateFactsByIds(ids: readonly string[], scopedEntityIds?: readonly string[], tx?: SQLiteAdapter): Promise<WikiFact[]> {
        return this.entryRepo.findByIds(ids, scopedEntityIds, tx);
    }

    private _sanitizeRankerError(err: unknown): Error {
        if (this.options.sanitizeRankerErrors === false) {
            return err instanceof Error ? err : new Error(String(err));
        }
        const typeName = err instanceof Error ? (err.constructor?.name ?? 'Error') : typeof err;
        const innerCause = err instanceof Error && err.cause !== undefined ? new Error(`Caused by: ${(err.cause as Error)?.constructor?.name ?? typeof err.cause}`) : undefined;
        const sanitized = new Error(`VectorRanker ${typeName} (message scrubbed for security)`, innerCause ? { cause: innerCause } : undefined);
        sanitized.name = typeName;
        return sanitized;
    }

    private async _rankWithVectorRanker(args: { entityId: string; queryVec: Float32Array | number[]; candidateIds: readonly string[] | undefined; candidateRows: ReadCandidateRowMetadata[]; weight: number | undefined; miniSearchScores: Map<string, number> | undefined; limit: number; }): Promise<Array<{ id: string; entity_id: string; score: number }>> {
        const { entityId, candidateIds, candidateRows, weight, miniSearchScores, limit } = args;
        const ranker = this.options.vectorRanker;
        if (!ranker) throw new Error('vectorRanker not configured');

        const queryVecCopy = args.queryVec instanceof Float32Array ? args.queryVec.slice() : Array.from(args.queryVec);
        const rankerResults = await ranker.rankBySimilarity({ entityId, queryVec: queryVecCopy, candidateIds, limit });

        const allowedIds = new Set(candidateRows.map(row => row.id));
        const seen = new Set<string>();
        const normalized: typeof rankerResults = [];

        for (const r of rankerResults) {
            if (normalized.length >= limit) break;
            if (seen.has(r.id)) continue;
            if (allowedIds && !allowedIds.has(r.id)) continue;
            if (!Number.isFinite(r.semanticScore)) continue;
            seen.add(r.id);
            normalized.push(r);
        }

        const entityIdByCandidateId = new Map(candidateRows.map(row => [row.id, row.entity_id]));
        const scored = normalized.map(r => {
            let score = r.semanticScore;
            if (weight !== undefined) {
                const kwScore = miniSearchScores?.get(r.id) ?? 0;
                score = weight * Math.max(0, r.semanticScore) + (1 - weight) * kwScore;
            }
            return { id: r.id, entity_id: entityIdByCandidateId.get(r.id)!, score };
        });

        return scored;
    }
}
```

---

### 2. Update `WikiMemory.ts`

Now, wire the new `RetrievalService` into the main class and delegate the `read` method.

**In the Class definition:**

TypeScript

```
import { RetrievalService } from './services/RetrievalService';

export class WikiMemory {
    // ... existing repos ...
    private importExportService: ImportExportService;
    private retrievalService: RetrievalService;
    // ...
```

**In the constructor:**

TypeScript

```
        // ... previous service initializations ...
        
        this.retrievalService = new RetrievalService(
            this.options,
            this.entryRepo,
            this.taskRepo,
            this.eventRepo,
            this.metadataRepo,
            this.searchService
        );

        // ... Ingestion and Maintenance initializations ...
```

**Replace the `read()` method:**

TypeScript

```
    async read(entityId: string | string[], query: string, options?: ReadOptions): Promise<MemoryBundle> {
        return this.retrievalService.read(entityId, query, options);
    }
```

---

That is a huge win for readability. `WikiMemory.ts` should now be under 800 lines! Should we extract the `EmbeddingService` next so we can fully unbind those raw methods?

Here is the final piece of the puzzle: extracting `WriteService`. This pulls out the event writing logic, the atomic checkpoint tracking, and the orchestration of when to trigger the Librarian and Heal background jobs.

### 1. Create `src/services/WriteService.ts`

This service needs access to the database adapter (for transactions), the event and metadata repositories, the job manager, and the maintenance service (to actually run the jobs it decides to trigger).

TypeScript

```
import type { SQLiteAdapter } from '../types';
import { WikiOptions, WikiEvent, WikiBusyError } from '../types';
import { EventRepository } from '../repositories/EventRepository';
import { MetadataRepository } from '../repositories/MetadataRepository';
import { JobManager } from './JobManager';
import { MaintenanceService } from './MaintenanceService';
import { generateId } from '../utils/ids';

export class WriteService {
    constructor(
        private db: SQLiteAdapter,
        private options: WikiOptions,
        private eventRepo: EventRepository,
        private metadataRepo: MetadataRepository,
        private jobManager: JobManager,
        private maintenanceService: MaintenanceService
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

        // Wrap in transaction to ensure Event + Checkpoint logic is atomic
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
                // Race: lock acquired between isBlocked check and acquireLock — roll back
                // checkpoint so the next event batch can retrigger librarian.
                await this.metadataRepo.updateCheckpoint(entityId, { memory: prevMemoryCheckpoint }, this.db);
            }
        }
    }

    private async runLibrarianThenMaybeHeal(entityId: string, currentEventCount: number): Promise<void> {
        await this.maintenanceService.doRunLibrarian(entityId);

        const autoHealThreshold = this.options.config?.autoHealThreshold || 100;

        // Read the latest heal checkpoint after librarian work finishes so the heal
        // decision reflects any concurrent checkpoint changes (e.g. from forget).
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
```

---

### 2. Final Update to `WikiMemory.ts`

Now, wire the `WriteService` into `WikiMemory.ts`. Because you’ve successfully stripped out almost all the domain logic, the file becomes a beautifully clean orchestrator.

**Add it to your imports and class definition:**

TypeScript

```
import { WriteService } from './services/WriteService';

export class WikiMemory {
    // ... all other dependencies ...
    private writeService: WriteService;
```

**Initialize it at the end of your constructor:**

TypeScript

```
        // ... previous service initializations ...

        this.writeService = new WriteService(
            this.db,
            this.options,
            this.eventRepo,
            this.metadataRepo,
            this.jobManager,
            this.maintenanceService
        );
```

**Replace the `write` and `runLibrarianThenMaybeHeal` methods:**

TypeScript

```
    async write(entityId: string, event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>): Promise<void> {
        return this.writeService.write(entityId, event);
    }
    
    // (You can completely delete runLibrarianThenMaybeHeal from WikiMemory.ts since it's private to the WriteService now)
```


### The Pragmatic Test Boundary

In a purist architecture, tests only interact with the public API (black-box testing). However, for a state-heavy orchestrator like `WikiMemory`, running full end-to-end integration tests to trigger background jobs can lead to slow, brittle, or overly complex test suites.

Since you already use an `export const __testables` pattern at the bottom of `WikiMemory.ts` for pure functions, extending that philosophy to your services is the cleanest, most pragmatic approach.

Here is how I recommend handling the strictness of that boundary:

* **Make the Service Methods Public to the Package, but Hidden from the Facade:** Rename `_doRunLibrarian` to `doRunLibrarian` (removing the underscore) and make it a standard `public` method on `MaintenanceService`. However, **do not** expose it on the `WikiMemory` public interface. Let `WriteService` call it natively.
* **Create a `__testAccess` Getter:**
Instead of having your tests cast `(wikiMemory as any).importExportService` to monkey-patch methods, create a dedicated, explicit escape hatch on the `WikiMemory` class.

**Example Implementation in `WikiMemory.ts`:**

```typescript
    /**
     * EXPLICIT ESCAPE HATCH FOR TEST SUITES ONLY.
     * Exposes internal services for targeted unit testing and mocking 
     * without polluting the public API boundary.
     */
    get __testAccess() {
        if (process.env.NODE_ENV !== 'test') {
            console.warn('Warning: __testAccess is being called outside of a test environment.');
        }
        return {
            importExportService: this.importExportService,
            maintenanceService: this.maintenanceService,
            writeService: this.writeService,
            retrievalService: this.retrievalService
        };
    }

```

### Why this is the best path:

1. **Type Safety in Tests:** Your tests get full autocomplete and type safety when accessing `wikiMemory.__testAccess.maintenanceService.doRunLibrarian`.
2. **Pristine Public API:** Consumers of the library aren't confused by `_doRunHeal()` appearing in their IDE's IntelliSense for `WikiMemory`.
3. **Clear Intent:** It explicitly signals to future maintainers that these boundaries are intentionally porous *only* for the test runner.
