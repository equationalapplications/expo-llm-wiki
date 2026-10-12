import { WikiSearchUnavailableError } from '../../types';
import type { IndexDocument, IndexSearchOptions, IndexSearchResult, IndexStrategy } from './IndexStrategy';

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