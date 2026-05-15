# Spec: Phase 3 — Service Layer Extraction & Concurrency Decoupling

**Date:** May 15, 2026
**Status:** Draft
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

  /** * Attempts to acquire a lock for a specific operation.
   * Throws WikiBusyError if a conflicting job is running.
   */
  acquireLock(operation: 'prune' | 'librarian' | 'heal' | 'ingest' | 'reembed' | 'import' | 'forget', entityId: string): void {
    // ... logic ported from runPrune / ingestDocument etc.
    // e.g., cross-checking reembed vs global import locks
  }

  releaseLock(operation: string, entityId: string): void {
    // ... removes the key and notifies subscribers
  }

  getEntityStatus(entityId: string): EntityStatus { ... }
  
  subscribeEntityStatus(entityId: string, callback: (status: EntityStatus) => void): () => void { ... }
}

```

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
    this.jobManager.acquireLock('ingest', entityId);
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

1. Extract `chunkText`, `withConcurrency`, and parsing utilities (`parseJsonResponse`, `clip`, `validateFact`) into a `utils/` or `parsers/` directory.
2. Create `JobManager.ts`. Move the sets, locking logic, and `subscribeEntityStatus` logic here.
3. Update `WikiMemory` to delegate to `this.jobManager` instead of managing `activeMaintenanceJobs` internally.

### PR 2: Domain Services (`IngestionService` & `MaintenanceService`)

1. Create `IngestionService.ts`. Move `ingestDocument` and its associated types into this class.
2. Create `MaintenanceService.ts`. Move `runPrune`, `runLibrarian`, `runHeal`, `runReembed`, and `forget` into this class.
3. Update `WikiMemory.ts` to instantiate these services in the constructor and act as a simple pass-through facade for the public API.