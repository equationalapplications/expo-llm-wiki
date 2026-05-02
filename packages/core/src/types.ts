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
   * Static caller-supplied synonym expansions applied at query time.
   * Keys must match the same normalization pipeline used by query formatting:
   * the query is lowercased, stripped to `[a-z0-9 ]`, split into tokens, and
   * only tokens with length >= 3 are considered for synonym lookup.
   * Values are appended to the FTS5 query token list (multi-word values are
   * split into tokens), then deduped and sliced to 12.
   */
  synonymMap?: Record<string, string[]>;
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
}

export interface WikiOptions {
  config?: WikiConfig;
  llmProvider: LLMProvider;
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
  readonly operation: 'ingest' | 'librarian' | 'heal' | 'prune';
  readonly entityId: string;

  constructor(operation: 'ingest' | 'librarian' | 'heal' | 'prune', entityId: string) {
    super(`${operation} already running for entity ${entityId}`);
    this.name = 'WikiBusyError';
    this.operation = operation;
    this.entityId = entityId;
  }
}
