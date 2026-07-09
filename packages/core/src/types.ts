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
   * Runs `fn` inside a serialized transaction. Inside the callback, use ONLY the
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
 * and `'forget'` were added in v3.0. Exhaustive `switch` / narrowing on this type
 * must be updated (or given a `default` arm) to compile without errors.
 */
export type WikiBusyOperation =
  | 'ingest'
  | 'librarian'
  | 'heal'
  | 'prune'
  | 'reembed'
  | 'import'
  | 'forget';

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
    this.sqliteErrorCode = extractSqliteCodeForError(options.cause);
  }
}

/** Local copy of the driver-code extractor to keep types.ts free of a circular import. */
function extractSqliteCodeForError(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
  if (typeof message === 'string') {
    const m = /^Error code (\d+):/.exec(message);
    if (m) return `SQLITE_${m[1]}`;
  }
  return undefined;
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

