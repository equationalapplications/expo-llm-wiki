import type { SQLiteAdapter, WikiFact, RememberInput, ExtractedFactWithOntology } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { OntologyService } from './OntologyService';
import type { SearchService } from './SearchService';
import type { EmbeddingService } from './EmbeddingService';
import type { VectorRemovalService } from './VectorRemovalService';
import { normalizeRememberInput } from '../utils/rememberInput';

/** Direct mutable-fact writes (spec `specs/core-remember/spec.md` §3.3–§3.6). */
export class RememberService {
  constructor(
    private db: SQLiteAdapter,
    private entryRepo: EntryRepository,
    private ontologyService: OntologyService,
    private searchService: SearchService,
    private embeddingService: EmbeddingService,
    private vectorRemoval?: VectorRemovalService,
  ) {}

  async remember(entityId: string, input: RememberInput): Promise<WikiFact> {
    const now = Date.now();
    const { fact, validFrom, okfType } = normalizeRememberInput(entityId, input, now);
    let stored: WikiFact | undefined;

    await this.db.withTransactionAsync(async (tx) => {
      if (okfType !== null) {
        // Same rule as an upsertGraph node type (IngestionService.upsertGraphCore):
        // canonical slug when the manifest knows it, a throw under strict, null otherwise.
        const { mode, manifest } = await this.ontologyService.getEffectiveState(entityId, tx);
        const factLike = { okf_type: okfType, edges: [] } as unknown as ExtractedFactWithOntology;
        fact.okf_type = this.ontologyService.validateAndNormalizeFact(factLike, manifest, {
          strict: mode === 'strict',
          entityId,
        }).okf_type;
      }
      await this.entryRepo.upsert(fact, tx);
      if (validFrom !== undefined) {
        await this.entryRepo.setTemporal(fact.id, entityId, { valid_from: validFrom }, tx);
      }
      // The return value is the stored row, not the literal: defaults the INSERT
      // bound and the read-time isStale / trustTier come from the mapper.
      const [readBack] = await this.entryRepo.findByIds([fact.id], [entityId], tx);
      if (!readBack) {
        throw new Error('remember(): the stored fact could not be read back; the SQLiteAdapter did not perform the write');
      }
      stored = readBack;
    });

    await this.searchService.syncEntries(entityId, [fact.id]);
    try {
      await this.embeddingService.embedFact(
        { id: fact.id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags },
        { operation: 'remember', trigger: 'call' },
      );
    } finally {
      await this.settleAfterEmbed(entityId, fact.id, 'remember');
    }
    this.searchService.evictCache(entityId);
    return stored!;
  }

  /** G10 (spec §5.7): a fact deleted while its embed ran ends with a removal call. Never throws. */
  private async settleAfterEmbed(entityId: string, id: string, operation: 'remember'): Promise<void> {
    if (!this.vectorRemoval) return;
    try {
      if (await this.embeddingService.afterVectorCall(entityId, id)) {
        await this.vectorRemoval.deliverRemovals(entityId, [id], operation, 'call', []);
      }
    } catch (err) {
      console.warn(`[WikiMemory] post-embed removal check failed for ${id}:`, err);
    }
  }
}
