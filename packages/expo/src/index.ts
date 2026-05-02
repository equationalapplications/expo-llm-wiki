import type * as SQLite from 'expo-sqlite';
import { WikiMemory, type WikiOptions } from '@equationalapplications/core-llm-wiki';
import { createExpoAdapter } from './adapter';

// Re-exports all core types and utilities. The `createWiki` exported below
// intentionally shadows the one from @equationalapplications/core-llm-wiki, binding the expo-sqlite adapter.
export * from '@equationalapplications/core-llm-wiki';
export * from '@equationalapplications/react-llm-wiki';

export function createWiki(db: SQLite.SQLiteDatabase, options: WikiOptions): WikiMemory {
  return new WikiMemory(createExpoAdapter(db), options);
}
