// packages/core/src/utils/indexDoc.ts

import type { IndexDocument } from '../services/search/IndexStrategy';

/**
 * Convert one row from `EntryRepository.findMiniSearchRows[ByIds]` into the
 * shape both keyword-index strategies understand. Tags are JSON-parsed and
 * space-joined so the strategies can treat the value as opaque tokens.
 *
 * The previous inline `normalizeMiniSearchRow` lived on SearchService and
 * embedded the MiniSearch-specific JSON-parse behavior. Hoisting it here
 * keeps the strategy agnostic and lets the existing test (`SearchService.test.ts`
 * miniSearch-row fixtures) keep working.
 */
export function toIndexDoc(row: {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  tags: string;
}): IndexDocument {
  return {
    id: row.id,
    entity_id: row.entity_id,
    title: row.title,
    body: row.body,
    tags: (() => {
      try {
        const parsed = JSON.parse(row.tags);
        return Array.isArray(parsed) ? parsed.join(' ') : row.tags;
      } catch {
        return row.tags;
      }
    })(),
  };
}
