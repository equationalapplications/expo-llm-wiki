import { WikiMemory } from './WikiMemory';
import type { SQLiteAdapter, WikiOptions } from './types';

export * from './types';
export type { WikiOutboxEvent } from './outbox/types';
export { WikiMemory } from './WikiMemory';
export type { WikiMemoryTestAccess } from './WikiMemory';
export { formatContext } from './utils/formatContext';
export { formatGraphContext } from './utils/formatGraphContext';
export { formatMemoryDump } from './utils/formatMemoryDump';
export { formatOkfBundle } from './utils/formatOkfBundle';
export { parseOkfBundle, type OkfImportOptions } from './utils/parseOkfBundle';
export { parseEmbedding } from './utils/embedding';
export { validateManifest } from './utils/ontology';
export { configureRandomSource } from './utils/ids';
export * from './librarianPrompt';
export { PromptService } from './services/PromptService';
export {
  ONTOLOGY_BACKFILL_BATCH_SIZE,
  ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS,
  ONTOLOGY_BACKFILL_RECHECK_MS,
  HEAL_BATCH_SIZE,
  HEAL_RECHECK_MS,
} from './services/MaintenanceService';
export { ONTOLOGY_BACKFILL_SYSTEM_PROMPT } from './prompts';

export function createWiki(db: SQLiteAdapter, options: WikiOptions): WikiMemory {
  return new WikiMemory(db, options);
}
