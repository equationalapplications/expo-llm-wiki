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
  withTransactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}

export interface WikiConfig {
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
}

export interface ReadOptions {
  maxResults?: number;
  /**
   * undefined → use WikiConfig.preFilterLimit (or no pre-filter if also unset).
   * null → explicitly disable a config-level preFilterLimit for this call.
   */
  preFilterLimit?: number | null;
  hybridWeight?: number;
}

export interface WikiFact {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  tags: string[];
  confidence: 'certain' | 'inferred' | 'tentative';
  source_type: 'user_stated' | 'agent_inferred' | 'user_confirmed' | 'user_document';
  source_hash: string | null;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number;
  deleted_at: number | null;
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
}

export interface WikiEvent {
  id: string;
  entity_id: string;
  event_type: 'observation' | 'decision' | 'action' | 'outcome';
  summary: string;
  related_entry_id?: string | null;
  created_at: number;
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

export interface WikiOptions {
  config?: WikiConfig;
  llmProvider: LLMProvider;
  /**
   * Called when embedding-based retrieval is unavailable during `read()` and
   * MiniSearch keyword search is used instead. This can happen when:
   * - `embed()` throws (e.g. network error, model unavailable)
   * - `embed()` returns a vector with non-finite values (NaN / Infinity)
   * - The query vector's dimension doesn't match stored embeddings (model switch;
   *   resolve by calling `runReembed()`)
   *
   * `read()` still returns keyword-search results — this is a notification, not an error path.
   */
  onRetrievalFallback?: (error: Error) => void;
}

export interface MemoryBundle {
  facts: WikiFact[];
  tasks: WikiTask[];
  events: WikiEvent[];
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

export class WikiBusyError extends Error {
  readonly operation: 'ingest' | 'librarian' | 'heal' | 'prune' | 'reembed' | 'import';
  readonly entityId: string;

  constructor(operation: 'ingest' | 'librarian' | 'heal' | 'prune' | 'reembed' | 'import', entityId: string) {
    super(`${operation} already running for entity ${entityId}`);
    this.name = 'WikiBusyError';
    this.operation = operation;
    this.entityId = entityId;
  }
}
