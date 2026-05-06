/**
 * Vanilla-JS entry for @equationalapplications/react-llm-wiki.
 * Import from '@equationalapplications/react-llm-wiki/js' to use WikiMemory
 * without bundling React or any hook code.
 *
 * Provides:
 *   - All core exports (createWiki, WikiMemory, types, …)
 *   - Standalone read() / write() helpers that wrap the WikiMemory instance methods
 */
export * from '@equationalapplications/core-llm-wiki';

import type { WikiMemory, MemoryBundle, WikiEvent, ReadOptions } from '@equationalapplications/core-llm-wiki';

/**
 * Standalone read helper. Equivalent to `wiki.read(entityId, query, options)`.
 */
export function read(
  wiki: WikiMemory,
  entityId: string,
  query: string,
  options?: ReadOptions,
): Promise<MemoryBundle> {
  return wiki.read(entityId, query, options);
}

/**
 * Standalone write helper. Equivalent to `wiki.write(entityId, event)`.
 */
export function write(
  wiki: WikiMemory,
  entityId: string,
  event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>,
): Promise<void> {
  return wiki.write(entityId, event);
}
