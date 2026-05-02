import { WikiMemory } from './WikiMemory';
import type { SQLiteAdapter, WikiOptions } from './types';

export * from './types';
export { WikiMemory } from './WikiMemory';
export { formatContext } from './utils/formatContext';
export { formatMemoryDump } from './utils/formatMemoryDump';

export function createWiki(db: SQLiteAdapter, options: WikiOptions): WikiMemory {
  return new WikiMemory(db, options);
}
