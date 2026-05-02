import type * as SQLite from 'expo-sqlite';
import { WikiMemory, type WikiOptions } from '@equationalapplications/core-llm-wiki';
import { createExpoAdapter } from './adapter';

/**
 * Create a WikiMemory instance from an expo-sqlite SQLiteDatabase.
 * This factory is exported as a separate subpath (`@equationalapplications/expo-llm-wiki/factory`)
 * so that callers can obtain `createWiki` without loading the React hooks
 * that `@equationalapplications/expo-llm-wiki`'s main entry re-exports from `@equationalapplications/react-llm-wiki`.
 */
export function createWiki(db: SQLite.SQLiteDatabase, options: WikiOptions): WikiMemory {
  return new WikiMemory(createExpoAdapter(db), options);
}
