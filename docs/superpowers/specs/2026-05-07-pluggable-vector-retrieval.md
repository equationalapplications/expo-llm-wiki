# Spec: Pluggable Vector Retrieval (`VectorRanker`)

**Date:** 2026-05-07  
**Status:** Draft  
**Tracks:** [GitHub issue #15](https://github.com/equationalapplications/expo-llm-wiki/issues/15)  
**Builds on:** [`2026-05-03-embedding-retrieval.md`](2026-05-03-embedding-retrieval.md), [`2026-05-04-retrieval-tuning.md`](2026-05-04-retrieval-tuning.md)

---

## Problem

`WikiMemory.read()` today loads semantic candidate rows (`id`, `embedding_blob`, fallback `embedding`, tie-break columns), parses vectors, and scores each row with in-process `cosineSimilarity` against the query embedding — **O(#candidates)** per query within the scoped entity (full scan or MiniSearch-limited candidate set). The in-memory `vectorCache` in `packages/core/src/WikiMemory.ts` only avoids repeated **parsing**; it does not reduce asymptotic scan cost.

That design matches intentional simplicity (same class of behavior as a synchronous vault `semantic_search` path) but does not scale when entity fan-out or monolithic SQLite corpora grow. Consumers who load **sqlite-vec / sqlite-vss** or maintain an **external vector index** currently cannot plug in without copying logic or forked `read()` paths.

[`2026-05-04-retrieval-tuning.md`](2026-05-04-retrieval-tuning.md) explicitly scoped out approximate nearest-neighbor (ANN). This spec **narrows ANN integration to an optional injection point** — core retains portable defaults and semantic contracts.

---

## Goal

Provide an **optional, host-supplied vector ranker** so `WikiMemory` can delegate **neighbor ordering / similarity scoring at scale** to sqlite-vec, sqlite-vss, or an external vector database, while **`WikiMemory` keeps**:

1. Embedding dimension validation and mismatch handling (`embedding_dimension` meta, per-entity malformed-blob counts) — unchanged from the caller’s perspective.
2. MiniSearch **`preFilterLimit`** semantics: when configured, MiniSearch narrows **which fact ids participate** before semantic ranking; the injected ranker **MUST** respect that restriction.
3. **`hybridWeight`** blending between semantic and lexical scores — **`WikiMemory` remains the sole place that computes the final blended score** from ranker-produced semantic scores and existing MiniSearch normalization (same formulas as today where applicable).
4. **Two-phase `SELECT`** after ordering: Phase 2 `SELECT * … WHERE id IN (?)` for top ids only (existing pattern).

The **default** when no ranker is supplied **MUST** remain identically today's blob + JS cosine path (parity tests).

---

## Public surface

### 1. `VectorRanker` interface — `packages/core/src/types.ts` (exact path TBD; export from core entry)

Naming is provisional (`VectorSimilarityRanker`, `SemanticRankBackend`, …); this spec uses **`VectorRanker`** unless implementation chooses a clearer export name documented in changelog.

```typescript
/**
 * Optional backend for semantic candidate scoring / top-k retrieval.
 * When omitted, WikiMemory scores rows with embedding_blob / embedding TEXT in JS (cosine).
 */
export interface VectorRankerSemanticResult {
  id: string;
  /** Cosine similarity in [-1, 1] when exact; implementations MAY document other monotonic scales. */
  semanticScore: number;
}

export interface VectorRankerRankArgs {
  entityId: string;
  queryVec: Float32Array | number[];
  /**
   * When set (MiniSearch pre-filter path): ranker MUST only produce results for ids in this set.
   * When omitted (full-entity semantic path): ranker scopes by entityId per its backing store contract.
   */
  candidateIds?: readonly string[];
  /**
   * Upper bound on how many distinct fact ids should receive a semanticScore in this call.
   * WikiMemory derives this from maxResults / candidate cardinality / documented oversampling policy.
   * Core enforces this bound while normalizing ranker output in `_rankWithVectorRanker`
   * via early termination and deduplication, so malformed or over-producing rankers do not
   * expand the retained result set beyond `limit`.
   */
  limit: number;
}

export interface VectorRanker {
  /**
   * Return semantic scores for facts in scope, sorted descending by semanticScore (stable tie-breaking
   * not required — WikiMemory reapplies existing tie-breakers after blending).
   * Implementations SHOULD omit facts with no usable vector; callers treat missing ids like today’s
   * “no embedding” rows (pure semantic: -2; hybrid: keyword-only portion).
   */
  rankBySimilarity(args: VectorRankerRankArgs): Promise<VectorRankerSemanticResult[]>;

  /**
   * Called after a fact’s embedding is successfully persisted to embedding_blob (or cleared).
   * Hosts use this to keep sqlite-vec / external indexes consistent with SQLite as source of truth.
   * Optional: if omitted, hosts MUST document “index rebuilt separately” and accept stale ANN until rebuild.
   */
  onEmbeddingPersisted?(event: {
    entityId: string;
    factId: string;
    vector: Float32Array | null; // null = embedding removed / unusable
  }): void | Promise<void>;
}
```

### 2. `WikiOptions` — injection, ranker fallback policy, and observability hooks

```typescript
/**
 * When rankBySimilarity rejects, core notifies onVectorRankerFallback (if set), applies this policy unless it is throw, then MAY mirror to onRetrievalFallback (recoverable paths only).
 */
export type VectorRankerFallback =
  /** Built-in cosine over the same candidate rows WikiMemory would have scored (default). */
  | 'js-cosine'
  /** MiniSearch-only for this read (semantic ranking aborted for recovery). */
  | 'keyword'
  /** Facts list from semantic path empty for this read; remainder of read() unchanged (tasks/events etc.). */
  | 'empty'
  /** Fail the read() promise with the ranker error (or a wrapped error). */
  | 'throw';

export interface WikiOptions {
  // ... existing fields ...

  vectorRanker?: VectorRanker;
  /**
   * When rankBySimilarity throws. Default `'js-cosine'`.
   * Ignored when vectorRanker is undefined.
   */
  vectorRankerFallback?: VectorRankerFallback;

  /**
   * Called only when rankBySimilarity rejects (after embeddings path succeeded).
   * Invoked before applying vectorRankerFallback when that policy recovers or before rejecting when policy is 'throw'.
   */
  onVectorRankerFallback?: (info: {
    error: Error;
    /** Effective policy core will apply for this read (same as WikiOptions.vectorRankerFallback, default js-cosine). */
    policy: VectorRankerFallback;
  }) => void;

  /**
   * When true: after rankBySimilarity failure, once the recoverable fallback has finished
   * and read() will resolve, invoke onRetrievalFallback — after onVectorRankerFallback if set.
   * Ignored when vectorRankerFallback is 'throw'. Default false.
   */
  propagateRankerFailureToRetrievalFallback?: boolean;
}
```

Field naming (`propagateRankerFailureToRetrievalFallback`) is illustrative; implementations **MAY** use a shorter alias if exported consistently and documented.

- **`vectorRanker` default:** `undefined` → current behavior (no delegation).
- **Coexistence with `llmProvider.embed`:** Ranker **MUST NOT** run unless the same preconditions apply as today’s semantic path (`embedFn` invoked successfully, passes validation, dimensions match — see query path below). If `embed` is absent/throws/`hybridWeight === 0` skips embed → ranker **MUST NOT** be invoked — same as today’s keyword-only branches.

#### `onRetrievalFallback` (existing) vs `onVectorRankerFallback` (new)

- **`onRetrievalFallback`:** Remains reserved for **`read()` degradation on the query-embedding side** — missing/`embed` failure/invalid vector/dimension mismatch and the existing fallback to MiniSearch keyword search. Its meaning **MUST NOT** be overloaded to imply “vector ranker failed” unless the developer opts in via **`propagateRankerFailureToRetrievalFallback`**.
- **`onVectorRankerFallback`:** Fires only when **`rankBySimilarity` rejects** while the embedding preconditions above already succeeded. Typical causes: sqlite-vec misconfiguration, remote ANN outage, buggy adapter — operationally distinct from **`onRetrievalFallback`**.
- **Optional mirroring:** If **`propagateRankerFailureToRetrievalFallback === true`** and **`vectorRankerFallback` is not `'throw'`**, core **SHOULD** invoke **`onRetrievalFallback(error)`** **after** the recoverable fallback path has finished building the **`read()`** result (so the call still resolves), and **after** **`onVectorRankerFallback`** when that hook is set. If **`onVectorRankerFallback`** is unset but mirroring is on, **`onRetrievalFallback` alone** **SHOULD** still run. **MUST NOT** mirror when **`vectorRankerFallback` is `'throw'`** (those reject **`read()`**). The mirrored **`error` SHOULD** expose the original rejection via **`error.cause`** (or documented equivalent).

---

## Semantics

### Query path (`read`)

1. **Preconditions** identical to today: `trimmedQuery` non-empty, `embedFn` present, dimension match, no mismatching blobs — **before** any ranker call.
2. **Candidate ids**
   - If `effectivePreFilterLimit` applies: MiniSearch supplies an ordered candidate list; WikiMemory passes `candidateIds` to the ranker **in that order is not required**; set membership **is** required.
   - If full scan: `candidateIds` **MAY** be omitted; ranker **MUST** restrict results to facts for `entityId` and `deleted_at IS NULL` equivalence in its backing store, or delegate back to core by returning empty and falling through — **Normative:** prefer **explicit contract:** ranker **MUST** implement entity scoping when `candidateIds` is omitted; if a host cannot, it **MUST** pass-through by not being installed and use default JS cosine, or supply a wrapper that reads candidate ids from SQLite (out of scope for core).
3. **Limit / oversampling**
   - WikiMemory **MUST** request at least `maxResults` semantic rows, and **MAY** request an internal oversample (config or fixed constant) so post-hybrid reordering still approximates today’s “score all candidates then sort” behavior when hybrid keyword signal moves ordering. **Exact oversample factor** is an implementation detail; this spec **REQUIRES** documenting the chosen policy in code comment + README so ANN adopters understand recall trade-offs.
4. **Hybrid blending**
   - Ranker returns **semanticScore** comparable to raw **cosine similarity** (`[-1, 1]`). WikiMemory applies the same **`hybridWeight`** rules as implemented today in `packages/core/src/WikiMemory.ts` (including `Math.max(0, cosSim)` when blending, pure semantic preserving full `[-1,1]`, unembedded rows at `-2` in pure semantic mode, keyword-only branch when `weight < 1` and no vector).
   - If a future ANN implementation cannot produce true cosine, it **MUST** document deviation; core **SHOULD** treat scores as monotonic with true cosine for ranking only when explicitly configured (optional follow-up — **non-goal** for v1).
5. **Ranker rejects (`rankBySimilarity` throws)**

   Order **MUST** be:

   1. Invoke **`onVectorRankerFallback`** if provided (payload includes the **`Error`** and the effective **`vectorRankerFallback` policy** for this read).
   2. Apply **`vectorRankerFallback`** (default **`'js-cosine'`**):
      - **`'js-cosine'`:** Same scoring path as absent ranker: score the current candidate rows in-process with **`cosineSimilarity`**, **hybridWeight** blending, tie-break sort, phase-2 **`SELECT`** — **MUST NOT** recurse into **`rankBySimilarity`** again for this **`read()`** invocation.
      - **`'keyword'`:** Use the existing MiniSearch **`read()` fallback** branch for non-empty queries (facts from keyword ranked slice only; existing access-tracking rules apply as for embed-failure fallback).
      - **`'empty'`:** Semantic facts list empty for this read; **`read()` still completes** with tasks/events per existing contract; **`access_count` / `last_accessed_at`** **SHOULD** match the product choice for “keyword-only / no hits” paths — document any subtlety in `CHANGELOG.md`.
      - **`'throw'`:** Reject the **`read()`** promise (**MUST NOT** invoke **`propagateRankerFailureToRetrievalFallback`** or **`onRetrievalFallback`** for this ranker failure).
   - **Mirroring** (subsection *`onRetrievalFallback` vs `onVectorRankerFallback`* above): recoverable paths only — **after** step 2 completes successfully.

6. **`rankBySimilarity` resolves with an empty or partial result**

   - **Not** a ranker “failure”: **do not invoke** **`onVectorRankerFallback`**. **`WikiMemory` merges scores** into the existing hybrid/unembedded-row rules (**MUST** match absent-ranker behavior for ids omitted from ranker output).

7. **Empty candidate set (pre-filter)**
   - Unchanged: zero MiniSearch candidates → empty facts, no access tracking, no ranker call.

### Write path (source of truth)

- **Authoritative store:** SQLite `embedding_blob` (and migration path from `embedding` TEXT) **remains canonical**, matching issue #15.
- **Ranker sync:** If `vectorRanker.onEmbeddingPersisted` is provided, WikiMemory **MUST** invoke it after successful writes that change stored embeddings (embed on upsert, `runReembed`, forget/prune/delete paths that clear blobs — **TBD exact call sites in implementation plan**). Implementations **MAY** async-resolve the promise as long as ordering is documented (e.g. eventual consistency for ANN).
- **Blob-primary + async rebuild** without hooks is **unsupported as a first-class core mode**; hosts that want lazy rebuild **MAY** omit `onEmbeddingPersisted` and run external maintenance (documented only — core does not schedule rebuilds).

### Portability

- Environments without native SQLite extensions (some Expo / WASM builds) **MUST** keep working: **no ranker** → JS cosine. **With ranker** → host’s JavaScript adapter may no-op ANN and implement `rankBySimilarity` by delegating to local cosine over fetched rows (testing strategy) or connect to remote ANN.

---

## Reference implementation notes (non-normative)

- **sqlite-vec / vss:** Virtual table keyed by stable fact `id`, `WHERE entity_id = ?` (or partition per entity), maintained from `onEmbeddingPersisted`. `rankBySimilarity` runs `knn` / vss query, returns ids + distances mapped to `semanticScore`.
- **External DB:** Same interface; `rankBySimilarity` is an HTTP/gRPC client; `onEmbeddingPersisted` upserts/deletes remote rows.

Core **MAY** ship zero bundled adapters in the first iteration; issue author offered to prototype against `react-llm-wiki`.

---

## Testing

Conformance **SHOULD** include:

- **Default:** Full existing core retrieval test suite unchanged when `vectorRanker` is undefined.
- **Injection:** A test double `VectorRanker` that returns fixed scores **MUST** demonstrate that `read()` uses those scores for ordering (and still applies hybrid when `hybridWeight` set).
- **Ranker throws:** **`onVectorRankerFallback`** runs before applying policy; each **`vectorRankerFallback`** value behaves as specified (**`throw`** rejects **`read()`** with no mirroring to **`onRetrievalFallback`**).
- **Mirroring:** **`propagateRankerFailureToRetrievalFallback`** invokes **`onRetrievalFallback`** for recoverable policies only; **must not** when policy is **`'throw'`**.
- **Partial/empty ranker result:** **`onVectorRankerFallback`** **must not** run.
- **Pre-filter:** When `preFilterLimit` narrows candidates, mock ranker **MUST** receive `candidateIds` matching MiniSearch output (modulo chunk ordering).
- **Dimension mismatch:** Still throws before ranker — ranker **MUST NOT** run.
- **Write hooks:** At least one test that `onEmbeddingPersisted` fires on embed update (or explicit decision to defer with documented skip).

---

## Documentation

- Core README (or `packages/core` README): section **“Pluggable vector retrieval”** — when to use, sqlite-vec vs external; **`vectorRankerFallback`** values; **`onVectorRankerFallback`** vs **`onRetrievalFallback`** and **`propagateRankerFailureToRetrievalFallback`**; eventual consistency if async hooks on **`onEmbeddingPersisted`**.
- `CHANGELOG.md` minor feature entry.
- Cross-link issue #15 and this spec from PR description.

---

## Non-goals

- Bundling sqlite-vec or compiling platform-specific SQLite extensions inside `expo-llm-wiki` core packages.
- Changing default retrieval to ANN-only or requiring extensions in bare Expo apps.
- Cross-entity vector search.
- Replacing MiniSearch lexical index.
- Semantic scores from the ranker replacing phase-2 `SELECT` (facts still hydrate from SQLite/WikiFact shape).

---

## Acceptance

- [ ] `WikiOptions` accepts optional `vectorRanker`, **`vectorRankerFallback`** (default **`js-cosine`**), **`onVectorRankerFallback`**, and optional **`propagateRankerFailureToRetrievalFallback`**; **all existing default-path tests pass** unchanged when ranker injected types are absent.
- [ ] `preFilterLimit`, `hybridWeight`, tie-break sorting, dimension mismatch behavior, empty pre-filter behavior are **preserved** or deviations **explicitly documented** here and in changelog.
- [ ] Documented story for sqlite-vec / external adapter vs in-process cosine fallback (#15 checklist).
- [ ] Issue #15 **SHOULD** be closed when shipped and documented.
