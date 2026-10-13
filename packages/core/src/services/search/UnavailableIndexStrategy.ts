import { WikiSearchUnavailableError } from '../../types';
import type { IndexDocument, IndexSearchOptions, IndexSearchResult, IndexStrategy } from './IndexStrategy';

/**
 * Installed when FTS5 init fails after its retry under 'auto' (spec #280
 * Change 4). The ledger and FTS tables are left untouched; entries stay the
 * source of truth and the index converges on the next successful init.
 *
 * `drain` MUST be present: SearchService's drain-less branches
 * (sync/syncEntries/syncStale) fall back to findMiniSearchRows + replaceAll,
 * a full-table read (the measured 1M-entry OOM). A no-op drain keeps every
 * entry point on the ledger path.
 */
export class UnavailableIndexStrategy implements IndexStrategy {
  constructor(private readonly cause: unknown) {}

  async search(_query: string, _options: IndexSearchOptions): Promise<IndexSearchResult[]> {
    throw new WikiSearchUnavailableError(undefined, this.cause);
  }
  async replace(_entityId: string, _ids: readonly string[], _documents: readonly IndexDocument[]): Promise<void> {}
  async replaceEntity(_entityId: string, _documents: readonly IndexDocument[]): Promise<void> {}
  async replaceAll(_documents: readonly IndexDocument[]): Promise<void> {}
  hasIndexedEntity(_entityId: string): boolean { return false; }
  async drain(): Promise<void> {}
}
