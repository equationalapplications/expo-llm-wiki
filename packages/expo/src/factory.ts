import type * as SQLite from 'expo-sqlite';
import { WikiMemory, type WikiOptions } from '@eq/wiki-core';
import { createExpoAdapter } from './adapter';

/**
 * Create a WikiMemory instance from an expo-sqlite SQLiteDatabase.
 * This factory is exported as a separate subpath (`@eq/wiki-expo/factory`)
 * so that callers can obtain `createWiki` without loading the React hooks
 * that `@eq/wiki-expo`'s main entry re-exports from `@eq/wiki-react`.
 */
export function createWiki(db: SQLite.SQLiteDatabase, options: WikiOptions): WikiMemory {
  return new WikiMemory(createExpoAdapter(db), options);
}
