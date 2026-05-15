# Spec: Phase 2.5 — Decoupling Side Effects (SearchService)

**Date:** May 15, 2026
**Status:** Approved for Implementation
**Scope:** Extract in-memory indexing (`MiniSearch`) and embedding cache management (`vectorCache`) from `WikiMemory` into a dedicated `SearchService`. Execute via two parallel pull requests to separate core logic implementation from orchestration wiring.

---

## 1. Background & Motivation

`WikiMemory` currently shoulders the burden of orchestrating business logic alongside managing in-memory search states. This violates the Single Responsibility Principle and bloats the class with low-level cache math.

While extracting this state is necessary, `WikiMemory`'s background tasks (like `_doRunHeal` and `ingestDocument`) rely on a highly intentional order of operations to prevent race conditions (e.g., clearing the cache before an embedding loop, then clearing it again afterward). Therefore, this refactor must precisely swap out the underlying state management without altering the orchestrator's carefully tuned execution flow.

---

## 2. The `SearchService` Abstraction

Create a new domain service responsible exclusively for in-memory text indexing, vector caching, and fallback similarity math.

### Responsibilities

| **Responsibility** | **Description** |
| --- | --- |
| **Keyword Indexing** | Wrapping `MiniSearch` initialization, document formatting, and index rebuilds via the injected `EntryRepository`. |
| **Vector Caching** | Managing the LRU-style `vectorCache`, handling dimension parsing, and enforcing the `MAX_VECTOR_CACHE_ENTITIES` caps. |
| **Similarity Math** | Executing in-process cosine similarity and applying hybrid keyword blending logic. |

### Proposed Interface: `SearchService.ts`

```typescript
export class SearchService {
  private miniSearch: MiniSearch<any>;
  private miniSearchEntryIdsByEntity: Map<string, Set<string>>;
  private vectorCache: Map<string, Map<string, Float32Array>>;
  
  // Only requires EntryRepository to fetch text for the MiniSearch index rebuilds
  constructor(private entryRepo: EntryRepository) {
    // Initialize Maps and MiniSearch here
  }

  /**
   * Rebuilds the search index and clears the vector cache for a given entity.
   * A direct replacement for: await rebuildMiniSearchIndex(id); vectorCache.delete(id);
   */
  async sync(entityId?: string): Promise<void> {
    await this.rebuildIndex(entityId);
    this.evictCache(entityId);
  }

  // Pure invalidation for mid-loop or post-loop flushes
  evictCache(entityId?: string): void { ... }
  clearAll(): void { ... }

  // Search logic exposed to WikiMemory
  searchKeyword(query: string, entityIds: string[], limit: number): SearchResult[] { ... }
  
  // Accepts pre-fetched DB rows from WikiMemory to keep DB logic out of this service
  async rankSemantic(args: {
    entityId: string;
    queryVec: Float32Array | number[];
    candidateRows: ReadCandidateRowWithEmbeddings[];
    weight: number | undefined;
    miniSearchScores: Map<string, number> | undefined;
    populateCache: boolean;
    limit: number;
    skipSort?: boolean;
  }): Promise<ScoredRow[]> { ... }
  
  private async rebuildIndex(entityId?: string): Promise<void> { ... }
}

```

---

## 3. Refactoring `WikiMemory`

With `SearchService` handling the memory state, `WikiMemory` delegates all internal ranking and cache invalidation while remaining the authoritative transaction orchestrator.

### 3.1 Precision Timing for Side Effects

The `sync()` and `evictCache()` methods must act as strict 1:1 drop-in replacements for the current manual calls to prevent concurrency bugs.

**Example Pattern (e.g., `_doRunLibrarian` or `ingestDocument`):**

```typescript
// 1. Commit Database Changes
await this.db.withTransactionAsync(async (tx) => { ... });

// 2. Synchronize In-Memory Search State immediately so concurrent reads see new text
await this.searchService.sync(entityId);

// 3. Execute Slow External Hooks / Embedding Loop
for (const fact of insertedFacts) {
  await this.embedFact(fact);
}

// 4. Secondary Flush: Evict any cache entries a concurrent read repopulated during step 3
this.searchService.evictCache(entityId);

```

### 3.2 The `read()` Method Delegation

`WikiMemory` maintains control over DB fetching and external ranker routing to preserve boundaries:

1. **Candidate Fetching:** `WikiMemory` queries `EntryRepository` to get hydrated `ReadCandidateRowWithEmbeddings[]`.
2. **Routing:** `WikiMemory` decides whether to pass those candidates to the external `vectorRanker` hook or route them internally.
3. **Fallback Delegation:** If using internal scoring, `WikiMemory` passes the raw candidate rows directly into `this.searchService.rankSemantic(...)`.

---

## 4. Execution Strategy & Rollout (Parallel PRs)

To accelerate delivery and simplify code reviews, this refactor will be split into two parallel Pull Requests. **PR 1** establishes the standalone service and its tests, while **PR 2** wires it into the existing orchestrator.

*(Note: PR 2 can be developed concurrently by pointing to the branch for PR 1, but PR 1 must be merged into `main` first).*

### PR 1: Domain Logic Extraction (`SearchService.ts` & Tests)

**Goal:** Build and thoroughly test the isolated `SearchService` without touching `WikiMemory`.

1. **Create the Service:** Scaffold `SearchService.ts`.
2. **Migrate State Management:** Move `MAX_VECTOR_CACHE_ENTITIES`, `MAX_VECTOR_CACHE_FACTS_PER_ENTITY`, `miniSearch`, and `vectorCache` maps into the new class.
3. **Migrate Pure Logic:** Move the pure math functions (`parseEmbedding`, `cosineSimilarity`, `_rankWithJsCosine`, `normalizeMiniSearchRow`) from `WikiMemory` into `SearchService`.
4. **Implement API:** Flesh out `sync()`, `evictCache()`, `searchKeyword()`, and `rankSemantic()`.
5. **Write Tests:** Add comprehensive unit tests for `SearchService.ts`. Specifically, test that the LRU cache eviction respects `MAX_VECTOR_CACHE_ENTITIES` limits and verify that the cosine similarity fallback math yields identical results to previous implementations.

### PR 2: Orchestration Wiring & Cleanup (`WikiMemory.ts` Integration)

**Goal:** Strip the old state logic from `WikiMemory` and replace it with `SearchService` delegations.

1. **Dependency Injection:** Instantiate `SearchService` in the `WikiMemory` constructor, passing in `this.entryRepo`.
2. **Targeted Find-and-Replace (Write Paths):** Audit all mutating methods (`_doRunHeal`, `_doRunLibrarian`, `ingestDocument`, `forget`, `importDump`, `runReembed`, `runPrune`). Swap `this.miniSearch` updates and `this.vectorCache.delete()` calls for `await this.searchService.sync(entityId)` or `this.searchService.evictCache(entityId)`, strictly preserving their current line placements.
3. **Targeted Find-and-Replace (Read Path):** Update `read()` to route keyword and JS-cosine fallback queries through `searchService.searchKeyword()` and `searchService.rankSemantic()`.
4. **Cleanup & Test Updates:** Delete the obsolete constants, sets, and math methods from `WikiMemory.ts`. Update existing `WikiMemory` tests to mock or accommodate the new `SearchService` boundary.