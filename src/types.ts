export interface WikiConfig {
  tablePrefix?: string;
  maxFtsResults?: number;
  pruneEventsAfter?: number;
  autoLibrarianThreshold?: number;
  autoHealThreshold?: number;
  orphanAfterDays?: number | null;
  staleInferredAfterDays?: number | null;
  maxChunkLength?: number;
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
