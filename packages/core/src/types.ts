import { extractSqliteCode } from './db/sqliteCodes';
import type {
  OkfSource,
  OkfSourceUsageWindow,
  OkfVerifiedEntry,
} from '@equationalapplications/core-okf';

/**
 * Platform-agnostic SQLite driver interface.
 * Each platform package (wiki-expo, wiki-react) provides an adapter
 * that wraps its native driver behind this interface.
 */
export interface SQLiteAdapter {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  /**
   * Runs `fn` inside a transaction. A bare adapter implementation is not required to
   * serialize concurrent calls itself — `WikiMemory` wraps every adapter it's given in
   * `withSerializedTransactions` (see `db/serializedAdapter.ts`), which is what makes
   * transactions serialize in practice. Once wrapped, inside the callback use ONLY the
   * provided `tx` handle — never the outer database handle (captured via closure or
   * `this.db`). Calling the outer handle deadlocks against the transaction mutex;
   * calling `tx.withTransactionAsync` throws (nested transactions are unsupported).
   */
  withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}

export interface PromptOverrides {
  ingestSystemPrompt?: string;
  librarianSystemPrompt?: string;
  healSystemPrompt?: string;
  ontologyBackfillSystemPrompt?: string;
}

export type OntologyMode = 'strict' | 'emergent' | 'off';

export interface OntologyNodeType {
  type: string;
  description: string;
}

export interface OntologyEdgeType {
  type: string;
  source_type: string;
  target_type: string;
  description: string;
}

/**
 * Allowed node and edge types for an entity's ontology graph.
 * Persisted per entity and injected into librarian/ingest prompts when mode ≠ `off`.
 */
export interface OntologyManifest {
  node_types: OntologyNodeType[];
  edge_types: OntologyEdgeType[];
}

/**
 * Global ontology defaults and bootstrap manifests for known entities.
 * Per-entity mode and manifest overrides are stored in SQLite and managed via
 * `WikiMemory.getOntologyManifest` / `setOntologyManifest`.
 */
export interface OntologyConfig {
  /** Global default mode. Default: `'off'` (backward compatible — no typed extraction). */
  mode?: OntologyMode;
  /**
   * Bootstrap manifests for known entities at construction time.
   * Written to the database on first access if no row exists for that entity.
   */
  seedManifests?: Record<string, {
    manifest: OntologyManifest;
    mode?: OntologyMode;
  }>;
}

export interface ExtractedFactEdge {
  edge_type: string;
  target_title: string;
}

export interface OntologyUpdates {
  node_types?: OntologyNodeType[];
  edge_types?: OntologyEdgeType[];
}

export interface OntologyPromptContext {
  ontologyManifest: string;
  ontologyModeInstructions: string;
}

/** Result of a single ontology backfill run. Omissions (facts the model declined
 * to classify) are derivable as scanned − typed − failedValidation. */
export interface OntologyBackfillResult {
  /** Untyped facts sent to the model this run. */
  scanned: number;
  /** Facts that received an okf_type. */
  typed: number;
  /** Model classifications rejected (unknown/duplicate id, non-manifest type). */
  failedValidation: number;
  /** Edges persisted. */
  edgesAdded: number;
  /** Untyped facts still eligible after this run — safe host convergence signal: loop while > 0.
   * Always 0 when ontology mode is 'off' (nothing is eligible for typing while
   * disabled), so 0 does not imply queue exhaustion in that mode. */
  remaining: number;
  /** Untyped facts inside the recheck cooldown. */
  deferred: number;
  /** Facts a batch could not process even alone, skipped so the pass could finish.
   * Stamped with the recheck cooldown, so they reappear as `deferred` next pass. */
  skipped: number;
}

/**
 * L3 heal-success record: a fact the model emitted a verdict for under a
 * truncated view of its own body. `originalBodyChars` lets an operator flag
 * the fact for re-inspection; `truncatedBodyChars` is the L3 cap actually
 * applied. Emitted by `PromptService.buildHealPrompt`, surfaced via
 * `HealResult.degraded`, mutually exclusive with `HealResult.skipped` on
 * `id` (a fact can be either healed-under-degradation or dropped — never
 * both).
 */
export interface DegradedRecord {
  id: string;
  originalBodyChars: number;
  truncatedBodyChars: number;
}

/** Result of a single heal run. */
export interface HealResult {
  /**
   * Heal candidates sent to the model this run. Counts candidates whose batch
   * came back unusable and landed in `skipped` as well — they reached the
   * provider too, so this is provider exposure, not successful throughput.
   */
  scanned: number;
  /**
   * Facts whose confidence was lowered to `tentative` — the stale-inferred SQL
   * pass (`inferred` → `tentative`) plus any model-directed downgrades, deduped.
   */
  downgraded: number;
  /** Facts soft-deleted — the orphan-marking SQL pass plus model-directed deletes, deduped. */
  deleted: number;
  /** New facts synthesized by heal. */
  newFactsCreated: number;
  /**
   * Candidates that could not converge after the helper's full escalation
   * path (terminal give-up at attemptLevel 3, parse error, or non-truncation
   * call error). Each entry's `reason` discriminates the cause; today every
   * value is `'non_convergent'` but the field is here so future failure
   * modes can extend the union without another shape change. Mutually
   * exclusive with `degraded` on `id`.
   */
  skipped: Array<{ id: string; reason: 'non_convergent' }>;
  /**
   * L3 heal successes: facts the model emitted a verdict for under a
   * truncated view of their own body. Each entry carries the truncation
   * magnitude so an operator can flag the fact for re-inspection. The
   * corresponding log line `[WikiMemory] heal healed under degraded
   * context ...` fires for each entry. Mutually exclusive with `skipped`
   * on `id` — the reconciliation step in doRunHeal drops any record
   * whose id also appears in `skipped` (a contradiction: degraded means
   * healed, skipped means dropped).
   */
  degraded: Array<DegradedRecord>;
  /**
   * Heal candidates still eligible after this run — convergence signal: loop while > 0.
   *
   * This does NOT mean what it means for OntologyBackfillResult. Untyped facts are
   * a finite backlog that drains permanently; heal's candidates are the live mutable
   * corpus. `remaining === 0` means "every mutable fact is inside the recheck
   * cooldown", not "there is no more work" — it climbs back as the cooldown lapses
   * and as new facts are written. A host loop terminates, but it converges to
   * "corpus swept once this cooldown window", not to a drained queue.
   */
  remaining: number;
  /** Heal candidates inside the recheck cooldown. */
  deferred: number;
}

export interface WikiConfig {
  /**
   * Prefix applied to every SQL table/index/trigger name. Must match
   * `^[A-Za-z][A-Za-z0-9_]{0,30}_$` (letter, then alphanumeric/underscore,
   * ending in `_`, max 32 chars total) — enforced in the `WikiMemory` constructor.
   * Default: `'llm_wiki_'`.
   */
  tablePrefix?: string;
  maxResults?: number;
  /** @deprecated Use maxResults */
  maxFtsResults?: number;
  pruneEventsAfter?: number;
  pruneRetainSoftDeletedFor?: number;
  autoLibrarianThreshold?: number;
  autoHealThreshold?: number;
  orphanAfterDays?: number | null;
  staleInferredAfterDays?: number | null;
  maxChunkLength?: number;
  chunkOverlap?: number;
  chunkConcurrency?: number;
  /**
   * Max MiniSearch candidates passed to cosine scoring.
   * When set, MiniSearch pre-filters before the cosine scan.
   * Only applies when embed is provided and succeeds.
   * Default: undefined (full scan).
   */
  preFilterLimit?: number;
  /**
   * Hybrid blend weight (0.0–1.0).
   * 0.0 = pure keyword (skips embed() entirely).
   * 1.0 = pure semantic.
   * Values outside [0,1] are clamped. Ignored when embed is absent or throws.
   * Default: undefined (pure semantic when embed provided).
   */
  hybridWeight?: number;
  /** Global prompt overrides for text generation calls (`ingestDocument`, `runLibrarian`, `runHeal`). Does not affect embedding generation. Runtime overrides on individual method calls take precedence. */
  prompts?: PromptOverrides;
  /**
   * When true, entry and task mutations append an event to the internal outbox table.
   * The table is always created; this flag only controls whether writes occur.
   * @default false
   */
  enableOutbox?: boolean;
  ontology?: OntologyConfig;
  /** Default node cap for traverseGraph(), unless overridden per-call. Default 20. */
  maxTraversalNodes?: number;
  /** Default minimum confidence tier for discovered traversal nodes. Default 'tentative'. */
  minTraversalConfidence?: 'certain' | 'inferred' | 'tentative';
  /** Default traversal direction. Default 'both'. */
  traversalDirection?: 'inbound' | 'outbound' | 'both';
  /** Default source_type dead-end list for discovered traversal nodes. Default []. */
  excludeSourceTypes?: Array<WikiFact['source_type']>;
}

export interface ReadOptions {
  maxResults?: number;
  /**
   * undefined → use WikiConfig.preFilterLimit (or no pre-filter if also unset).
   * null → explicitly disable a config-level preFilterLimit for this call.
   */
  preFilterLimit?: number | null;
  hybridWeight?: number;
  /**
   * Per-entity score multiplier for multi-entity reads. Missing entries default to 1.0.
   * Entities with weight 0 are skipped during scored retrieval unless
   * `includeZeroWeightEntities` is true; in that case they rank below all finite scores.
   * Only meaningful when `entityId` is an array; ignored for single-string calls.
   */
  tierWeights?: Record<string, number>;
  /**
   * When true, entities with a tier weight of 0 are included in scored retrieval
   * as bottom fillers (ranked below every finite-scored candidate).
   * When false (default), zero-weight entities are skipped entirely.
   * Only meaningful when `entityId` is an array; ignored for single-string calls.
   */
  includeZeroWeightEntities?: boolean;
}

export interface WikiFact {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  tags: string[];
  confidence: 'certain' | 'inferred' | 'tentative';
  /**
   * Source type of this fact.
   * - 'immutable_document': From ingestDocument(), cannot be modified by system (librarian/heal).
   *   Only removable via forget() or replaced via re-ingest.
   * - 'librarian_inferred': Created by runLibrarian() from events, or by runHeal() when synthesizing new inferred facts.
   * - 'user_stated': Direct user statement.
   * - 'user_confirmed': User-confirmed fact.
   */
  source_type: 'user_stated' | 'librarian_inferred' | 'user_confirmed' | 'immutable_document';
  source_hash: string | null;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
  /**
   * Raw Float32Array bytes for the fact's embedding vector.
   * Set when the fact was fetched via exportDump() with blob preservation.
   * Accepted in importDump() as a real Uint8Array (in-memory round-trip),
   * a Node.js Buffer JSON shape `{ type: 'Buffer', data: number[] }`,
   * or a numeric-keyed plain object `{ 0: byte, 1: byte, ... }` produced
   * by JSON.stringify(Uint8Array).
   */
  embedding_blob?: Uint8Array | { type: 'Buffer'; data: number[] } | Record<string, number> | null;
  last_accessed_at: number | null;
  access_count: number;
  deleted_at: number | null;
  /**
   * Verbatim OKF `type:` frontmatter value when this fact originated from (or was
   * re-imported via) an OKF bundle. `null`/`undefined` for facts never touched by
   * OKF import. Distinct from `source_type`, which governs immutability rules.
   */
  okf_type?: string | null;
  // --- OKF v0.2 surface (additive; see spec §4.6) ---
  /** OKF v0.2 lifecycle state. Defaults to 'stable' on the SQL side. */
  lifecycle_status?: 'draft' | 'stable' | 'deprecated';
  /** Absolute YYYY-MM-DD cutoff for staleness. NULL = never stale. */
  stale_after?: number | null;
  /** Actor string per OKF v0.2 §7 (`<producer>/<version>`, `human:<id>`, `process:<id>`). */
  generated_by?: string | null;
  /** Full list of OKF v0.2 sources (provenance). */
  okf_sources?: OkfSource[];
  /** Chronological list of verification events. */
  okf_verified?: OkfVerifiedEntry[];
  /** Sibling-of-sources usage window object. */
  okf_usage_window?: OkfSourceUsageWindow | null;
  /** Convenience: epoch ms of the latest verifier. Derived; mirrored for query speed. */
  last_verified_at?: number | null;
  /** Convenience: actor string of the latest verifier. Derived; mirrored for query speed. */
  last_verified_by?: string | null;
  /**
   * Hydrated at read time: `isStaleAfter(stale_after, now)`. `true` once the
   * absolute stale_after cutoff has passed; `false` otherwise (including when
   * stale_after is null). Surfaced per spec §2.7 + §5.3 so hosts can render
   * staleness without recomputing. Always present on read paths that go
   * through `mapRowToFact` / `mapRowToTask`.
   */
  isStale?: boolean;
  /**
   * Hydrated at read time: `deriveTrustTier(okf_verified)`. `'human-reviewed'`
   * when any entry has `by: 'human:...'`, `'machine-confirmed'` when entries
   * exist without a human verifier, `'unverified'` when okf_verified is empty.
   * Surfaced per spec §2.7 + §5.3. Always present on read paths that go through
   * `mapRowToFact` / `mapRowToTask`.
   */
  trustTier?: 'unverified' | 'machine-confirmed' | 'human-reviewed';
}

export interface WikiTask {
  id: string;
  entity_id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'abandoned';
  priority: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  deleted_at: number | null;
  /** Verbatim OKF `type:` frontmatter value when this task originated from an OKF bundle. */
  okf_type?: string | null;
  // --- OKF v0.2 surface (additive; see spec §4.6) ---
  lifecycle_status?: 'draft' | 'stable' | 'deprecated';
  stale_after?: number | null;
  generated_by?: string | null;
  okf_sources?: OkfSource[];
  okf_verified?: OkfVerifiedEntry[];
  okf_usage_window?: OkfSourceUsageWindow | null;
  last_verified_at?: number | null;
  last_verified_by?: string | null;
  /**
   * Hydrated at read time: `isStaleAfter(stale_after, now)`. Mirrors
   * {@link WikiFact.isStale} (spec §2.5 + §5.3 treat stale_after symmetrically
   * for tasks and facts). Always present on read paths that go through
   * `mapRowToTask`.
   */
  isStale?: boolean;
  /**
   * Hydrated at read time: `deriveTrustTier(okf_verified)`. Mirrors
   * {@link WikiFact.trustTier}. Always present on read paths that go through
   * `mapRowToTask`.
   */
  trustTier?: 'unverified' | 'machine-confirmed' | 'human-reviewed';
}

export interface WikiEvent {
  id: string;
  entity_id: string;
  event_type: 'observation' | 'decision' | 'action' | 'outcome';
  summary: string;
  related_entry_id?: string | null;
  created_at: number;
}

export interface WikiEdge {
  id: string;
  entity_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  created_at: number;
}

export interface GraphTraversalOptions {
  sourceId: string;
  /** Hop count. Default 1. Clamped to [1, 3] regardless of input. */
  maxDepth?: number;
  /** Default 'both'. Falls back to WikiConfig.traversalDirection, then 'both'. */
  direction?: 'inbound' | 'outbound' | 'both';
  /**
   * Allowed edge types. `undefined` = no filter (all types).
   * `[]` (explicit empty array) = match nothing — distinct from `undefined`.
   */
  edgeTypes?: string[];
  /** Total node cap (anchor + neighbors). Default 20 via WikiConfig.maxTraversalNodes. */
  maxTraversalNodes?: number;
  /** Minimum confidence tier for *discovered* nodes. Does not gate the anchor. Default 'tentative'. */
  minTraversalConfidence?: 'certain' | 'inferred' | 'tentative';
  /** source_type values to dead-end on for *discovered* nodes. Does not gate the anchor. Default []. */
  excludeSourceTypes?: Array<WikiFact['source_type']>;
}

export interface GraphNeighborhood {
  /** Anchor node first, then discovered neighbors ordered by depth ASC, then updated_at DESC. */
  nodes: WikiFact[];
  /** Only edges where both endpoints are present in `nodes`. */
  edges: WikiEdge[];
}

export interface WikiCheckpoint {
  entity_id: string;
  heal_checkpoint: number;
  memory_checkpoint: number;
}

export interface ExtractedFact {
  title: string;
  body: string;
  tags: string[];
  confidence: 'certain' | 'inferred' | 'tentative';
}

export interface ExtractedFactWithOntology extends ExtractedFact {
  okf_type?: string;
  edges?: ExtractedFactEdge[];
}

export interface ExtractedTask {
  description: string;
  priority: number;
}

export interface LLMProvider {
  /**
   * Generates text using the developer's LLM of choice.
   * Expected to return the raw text response (typically a JSON string).
   */
  generateText: (params: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /**
   * Optional. When provided, enables semantic similarity search in `read()`.
   * Must return a stable-dimension float array for any input text.
   * Called once per fact on creation/update, and once per `read()` query.
   * When absent or throws, `read()` falls back to MiniSearch.
   */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Optional. The provider's hard output-token ceiling for `generateText`.
   * Core cannot observe it — the token budget lives entirely in the host's
   * adapter — so maintenance passes that generate response-size-proportional
   * output size their batches blind unless this is declared.
   *
   * When absent, batching falls back to a conservative default and adapts
   * downward on failure. When present, it is used as a sizing hint only and is
   * never trusted as a guarantee.
   */
  maxOutputTokens?: number;
}

/**
 * Result of semantic ranking for a single fact.
 */
export interface VectorRankerSemanticResult {
  id: string;
  /** Cosine similarity in [-1, 1] when exact; implementations MAY document other monotonic scales. */
  semanticScore: number;
}

/**
 * Arguments passed to VectorRanker.rankBySimilarity.
 */
export interface VectorRankerRankArgs {
  entityId: string;
  /**
   * Query embedding. Treat as readonly — core provides a defensive copy,
   * but adapters MUST NOT mutate this array. Mutation can corrupt
   * WikiMemory's internal vector cache and JS-cosine fallback path.
   */
  queryVec: Float32Array | number[];
  /**
   * When set (MiniSearch pre-filter path): ranker MUST only produce results for ids in this set.
   * When omitted (full-entity semantic path): ranker scopes by entityId per its backing store contract.
   */
  candidateIds?: readonly string[];
  /**
   * Upper bound on how many distinct fact ids should receive a semanticScore in this call.
   * WikiMemory derives this from maxResults / candidate cardinality / documented oversampling policy.
   */
  limit: number;
}

/**
 * Optional backend for semantic candidate scoring / top-k retrieval.
 * When omitted, WikiMemory scores rows with embedding_blob / embedding TEXT in JS (cosine).
 */
export interface VectorRanker {
  /**
   * Return semantic scores for facts in scope, sorted descending by semanticScore (stable tie-breaking
   * not required — WikiMemory reapplies existing tie-breakers after blending).
   * Implementations SHOULD omit facts with no usable vector; callers treat missing ids like today's
   * "no embedding" rows (pure semantic: -2; hybrid: keyword-only portion).
   */
  rankBySimilarity(args: VectorRankerRankArgs): Promise<VectorRankerSemanticResult[]>;

  /**
   * Called after a fact's embedding is successfully persisted to embedding_blob (or cleared).
   * Hosts use this to keep sqlite-vec / external indexes consistent with SQLite as source of truth.
   *
   * On deletion paths (forget, prune, hard-delete), core awaits this hook to ensure ANN cleanup
   * completes before the deletion call resolves (GDPR compliance). Hook failures or timeouts on
   * those paths reject the deletion call.
   *
   * Treat `vector` as readonly — core provides a defensive copy, but adapters MUST NOT mutate.
   *
   * Optional: if omitted, hosts MUST document "index rebuilt separately" and accept stale ANN until rebuild.
   */
  onEmbeddingPersisted?(event: {
    entityId: string;
    factId: string;
    vector: Float32Array | null; // null = embedding removed / unusable
  }): void | Promise<void>;
}

/**
 * Fallback policy when rankBySimilarity rejects.
 */
export type VectorRankerFallback = 'js-cosine' | 'keyword' | 'empty' | 'throw';

export interface WikiOptions {
  config?: WikiConfig;
  llmProvider: LLMProvider;
  /**
   * Called when embedding-based retrieval is degraded or unavailable during `read()`.
   * This can happen when:
   * - `embed()` throws (e.g. network error, model unavailable) → falls back to keyword search
   * - `embed()` returns a vector with non-finite values (NaN / Infinity) → falls back to keyword search
   * - The query vector's dimension doesn't match stored embeddings (model switch;
   *   resolve by calling `runReembed()`) → falls back to keyword search
   * - `vectorRanker` returns IDs that don't belong to the requested entity or don't exist
   *   (ranker integrity issue; returned rows will be filtered out, reducing result count) →
   *   may still use semantic ranking, but with degraded quality
   *
   * `read()` returns results (keyword fallback or degraded semantic) — this is a notification, not an error path.
   */
  onRetrievalFallback?: (error: Error) => void;

  /**
   * Optional backend for semantic candidate scoring / top-k retrieval.
   * When omitted, WikiMemory scores rows with embedding_blob / embedding TEXT in JS (cosine).
   */
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

  /**
   * When true (default), sanitize ranker errors before exposing via error.cause
   * to prevent credential leakage in host telemetry. Disable only when you
   * control the ranker implementation.
   *
   * Sanitization replaces error message/stack with a generic message preserving
   * only the error type (constructor name).
   */
  sanitizeRankerErrors?: boolean;

  /**
   * Timeout (ms) for onEmbeddingPersisted hook on GDPR deletion paths
   * (forget, _doPrune). Hook must complete within this window or the
   * deletion operation rejects. Default 30000.
   * Lower for interactive deletes; raise for slow remote ANN backends.
   */
  deletionHookTimeoutMs?: number;

  /**
   * Escape hatch: skip onEmbeddingPersisted on deletion paths entirely.
   * Use ONLY when the ANN backend is permanently decommissioned. Vectors
   * orphaned in the (unreachable) external index are accepted as a tradeoff.
   * NOT GDPR-safe for live indexes. Default false.
   */
  forceDeleteIgnoreRankerHook?: boolean;
}

export interface MemoryBundle {
  facts: WikiFact[];
  tasks: WikiTask[];
  events: WikiEvent[];
  edges?: WikiEdge[];
  /** Entity summary prose for OKF profile ≥ 1 round-trip. Omitted = no summary (Clanker default). */
  summary?: string;
  factScores?: Record<string, number>;
  metadata?: {
    query: string;
    entityIds: string[];
    tierWeights?: Record<string, number>;
  };
}

export interface MemoryDump {
  generatedAt: number;
  entities: Record<string, MemoryBundle>;
}

export interface FormattedMemoryDump {
  manifest: string;
  files: Array<{ name: string; content: string }>;
}

export interface FormatContextOptions {
  format?: 'markdown' | 'plain';
  maxFacts?: number;
  maxTasks?: number;
  maxEvents?: number;
  includeConfidence?: boolean;
  includeTags?: boolean;
  includeEntityIds?: boolean;
  includeFactScores?: boolean;
  factWeights?: {
    confidence?: number;
    accessCount?: number;
    recency?: number;
  };
}

export interface EntityStatus {
  ingesting: boolean;
  librarian: boolean;
  heal: boolean;
}

/**
 * All operations that can appear in a {@link WikiBusyError}.
 *
 * @remarks **Breaking change from v2.x** — the union previously only contained
 * `'ingest' | 'librarian' | 'heal' | 'prune' | 'reembed'`. The values `'import'`
 * and `'forget'` were added in v3.0. `'ontologyBackfill'` was added afterward.
 * Exhaustive `switch` / narrowing on this type must be updated (or given a
 * `default` arm) to compile without errors.
 */
export type WikiBusyOperation =
  | 'ingest'
  | 'librarian'
  | 'heal'
  | 'prune'
  | 'reembed'
  | 'import'
  | 'forget'
  | 'ontologyBackfill';

/**
 * Thrown when a background mutator is already running for the requested entity.
 */
export class WikiBusyError extends Error {
  readonly operation: WikiBusyOperation;
  readonly entityId: string;

  constructor(operation: WikiBusyOperation, entityId: string) {
    super(`${operation} already running for entity ${entityId}`);
    this.name = 'WikiBusyError';
    this.operation = operation;
    this.entityId = entityId;
  }
}

/**
 * Thrown by `ingestDocument({ onDuplicateHash: 'throw' })` when a different
 * source_ref in the same entity already holds the supplied source_hash against
 * a live row. Mirrors {@link WikiBusyError}'s anchoring of canonical metadata
 * on the error instance for stable observability.
 */
export class WikiDuplicateHashError extends Error {
  readonly canonical: string;
  readonly sourceHash: string;
  readonly entityId: string;

  constructor(params: { canonical: string; sourceHash: string; entityId: string }) {
    super(`Duplicate source hash for entity ${params.entityId}; another ref already holds this content`);
    this.name = 'WikiDuplicateHashError';
    this.canonical = params.canonical;
    this.sourceHash = params.sourceHash;
    this.entityId = params.entityId;
  }
}

/**
 * Thrown by `WikiMemory.upsertGraph` when the persisted ontology mode for the
 * entity is `'strict'` and a caller-supplied node or edge `type` does not
 * resolve against the entity's manifest. Mirrors {@link WikiBusyError}'s
 * anchoring of canonical metadata on the error instance for stable
 * observability. Per C4, the check is pre-flight and all-or-nothing — the
 * first invalid item throws; NONE are written.
 */
export class WikiStrictOntologyViolation extends Error {
  readonly entityId: string;
  readonly kind: 'node' | 'edge';
  readonly type: string;
  readonly code = 'WIKI_STRICT_ONTOLOGY_VIOLATION' as const;

  constructor(entityId: string, kind: 'node' | 'edge', type: string) {
    super(
      `Out-of-manifest ${kind} type "${type}" for entity "${entityId}" under strict mode.`,
    );
    this.entityId = entityId;
    this.kind = kind;
    this.type = type;
    this.name = 'WikiStrictOntologyViolation';
  }
}

/**
 * Thrown by `WikiMemory.upsertGraph`'s C2 probe when the supplied
 * `sourceHash` is already mapped to a *different* `sourceRef` for the same
 * entity. Indicates either a caller-side id-derivation collision, a race with
 * another writer, or — per the C2 known-limitation note in the spec — two
 * source files with genuinely identical content (byte-identical barrel
 * re-exports, blank stubs, vendored boilerplate). In all cases: fail loud.
 */
export class WikiSourceRefHashCollision extends Error {
  readonly entityId: string;
  readonly sourceHash: string;
  readonly existingSourceRef: string;
  readonly attemptedSourceRef: string;
  readonly code = 'WIKI_SOURCE_REF_HASH_COLLISION' as const;

  constructor(params: {
    entityId: string;
    sourceHash: string;
    existingSourceRef: string;
    attemptedSourceRef: string;
  }) {
    super(
      `Source hash "${params.sourceHash}" for entity "${params.entityId}" ` +
        `is already mapped to sourceRef "${params.existingSourceRef}"; ` +
        `cannot remap to "${params.attemptedSourceRef}".`,
    );
    this.entityId = params.entityId;
    this.sourceHash = params.sourceHash;
    this.existingSourceRef = params.existingSourceRef;
    this.attemptedSourceRef = params.attemptedSourceRef;
    this.name = 'WikiSourceRefHashCollision';
  }
}

/**
 * Thrown by the serialized transaction wrapper when a SQLite driver error
 * escapes a transaction callback (nested BEGIN, SQLITE_BUSY, constraint
 * violation). Domain errors thrown from callback logic pass through unwrapped.
 * Stable `instanceof` target for observability, mirroring {@link WikiBusyError}.
 */
export class WikiTransactionError extends Error {
  /** Best-effort SQLite code lifted from the driver error, e.g. 'SQLITE_BUSY'. */
  readonly sqliteErrorCode?: string;

  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'WikiTransactionError';
    this.sqliteErrorCode = extractSqliteCode(options.cause);
  }
}

export class PrunePartialFailureError extends Error {
  readonly deleted: number;
  readonly failedAt: string;
  readonly remaining: number;
  readonly deletedTasks: number;
  readonly deletedEvents: number;
  override readonly cause: Error;

  constructor(
    deleted: number,
    failedAt: string,
    remaining: number,
    cause: Error,
    deletedTasks: number = 0,
    deletedEvents: number = 0,
  ) {
    super(`Prune partially failed: deleted ${deleted}, failed at ${failedAt}, ${remaining} remaining`);
    this.name = 'PrunePartialFailureError';
    this.deleted = deleted;
    this.failedAt = failedAt;
    this.remaining = remaining;
    this.deletedTasks = deletedTasks;
    this.deletedEvents = deletedEvents;
    this.cause = cause;
  }
}

export const HOOK_TIMEOUT_MARKER = Symbol('WikiMemoryHookTimeout');

/**
 * Failure record for a single chunk that could not be ingested. Produced by
 * `IngestionService.ingestDocument` and surfaced on the result's `parseFailures`
 * array. `source === 'parse'` for `WikiParseError`-shaped failures (then `tier`
 * is set); `source === 'llm'` for `generateText` rejections (no `tier`).
 *
 * Note: `'ontologyContext'` is reserved but NEVER produced. `buildPromptContext`
 * failures are DB-systemic and propagate as raw throws, not as `parseFailures`.
 */
export interface ChunkFailure {
  chunkIndex: number;
  sourceRef: string;
  source: 'parse' | 'llm';
  tier?: 'strict' | 'repair' | 'all';
  position: number | null;
  message: string;
}

/**
 * Result of `IngestionService.ingestDocument`. The shape WIDENS relative to
 * earlier versions: `ingestedChunks` and `failedChunks` are always present;
 * `parseFailures` is present iff at least one chunk failed.
 *
 * Hosts that destructure `{ truncated, chunks }` see no behavior change.
 * Hosts pattern-matching the entire shape must update to the new fields.
 */
export interface IngestDocumentResult {
  truncated: boolean;
  chunks: number;
  ingestedChunks: number;
  failedChunks: number;
  duplicateOf?: string;
  parseFailures?: ChunkFailure[];
}

/**
 * Thrown by `parseJsonResponse` when both the strict scanner pass and the
 * container-aware repair pass fail to produce a parsable candidate.
 *
 * - `tier: 'strict'` — the existing scanner produced no usable slice (no
 *   `{`/`[` at all, or no balanced close). `slice` is the full input text;
 *   `position` is the offset of the first `{`/`[`, or `null` when none found.
 * - `tier: 'repair'` — tier 1 found a slice but `JSON.parse` failed; tier 2
 *   produced no parsable candidate within `MAX_REPAIR_CANDIDATES`. `slice` is
 *   the largest balanced span the walker found; `position` is the offset of
 *   the first parse failure within that candidate when known.
 * - `tier: 'all'` — generic catch-all.
 */
export class WikiParseError extends Error {
  readonly tier: 'strict' | 'repair' | 'all';
  readonly position: number | null;
  readonly slice: string;

  constructor(
    message: string,
    opts: { tier: WikiParseError['tier']; position?: number | null; slice?: string },
  ) {
    super(message);
    this.name = 'WikiParseError';
    this.tier = opts.tier;
    this.position = opts.position ?? null;
    this.slice = opts.slice ?? '';
  }
}

/**
 * Thrown by `IngestionService.ingestDocument` when every chunk of a document
 * failed (either `parseJsonResponse` or `generateText`). A silent zero-fact
 * ingest is a worse regression than a typed throw — matches existing host
 * semantics (`aws-cloud-agent` Writer Lambda today sees `ingestDocument`
 * throw on any failure).
 */
export class WikiIngestEmptyError extends Error {
  readonly parseFailures: ChunkFailure[];
  readonly sourceRef: string;
  readonly chunks: number;

  constructor(params: { parseFailures: ChunkFailure[]; sourceRef: string; chunks: number }) {
    const summary = `All ${params.chunks} chunks failed for sourceRef "${params.sourceRef}"; see parseFailures for per-chunk detail`;
    super(summary);
    this.name = 'WikiIngestEmptyError';
    this.parseFailures = params.parseFailures;
    this.sourceRef = params.sourceRef;
    this.chunks = params.chunks;
  }
}

