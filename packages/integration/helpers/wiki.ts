import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { LLMProvider, WikiConfig, SQLiteAdapter } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from './db';

export function makeWiki(
  llm: LLMProvider,
  config?: WikiConfig
): { wiki: WikiMemory; db: SQLiteAdapter } {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: llm, config });
  return { wiki, db };
}
