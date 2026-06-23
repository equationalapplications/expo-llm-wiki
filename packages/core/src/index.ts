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
export * from './librarianPrompt';
export { PromptService } from './services/PromptService';

export function createWiki(db: SQLiteAdapter, options: WikiOptions): WikiMemory {
  return new WikiMemory(db, options);
}
