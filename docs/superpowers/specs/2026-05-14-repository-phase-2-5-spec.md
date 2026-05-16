# Spec: Phase 2.5 — Decoupling Side Effects (SearchService)

**Date:** May 15, 2026
**Status:** Implemented
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
import MiniSearch, { SearchResult } from 'minisearch';
import { EntryRepository } from '../repositories/EntryRepository';
import { cosineSimilarity } from '../utils/cosine';
import { parseEmbedding } from '../utils/embedding';

export interface ScoredRow {
  id: string;
  entity_id: string;
  score: number;
  updated_at: number | null;
  access_count: number | null;
}

export interface RankSemanticArgs {
  entityId: string;
  queryVec: Float32Array | number[];
  candidateRows: Array<{
    id: string;
    entity_id: string;
    embedding_blob: Uint8Array | null;
    embedding: string | null;
    updated_at: number | null;
    access_count: number | null;
  }>;
  weight: number | undefined;
  miniSearchScores: Map<string, number> | undefined;
  populateCache: boolean;
  limit: number;
  skipSort?: boolean;
}

export class SearchService {
  /**
   * Maximum number of entities whose parsed embedding vectors are held in
   * memory. This cap is intentionally conservative so the cache remains safe
   * on memory-constrained runtimes (e.g., mobile/Expo).
   */
  private static readonly MAX_VECTOR_CACHE_ENTITIES = 16;

  /**
   * Maximum number of fact vectors cached per entity. Keep this high enough to
   * preserve the parsed-embedding reuse optimization for common mid-sized
   * entities while still maintaining a bounded memory footprint.
   */
  private static readonly MAX_VECTOR_CACHE_FACTS_PER_ENTITY = 500;

  private miniSearch: MiniSearch<{ id: string; entity_id: string; title: string; body: string; tags: string }>;
  private miniSearchEntryIdsByEntity = new Map<string, Set<string>>();
  private vectorCache: Map<string, Map<string, Float32Array>> = new Map();

  constructor(private entryRepo: EntryRepository) {
    this.miniSearch = new MiniSearch({
      fields: ['title', 'body', 'tags'],
      storeFields: ['entity_id'],
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  /**
   * Rebuilds the search index and clears the vector cache for a given entity.
   * A direct replacement for manually syncing state after a DB transaction.
   */
  async sync(entityId?: string): Promise<void> {
    await this.rebuildIndex(entityId);
    this.evictCache(entityId);
  }

  /**
   * Clears the parsed vector cache. Useful for mid-loop flush guarantees
   * or memory pressure evictions.
   */
  evictCache(entityId?: string): void {
    if (entityId) {
      this.vectorCache.delete(entityId);
    } else {
      this.vectorCache.clear();
    }
  }

  /**
   * Fully resets the search service.
   */
  clearAll(): void {
    this.vectorCache.clear();
    this.miniSearch.removeAll();
    this.miniSearchEntryIdsByEntity.clear();
  }

  /**
   * Executes a keyword search against the active MiniSearch index.
   */
  searchKeyword(query: string, entityIds: string[], limit: number): SearchResult[] {
    const entityIdSet = new Set(entityIds);
    const results = this.miniSearch.search(query, {
      filter: (r) => entityIdSet.has((r as unknown as { entity_id: string }).entity_id),
      combineWith: 'OR',
    });
    return results.slice(0, limit);
  }

  /**
   * Pre-fetches MiniSearch scores for candidate hydration, used during hybrid weighting.
   */
  getMiniSearchScores(query: string, entityIds: string[], preFilterLimit?: number): Map<string, number> {
    const entityIdSet = new Set(entityIds);
    let results = this.miniSearch.search(query, {
      filter: (r) => entityIdSet.has((r as unknown as { entity_id: string }).entity_id),
      combineWith: 'OR',
    });

    if (preFilterLimit !== undefined) {
      results = results.slice(0, preFilterLimit);
    }

    if (results.length === 0) return new Map();

    const maxMsScore = Math.max(1, results[0]?.score ?? 1);
    return new Map(results.map((r) => [r.id, r.score / maxMsScore]));
  }

  /**
   * Score candidate rows using in-process JS cosine similarity.
   * Applies hybrid blending (if weight set) and tie-break sorting before returning.
   */
  async rankSemantic(args: RankSemanticArgs): Promise<ScoredRow[]> {
    const queryVec = args.queryVec instanceof Float32Array ? args.queryVec.slice() : Array.from(args.queryVec);
    const { entityId, candidateRows, weight, miniSearchScores, populateCache, limit, skipSort } = args;

    let entityCache = this.vectorCache.get(entityId);
    const tooLarge = populateCache && candidateRows.length > SearchService.MAX_VECTOR_CACHE_FACTS_PER_ENTITY;

    if (tooLarge && entityCache) {
      this.vectorCache.delete(entityId);
      entityCache = undefined;
    }

    const canCache = populateCache && !tooLarge;
    if (canCache && !entityCache) {
      entityCache = new Map<string, Float32Array>();
    }

    const scored = candidateRows.map((row) => {
      let vector = entityCache?.get(row.id) ?? parseEmbedding(row.embedding_blob, row.embedding);

      if (vector && canCache && entityCache && !entityCache.has(row.id)) {
        entityCache.set(row.id, vector);
      }

      let score = 0;
      if (vector && vector.length === queryVec.length) {
        const cosSim = cosineSimilarity(queryVec, vector);
        if (weight !== undefined) {
          const kwScore = miniSearchScores?.get(row.id) ?? 0;
          score = weight * Math.max(0, cosSim) + (1 - weight) * kwScore;
        } else {
          score = cosSim;
        }
      } else if (weight !== undefined && weight < 1) {
        const kwScore = miniSearchScores?.get(row.id) ?? 0;
        score = (1 - weight) * kwScore;
      } else {
        score = -2;
      }

      return {
        id: row.id,
        entity_id: row.entity_id,
        score,
        updated_at: row.updated_at,
        access_count: row.access_count,
      };
    });

    if (canCache && entityCache && entityCache.size > 0) {
      if (!this.vectorCache.has(entityId)) {
        if (this.vectorCache.size >= SearchService.MAX_VECTOR_CACHE_ENTITIES) {
          const oldestKey = this.vectorCache.keys().next().value as string | undefined;
          if (oldestKey !== undefined) this.vectorCache.delete(oldestKey);
        }
        this.vectorCache.set(entityId, entityCache);
      }
    }

    if (!skipSort) {
      this._tieBreakSort(scored);
    }

    return scored.slice(0, limit);
  }

  // --- Internal Index Management ---

  private async rebuildIndex(entityId?: string): Promise<void> {
    if (entityId) {
      const rows = await this.entryRepo.findMiniSearchRows(entityId);
      const previousIds = this.miniSearchEntryIdsByEntity.get(entityId);

      if (previousIds) {
        for (const id of previousIds) {
          this.miniSearch.discard(id);
        }
      }

      const documents = rows.map((row) => this.normalizeMiniSearchRow(row));
      if (documents.length > 0) {
        this.miniSearch.addAll(documents);
      }

      this.miniSearchEntryIdsByEntity.set(
        entityId,
        new Set(documents.map((document) => document.id))
      );
      return;
    }

    const rows = await this.entryRepo.findMiniSearchRows();
    this.miniSearch.removeAll();
    this.miniSearchEntryIdsByEntity.clear();

    const documents = rows.map((row) => this.normalizeMiniSearchRow(row));
    if (documents.length > 0) {
      this.miniSearch.addAll(documents);
    }

    for (const document of documents) {
      const ids = this.miniSearchEntryIdsByEntity.get(document.entity_id) ?? new Set<string>();
      ids.add(document.id);
      this.miniSearchEntryIdsByEntity.set(document.entity_id, ids);
    }
  }

  private normalizeMiniSearchRow(row: {
    id: string;
    entity_id: string;
    title: string;
    body: string;
    tags: string;
  }): { id: string; entity_id: string; title: string; body: string; tags: string } {
    return {
      id: row.id,
      entity_id: row.entity_id,
      title: row.title,
      body: row.body,
      tags: (() => {
        try {
          const parsed = JSON.parse(row.tags);
          return Array.isArray(parsed) ? parsed.join(' ') : row.tags;
        } catch {
          return row.tags;
        }
      })(),
    };
  }

  private _tieBreakSort(items: ScoredRow[]): void {
    items.sort((a, b) => this._compareScoredRows(a, b));
  }

  private _compareScoredRows(a: ScoredRow, b: ScoredRow): number {
    const scoreDiff = b.score - a.score;
    if (!Number.isNaN(scoreDiff) && scoreDiff !== 0) return scoreDiff;

    const accessCountDiff = (b.access_count ?? 0) - (a.access_count ?? 0);
    if (accessCountDiff !== 0) return accessCountDiff;

    const updatedAtDiff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
    if (updatedAtDiff !== 0) return updatedAtDiff;

    return a.id.localeCompare(b.id);
  }
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