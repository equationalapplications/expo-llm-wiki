import { WikiMemory } from './WikiMemory';
import type { SQLiteAdapter, WikiOptions } from './types';

export * from './types';
export { WikiMemory } from './WikiMemory';
export { BaseRepository } from './repositories/BaseRepository';
export { EntryRepository } from './repositories/EntryRepository';
export { formatContext } from './utils/formatContext';
export { formatMemoryDump } from './utils/formatMemoryDump';
export { parseEmbedding } from './utils/embedding';
export * from './librarianPrompt';

export function createWiki(db: SQLiteAdapter, options: WikiOptions): WikiMemory {
  return new WikiMemory(db, options);
}
