import * as SQLite from 'expo-sqlite';
import { WikiOptions } from './types';
import { WikiMemory } from './WikiMemory';

export * from './types';
export { WikiMemory } from './WikiMemory';
export { formatMemoryDump } from './utils/formatMemoryDump';

export function createWiki(db: SQLite.SQLiteDatabase, options: WikiOptions): WikiMemory {
  return new WikiMemory(db, options);
}
