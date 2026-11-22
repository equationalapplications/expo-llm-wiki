import { WikiMemory } from './WikiMemory';
import type { SQLiteAdapter, WikiOptions } from './types';

export * from './types';
export type { WikiOutboxEvent } from './outbox/types';
export { WikiMemory } from './WikiMemory';
export type { WikiMemoryTestAccess } from './WikiMemory';
export { formatContext } from './utils/formatContext';
export { formatGraphContext } from './utils/formatGraphContext';
export { formatMemoryDump } from './utils/formatMemoryDump';
export { formatOkfBundle, type FormatOkfBundleOptions, type OkfFormatProfile } from './utils/formatOkfBundle';
export { parseOkfBundle, type OkfImportOptions } from './utils/parseOkfBundle';
export { parseEmbedding } from './utils/embedding';
export { validateManifest } from './utils/ontology';
export { buildOntologyPromptAppendix } from './prompts/ontology';
export { configureRandomSource } from './utils/ids';
export { validUsage } from './utils/llmCall';
export { chunkText, safeSlice } from './utils/pure';
export { DEFAULT_MAX_CHUNK_LENGTH, DEFAULT_CHUNK_OVERLAP } from './utils/chunkingDefaults';
export { resolveContextBudget, resolveMaxPromptChars, resolveDefaultChunkLength } from './config/context';
export type { ContextBudget } from './utils/contextBudget';
export { estimateTokensWith } from './utils/contextBudget';
export { DEFAULT_MAX_EMBED_CHARS, EMBED_CHARS_CEILING } from './utils/embedDefaults';
export { DEFAULT_SETUP_BUDGET_MS } from './utils/setupDefaults';
export * from './librarianPrompt';
export { PromptService } from './services/PromptService';
export { resolveOntologyJobDefaults, DEFAULT_ONTOLOGY_JOB_BATCH_SIZE } from './utils/config/ontologyJobDefaults';
export {
  resolveSystemOneTyping,
  resolveTypingMinConfidence,
  resolveSystemOneEdges,
  resolveEdgesMinConfidence,
  warnOnce,
  DEFAULT_TYPING_MIN_CONFIDENCE,
} from './utils/engineDefaults';
export { ONTOLOGY_ABSTAIN_SENTINEL, isReservedAbstainSlug } from './utils/ontology';
export type { EmbedFactResult, EmbedFailureKind } from './services/EmbeddingService';
export {
  ONTOLOGY_BACKFILL_BATCH_SIZE,
  ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS,
  ONTOLOGY_BACKFILL_RECHECK_MS,
  CLASSIFIER_MAX_CHOICES,
  HEAL_ANCHORS_PER_CANDIDATE,
  HEAL_BATCH_SIZE,
  HEAL_MAX_FACT_BODY_CHARS_L3,
  HEAL_MAX_TASKS,
  HEAL_RECHECK_MS,
} from './services/MaintenanceService';
export { EraseStepError } from './services/MaintenanceService';
export type { EraseReport } from './services/MaintenanceService';
export { CheckpointIncompleteError } from './repositories/MetadataRepository';
export { ONTOLOGY_BACKFILL_SYSTEM_PROMPT } from './prompts';

export function createWiki(db: SQLiteAdapter, options: WikiOptions): WikiMemory {
  return new WikiMemory(db, options);
}
