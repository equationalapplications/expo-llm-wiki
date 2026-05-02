import type * as SQLite from 'expo-sqlite';
import { WikiMemory, type WikiOptions } from '@eq/wiki-core';
import { createExpoAdapter } from './adapter';

export * from '@eq/wiki-core';

export function createWiki(db: SQLite.SQLiteDatabase, options: WikiOptions): WikiMemory {
  return new WikiMemory(createExpoAdapter(db), options);
}
