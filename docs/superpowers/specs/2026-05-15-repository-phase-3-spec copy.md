# Spec: Phase 3 — Service Layer Extraction & Concurrency Decoupling

**Date:** May 15, 2026
**Status:** Approved
**Scope:** Extract the remaining business logic—LLM orchestration, maintenance workflows, and concurrency locking—out of `WikiMemory` into dedicated domain services (`IngestionService`, `MaintenanceService`) and a `JobManager`.

---

## 1. Background & Motivation

Phases 2 and 2.5 successfully extracted the data access layer (Repositories, Outbox) and in-memory indexing (`SearchService`). However, looking at the `staging` branch, `WikiMemory.ts` is still approximately 2,700 lines long.

It currently violates the Single Responsibility Principle by acting as:

1. **An LLM Orchestrator:** Formatting prompts, calling the LLM, and parsing JSON arrays for ingestion, healing, and librarian tasks.
2. **A Mutex Lock Manager:** Manually checking and setting string keys in `activeMaintenanceJobs` and `activeIngestJobs` (triggering `WikiBusyError`) across almost every public method.
3. **A Pub/Sub Broker:** Managing `statusSubscribers` and broadcasting state transitions.

Phase 3 will strip `WikiMemory` down to a clean Facade/API layer by migrating these responsibilities into domain-specific classes.

---

## 2. Component 1: `JobManager` (Concurrency & Status)

Currently, locking logic is heavily duplicated. Every operation manually constructs keys (e.g., `this._pruneKey(entityId)`), checks multiple sets, and throws a `WikiBusyError`.

We will extract this into a `JobManager` to centralize mutex locking and status broadcasting.

### Responsibilities

* Maintain the `activeMaintenanceJobs` and `activeIngestJobs` sets.
* Provide unified lock acquisition methods that throw `WikiBusyError` automatically if a conflict is detected.
* Manage the `statusSubscribers` map and emit events when entity statuses (`ingesting`, `librarian`, `heal`) change.

### Proposed Interface

```typescript
export class JobManager {
  private activeMaintenanceJobs = new Set<string>();
  private activeIngestJobs = new Set<string>();
  private statusSubscribers = new Map<string, Set<SubscriberEntry>>();

  constructor(private prefix: string) {}

  private _pruneKey(entityId: string) { return `${this.prefix}:${entityId}:prune`; }
  private _reembedKey(entityId: string) { return `${this.prefix}:${entityId}:reembed`; }
  private _importKey(entityId: string) { return `${this.prefix}:${entityId}:import`; }
  private _globalReembedKey() { return `${this.prefix}:reembed`; }
  private _globalImportKey() { return `${this.prefix}:import`; }

  private _isIngestActiveFor(entityId: string): boolean {
    const ingestPrefix = `${this.prefix}:${entityId}:`;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(ingestPrefix)) return true;
    }
    return false;
  }

  /**
   * Attempts to acquire a lock for a specific operation.
   * Throws WikiBusyError if a conflicting job is running.
   */
  acquireLock(
    operation: 'prune' | 'librarian' | 'heal' | 'ingest' | 'reembed' | 'import' | 'forget',
    entityId: string,
    sourceRef?: string
  ): void {
    // 1. Global lock checks (e.g. global import or global reembed)
    if (this.activeMaintenanceJobs.has(this._globalImportKey())) {
      throw new WikiBusyError('import', '*');
    }

    // 2. Cross-entity prefix checks
    let blockingOperation: string | null = null;
    if (operation === 'prune') {
      if (this._isIngestActiveFor(entityId)) blockingOperation = 'ingest';
      else if (this.activeMaintenanceJobs.has(this._importKey(entityId))) blockingOperation = 'import';
      // ... other explicit conflicts
    }

    if (blockingOperation) {
      throw new WikiBusyError(blockingOperation, entityId);
    }

    // 3. Acquire the requested lock
    if (operation === 'ingest' && sourceRef) {
      this.activeIngestJobs.add(`${this.prefix}:${entityId}:${sourceRef}`);
    } else {
      // Add the standard maintenance key for the operation
    }

    // 4. Notify subscribers of status transition
    this._notifyStatusSubscribers(entityId);
  }

  releaseLock(operation: string, entityId: string): void {
    // ... removes the key and notifies subscribers
  }

  getEntityStatus(entityId: string): EntityStatus { ... }
  
  subscribeEntityStatus(entityId: string, callback: (status: EntityStatus) => void): () => void { ... }
}

```

By internalizing prefix generation and iteration, `WikiMemory` and the new domain services can simply call `this.jobManager.acquireLock('prune', entityId);` or `this.jobManager.acquireLock('ingest', entityId, sourceRef);` without needing to know how the lock keys are composed or how cross-entity conflicts are detected.

---

## 3. Component 2: `IngestionService`

Document ingestion is an isolated workflow containing chunking math, bounded concurrency loops, and LLM text generation.

### Responsibilities

* Chunking documents (moving `chunkText` and `withConcurrency` utilities out of the core file).
* Executing the `INGEST_SYSTEM_PROMPT` against the LLM provider.
* Parsing and validating the extracted facts.
* Coordinating with Repositories and `SearchService` to commit the results.

### Proposed Interface

```typescript
export class IngestionService {
  constructor(
    private entryRepo: EntryRepository,
    private searchService: SearchService,
    private jobManager: JobManager,
    private llmProvider: LLMProvider,
    private config: WikiOptions['config']
  ) {}

  async ingestDocument(entityId: string, params: IngestParams): Promise<{ truncated: boolean; chunks: number }> {
    this.jobManager.acquireLock('ingest', entityId, params.sourceRef);
    try {
      // ... chunking logic
      // ... concurrent LLM calls
      // ... DB transaction & searchService.sync()
    } finally {
      this.jobManager.releaseLock('ingest', entityId);
    }
  }
}

```

---

## 4. Component 3: `MaintenanceService`

This service will absorb the "background" lifecycle methods of the Wiki. These operations usually require wide data scans, LLM reasoning, or external hook syncing.

### Responsibilities

* **The Librarian:** `runLibrarian`, `_doRunLibrarian` (deduplication, event summarization).
* **Healing:** `runHeal`, `_doRunHeal` (orphaning, staleness downgrades, contradiction resolution).
* **Data Lifecycle:** `runPrune`, `forget`.
* **Vector Maintenance:** `runReembed`.

Moving these out of `WikiMemory` drastically reduces the cognitive load of the core module and localizes the complex transaction-plus-LLM execution chains.

---

## 5. The Refactored `WikiMemory` (The Facade)

Once Phase 3 is complete, `WikiMemory.ts` will transform from a monolithic god-class into a clean entry point.

Its primary responsibilities will be:

1. **Dependency Injection:** Instantiating the SQLite adapter, Repositories, `SearchService`, `JobManager`, `IngestionService`, and `MaintenanceService`.
2. **Core Read/Write:** Handling `read()` (which coordinates the `vectorRanker` and `SearchService`) and `write()` (which logs events and triggers auto-librarian thresholds).
3. **Delegation:** Forwarding calls like `wiki.ingestDocument(...)` to `this.ingestionService.ingestDocument(...)`.

---

## 6. Execution Strategy & PR Breakdown

To minimize merge conflicts and ensure stability, execute this refactor in two sequential Pull Requests.

### PR 1: Concurrency & Utilities (`JobManager`)

This PR is all about foundational cleanup. By extracting the pure functions and the complex locking matrix first, we significantly reduce the noise in `WikiMemory.ts`, paving the way for a much cleaner extraction of domain services in PR 2.

#### Step 1: Extract Pure Utilities

Create `packages/core/src/utils/pure.ts` (or a similarly named utilities file) before building `JobManager`. Cut the pure utility functions out of `WikiMemory.ts` (lines 40-192) and place them in a dedicated utilities file.

This includes:
  * `parseJsonResponse`
  * `safeSlice`
  * `chunkText`
  * `withConcurrency`
  * `clip`
  * `validateTags`, `validateFact`, `validateTask`
  * `normalizeSourceRef`, `normalizeSourceHash`
  * `titleTokens`, `jaccardScore`

Update imports in `WikiMemory.ts` accordingly.

* Action: Create `packages/core/src/utils/pure.ts` and move the pure helper functions there.
* Action: Update the imports in `WikiMemory.ts` and ensure the `__testables` export at the bottom of the file still functions correctly (or update tests to import directly from the new utils file).

#### Step 2: Implement `JobManager.ts`

Create `packages/core/src/services/JobManager.ts` to encapsulate all lock state and subscriber notifications.

* State to migrate from `WikiMemory`:
  * `activeMaintenanceJobs` (Set)
  * `activeIngestJobs` (Set)
  * `statusSubscribers` (Map)

* Internal helpers to migrate:
  * Key generators: `_pruneKey`, `_reembedKey`, `_globalReembedKey`, `_importKey`, `_globalImportKey`, `_forgetKey`, `_librarianKey`, `_healKey`
  * Status internals: `_copyEntityStatus`, `_notifyStatusSubscribers`, `_isIngestActiveFor`

* Public API to implement:
  * `acquireLock(operation: OperationType, entityId: string, sourceRef?: string): void`
    * Logic: Move the massive `if/else if` blocks currently found at the top of `runPrune`, `runReembed`, `importDump`, etc., into this centralized method. Throw `WikiBusyError` on conflict.
  * `releaseLock(operation: OperationType, entityId: string, sourceRef?: string): void`
  * `getEntityStatus(entityId: string): EntityStatus`
  * `subscribeEntityStatus(entityId: string, callback: (status: EntityStatus) => void): () => void`

Provide the exact implementation below so PR 1 can be executed directly from this branch.

```typescript
import { EntityStatus, WikiBusyError } from '../types';

export type OperationType = 
  | 'prune' 
  | 'librarian' 
  | 'heal' 
  | 'ingest' 
  | 'reembed' 
  | 'global_reembed' 
  | 'import' 
  | 'global_import' 
  | 'forget';

export class JobManager {
  private activeMaintenanceJobs = new Set<string>();
  private activeIngestJobs = new Set<string>();
  private statusSubscribers = new Map<
    string,
    Set<{ callback: (s: EntityStatus) => void; last: EntityStatus }>
  >();

  constructor(private prefix: string) {}

  // --- Internal Key Generators ---

  private _pruneKey(entityId: string) { return `${this.prefix}:${entityId}:prune`; }
  private _reembedKey(entityId: string) { return `${this.prefix}:${entityId}:reembed`; }
  private _globalReembedKey() { return `${this.prefix}:reembed`; }
  private _importKey(entityId: string) { return `${this.prefix}:${entityId}:import`; }
  private _globalImportKey() { return `${this.prefix}:import`; }
  private _forgetKey(entityId: string) { return `${this.prefix}:${entityId}:forget`; }
  private _librarianKey(entityId: string) { return `${this.prefix}:${entityId}:librarian`; }
  private _healKey(entityId: string) { return `${this.prefix}:${entityId}:heal`; }

  // --- Internal State Checks ---

  private _isReembedActive(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._reembedKey(entityId)) ||
           this.activeMaintenanceJobs.has(this._globalReembedKey());
  }

  private _isImportActiveFor(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._importKey(entityId)) ||
           this.activeMaintenanceJobs.has(this._globalImportKey());
  }

  private _isForgetActiveFor(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._forgetKey(entityId));
  }

  private _isAnyMaintenanceActiveWithSuffix(suffix: string): boolean {
    const entityKeyPrefix = `${this.prefix}:`;
    for (const k of this.activeMaintenanceJobs) {
      if (k.startsWith(entityKeyPrefix) && k.endsWith(suffix)) return true;
    }
    return false;
  }

  private _isIngestActiveFor(entityId: string): boolean {
    const entityKeyPrefix = `${this.prefix}:${entityId}:`;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(entityKeyPrefix)) return true;
    }
    return false;
  }

  // --- Public Lock API ---

  acquireLock(operation: OperationType, entityId: string, sourceRef?: string): void {
    let blockingOperation: string | null = null;

    // 1. Universal Global Checks (applies to almost all targeted actions)
    if (operation !== 'global_import' && this.activeMaintenanceJobs.has(this._globalImportKey())) {
      throw new WikiBusyError('import', '*');
    }

    // 2. Specific Cross-Entity & Operation Rules
    switch (operation) {
      case 'prune':
        if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) blockingOperation = 'librarian';
        else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) blockingOperation = 'heal';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isIngestActiveFor(entityId)) blockingOperation = 'ingest';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;

      case 'librarian':
      case 'heal':
        const opKey = operation === 'librarian' ? this._librarianKey(entityId) : this._healKey(entityId);
        if (this.activeMaintenanceJobs.has(opKey)) blockingOperation = operation;
        else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;

      case 'reembed':
        if (this.activeMaintenanceJobs.has(this._reembedKey(entityId))) blockingOperation = 'reembed';
        else if (this.activeMaintenanceJobs.has(this._globalReembedKey())) blockingOperation = 'reembed';
        else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) blockingOperation = 'librarian';
        else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) blockingOperation = 'heal';
        else if (this._isIngestActiveFor(entityId)) blockingOperation = 'ingest';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;

      case 'global_reembed':
        if (this.activeMaintenanceJobs.has(this._globalReembedKey())) blockingOperation = 'reembed';
        else if (this._isAnyMaintenanceActiveWithSuffix(':reembed')) blockingOperation = 'reembed';
        else if (this._isAnyMaintenanceActiveWithSuffix(':prune')) blockingOperation = 'prune';
        else if (this._isAnyMaintenanceActiveWithSuffix(':librarian')) blockingOperation = 'librarian';
        else if (this._isAnyMaintenanceActiveWithSuffix(':heal')) blockingOperation = 'heal';
        else if (this.activeIngestJobs.size > 0) blockingOperation = 'ingest';
        else if (this._isAnyMaintenanceActiveWithSuffix(':import')) blockingOperation = 'import';
        else if (this._isAnyMaintenanceActiveWithSuffix(':forget')) blockingOperation = 'forget';
        break;

      case 'import':
      case 'forget':
        const selfKey = operation === 'import' ? this._importKey(entityId) : this._forgetKey(entityId);
        if (this.activeMaintenanceJobs.has(selfKey)) blockingOperation = operation;
        else if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) blockingOperation = 'librarian';
        else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) blockingOperation = 'heal';
        else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isIngestActiveFor(entityId)) blockingOperation = 'ingest';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;

      case 'global_import':
        if (this.activeMaintenanceJobs.has(this._globalImportKey())) blockingOperation = 'import';
        break;

      case 'ingest':
        const ingestJobKey = `${this.prefix}:${entityId}:${sourceRef}`;
        if (this.activeIngestJobs.has(ingestJobKey)) blockingOperation = 'ingest';
        else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;
    }

    if (blockingOperation) {
      throw new WikiBusyError(
        blockingOperation, 
        operation === 'global_reembed' || operation === 'global_import' ? '*' : entityId
      );
    }

    // 3. Apply the Lock
    if (operation === 'ingest') {
      this.activeIngestJobs.add(`${this.prefix}:${entityId}:${sourceRef}`);
    } else if (operation === 'global_reembed') {
      this.activeMaintenanceJobs.add(this._globalReembedKey());
    } else if (operation === 'global_import') {
      this.activeMaintenanceJobs.add(this._globalImportKey());
    } else {
      const keyFnName = `_${operation}Key` as keyof this;
      const keyFn = this[keyFnName] as (id: string) => string;
      this.activeMaintenanceJobs.add(keyFn.call(this, entityId));
    }

    this._notifyStatusSubscribers(entityId);
  }

  releaseLock(operation: OperationType, entityId: string, sourceRef?: string): void {
    if (operation === 'ingest') {
      this.activeIngestJobs.delete(`${this.prefix}:${entityId}:${sourceRef}`);
    } else if (operation === 'global_reembed') {
      this.activeMaintenanceJobs.delete(this._globalReembedKey());
    } else if (operation === 'global_import') {
      this.activeMaintenanceJobs.delete(this._globalImportKey());
    } else {
      const keyFnName = `_${operation}Key` as keyof this;
      const keyFn = this[keyFnName] as (id: string) => string;
      this.activeMaintenanceJobs.delete(keyFn.call(this, entityId));
    }

    this._notifyStatusSubscribers(entityId);
  }

  // --- Status API ---

  getEntityStatus(entityId: string): EntityStatus {
    return {
      ingesting: this._isIngestActiveFor(entityId),
      librarian: this.activeMaintenanceJobs.has(this._librarianKey(entityId)),
      heal: this.activeMaintenanceJobs.has(this._healKey(entityId)),
    };
  }

  subscribeEntityStatus(entityId: string, callback: (status: EntityStatus) => void): () => void {
    const initial = this.getEntityStatus(entityId);
    let set = this.statusSubscribers.get(entityId);
    if (!set) {
      set = new Set();
      this.statusSubscribers.set(entityId, set);
    }
    
    const entry = { callback, last: this._copyEntityStatus(initial) };
    set.add(entry);
    
    try {
      callback(this._copyEntityStatus(initial));
    } catch (err) {
      console.error(`[JobManager] callback error for entityId="${entityId}" during initial emission`, err);
    }
    
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const s = this.statusSubscribers.get(entityId);
      if (!s) return;
      s.delete(entry);
      if (s.size === 0) this.statusSubscribers.delete(entityId);
    };
  }

  private _copyEntityStatus(s: EntityStatus): EntityStatus {
    return { ingesting: s.ingesting, librarian: s.librarian, heal: s.heal };
  }

  private _notifyStatusSubscribers(entityId: string): void {
    if (entityId === '*') return; // Globals don't trigger specific entity UI events directly here
    
    const set = this.statusSubscribers.get(entityId);
    if (!set || set.size === 0) return;
    
    for (const entry of Array.from(set)) {
      if (!set.has(entry)) continue;
      const next = this.getEntityStatus(entityId);
      
      if (entry.last.ingesting === next.ingesting &&
          entry.last.librarian === next.librarian &&
          entry.last.heal === next.heal) {
        continue;
      }
      
      entry.last = this._copyEntityStatus(next);
      try {
        entry.callback(this._copyEntityStatus(next));
      } catch (err) {
        console.error(`[JobManager] callback error for entityId="${entityId}" during transition emission`, err);
      }
    }
  }
}
```

#### Step 3: Wire `WikiMemory` to `JobManager`

With the manager built, gut the manual lock management from `WikiMemory`.

* Constructor: instantiate `this.jobManager = new JobManager(this.prefix);`
* Targeted find-and-replace (lock acquisition): audit `runPrune`, `runLibrarian`, `runHeal`, `runReembed`, `importDump`, `forget`, and `ingestDocument`; replace their sprawling conflict checks with a single call to `this.jobManager.acquireLock(...)`.
* Ensure the `finally` blocks call `this.jobManager.releaseLock(...)`.
* Targeted find-and-replace (status): delegate `getEntityStatus` and `subscribeEntityStatus` directly to `this.jobManager`.

#### Step 4: Verification & Testing

* Update any tests that mock or assert against `activeMaintenanceJobs` directly (if any) to interface with `JobManager` instead.
* Verify that concurrent calls to `ingestDocument` and `runPrune` for the same entity still correctly throw a `WikiBusyError`.

### PR 2: Domain Services (`IngestionService` & `MaintenanceService`)

Excellent. With the `JobManager` handling the complex concurrency matrix and the utilities out of the way, `WikiMemory.ts` is primed for the final extraction.

Here is the exact execution plan and implementation guide for **PR 2: Domain Services (`IngestionService` & `MaintenanceService`)**.

---

## PR 2 Spec: The Domain Services Extraction

**Goal:** Strip all LLM orchestration, background task logic, and database transaction loops out of `WikiMemory`, turning it into a clean, read/write Facade.

### Step 1: Create `packages/core/src/services/IngestionService.ts`

This service owns the `ingestDocument` pipeline. It relies entirely on the `JobManager` for lock acquisition.

```typescript
import { chunkText, withConcurrency, validateFact, parseJsonResponse } from '../utils/pure';
import { INGEST_SYSTEM_PROMPT } from '../prompts';
import { generateId } from '../utils/ids';
import { normalizeSourceRef, normalizeSourceHash } from '../utils/pure';
import type { WikiOptions, ExtractedFact, WikiFact } from '../types';
import type { SQLiteAdapter } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { SearchService } from './SearchService';
import type { JobManager } from './JobManager';

export class IngestionService {
  constructor(
    private db: SQLiteAdapter,
    private prefix: string,
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private searchService: SearchService,
    private jobManager: JobManager,
    private embedFactFn: (fact: { id: string; entity_id: string; title: string; body: string; tags: string | string[] }) => Promise<boolean>,
    private notifyPersistedFn: (entityId: string, factId: string, vector: Float32Array | null) => Promise<void>
  ) {}

  async ingestDocument(
    entityId: string,
    params: {
      sourceRef: string;
      sourceHash: string;
      documentChunk: string;
      maxChunkLength?: number;
      chunkOverlap?: number;
      chunkConcurrency?: number;
    }
  ): Promise<{ truncated: boolean; chunks: number }> {
    const sourceRef = normalizeSourceRef(params.sourceRef);
    if (!sourceRef) throw new Error('Invalid sourceRef');

    const sourceHash = normalizeSourceHash(params.sourceHash);
    if (!sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

    const maxChunkLength = params.maxChunkLength ?? this.options.config?.maxChunkLength ?? 12000;
    const rawOverlap = params.chunkOverlap ?? this.options.config?.chunkOverlap ?? 400;
    const chunkOverlap = Math.min(
      Number.isFinite(rawOverlap) && rawOverlap >= 0 ? Math.floor(rawOverlap) : 400,
      maxChunkLength - 1
    );

    const rawConcurrency = params.chunkConcurrency ?? this.options.config?.chunkConcurrency ?? 1;
    const chunkConcurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;

    if (typeof params.documentChunk !== 'string') {
      throw new Error(`documentChunk must be a string, received ${typeof params.documentChunk}`);
    }

    // 1. Lock Acquisition via JobManager
    this.jobManager.acquireLock('ingest', entityId, sourceRef);

    try {
      const { chunks, truncated } = chunkText(params.documentChunk, maxChunkLength, chunkOverlap);
      if (chunks.length === 0) return { truncated: false, chunks: 0 };

      // 2. LLM Processing
      const chunkResults = await withConcurrency(
        chunks.map((chunk) => async () => {
          const userPrompt = `Document Chunk:\n${chunk}`;
          const responseText = await this.options.llmProvider.generateText({
            systemPrompt: INGEST_SYSTEM_PROMPT,
            userPrompt,
          });
          const result = parseJsonResponse<{ facts: ExtractedFact[] }>(responseText);
          return (Array.isArray(result.facts) ? result.facts : [])
            .map(validateFact)
            .filter((f): f is ExtractedFact => f !== null);
        }),
        chunkConcurrency
      );

      const seen = new Set<string>();
      const allValidFacts: ExtractedFact[] = [];
      for (const facts of chunkResults) {
        for (const fact of facts) {
          const normalized = fact.title.trim().toLowerCase().replace(/\s+/g, ' ');
          if (!seen.has(normalized)) {
            seen.add(normalized);
            allValidFacts.push(fact);
          }
        }
      }

      const now = Date.now();
      const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
      const deletedSourceFactIds: string[] = [];

      // 3. Database Commit
      await this.db.withTransactionAsync(async (tx) => {
        deletedSourceFactIds.push(...(await this.entryRepo.findIdsBySource(entityId, sourceRef, null, tx, false)));
        await this.entryRepo.softDeleteBySource(entityId, tx, sourceRef, null);

        for (const fact of allValidFacts) {
          const id = generateId('fact_');
          const wikiFact: WikiFact = {
            id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
            source_type: 'immutable_document', source_hash: sourceHash, source_ref: sourceRef,
            created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
          };
          await this.entryRepo.upsert(wikiFact, tx);
          insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
        }
      });

      // 4. Cache Sync & Side Effects
      await this.searchService.sync(entityId);

      const uniqueDeletedSourceFactIds = Array.from(new Set(deletedSourceFactIds));
      for (const factId of uniqueDeletedSourceFactIds) {
        try {
          await this.notifyPersistedFn(entityId, factId, null);
        } catch (hookErr) {
          console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during ingest for ${factId}:`, hookErr);
        }
      }

      for (const fact of insertedFacts) {
        await this.embedFactFn(fact);
      }

      this.searchService.evictCache(entityId);
      return { truncated, chunks: chunks.length };

    } finally {
      // 5. Lock Release
      this.jobManager.releaseLock('ingest', entityId, sourceRef);
    }
  }
}
```

*(Note: We pass `embedFact` and `notifyPersisted` as callbacks in the constructor to avoid moving the highly specific vector-ranker hook logic out of `WikiMemory`'s direct control, keeping the service layers focused purely on the orchestration flow).* 

---

### Step 2: Create `packages/core/src/services/MaintenanceService.ts`

This service will absorb `runLibrarian`, `_doRunLibrarian`, `runHeal`, `_doRunHeal`, `runPrune`, `runReembed`, and `forget`.

Create the file and port those methods over. The structure is identical to `IngestionService`:

1. The constructor takes the required Repositories, the `SearchService`, the `JobManager`, and the `embedFactFn` / hook callbacks.
2. The massive lock-checking blocks at the top of each method are replaced with `this.jobManager.acquireLock('...', entityId);`.

*Example of how clean `forget` becomes:*

```typescript
async forget(entityId: string, params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean }): Promise<{ deleted: { entries: number; tasks: number } }> {
  // Was 20 lines of checks, now just one:
  this.jobManager.acquireLock('forget', entityId);
  try {
    // ... exact same database transaction logic ...
  } finally {
    this.jobManager.releaseLock('forget', entityId);
  }
}
```

---

### Step 3: Wire up `WikiMemory.ts` (The Facade)

Now, we gut the original implementation from `WikiMemory` and wire it up to our shiny new services.

1. **Imports & Properties:** Import the new services and add them as private properties.
2. **Constructor Initialization:**
```typescript
this.ingestionService = new IngestionService(
  this.db, this.prefix, this.options, this.entryRepo, this.searchService, this.jobManager,
  this.embedFact.bind(this), this._notifyEmbeddingPersisted.bind(this)
);

this.maintenanceService = new MaintenanceService(
  this.db, this.prefix, this.options, this.entryRepo, this.taskRepo, this.eventRepo, this.metadataRepo, this.searchService, this.jobManager,
  this.embedFact.bind(this), this._notifyEmbeddingPersisted.bind(this), this._notifyEmbeddingPersistedOrThrow.bind(this), this._reconcileEmbeddingDimension.bind(this)
);
```

3. **Delegation:** Replace the entire bodies of the public methods with pass-throughs.
```typescript
async ingestDocument(entityId: string, params: any) {
  return this.ingestionService.ingestDocument(entityId, params);
}

async runPrune(entityId: string, options?: any) {
  return this.maintenanceService.runPrune(entityId, options);
}

async runLibrarian(entityId: string) {
  return this.maintenanceService.runLibrarian(entityId);
}

async runHeal(entityId: string) {
  return this.maintenanceService.runHeal(entityId);
}

async runReembed(entityId?: string, opts?: any) {
  return this.maintenanceService.runReembed(entityId, opts);
}

async forget(entityId: string, params: any) {
  return this.maintenanceService.forget(entityId, params);
}
```

*(Note: Ensure you leave `read()`, `write()`, `importDump()`, and `exportDump()` in `WikiMemory.ts`, as they represent the core public data pathways and orchestrate the external hooks directly).*