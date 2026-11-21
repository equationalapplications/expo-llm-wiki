import type { SQLiteAdapter, WikiFact, RememberInput, ExtractedFactWithOntology, WikiOptions } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { OntologyService } from './OntologyService';
import type { SearchService } from './SearchService';
import type { EmbeddingService } from './EmbeddingService';
import { normalizeRememberInput } from '../utils/rememberInput';
import type { WikiDiagnosticInput } from '../utils/diagnostics';
import { emitDiagnostic, shouldEmitOntologyReceipt, nodeTypeReceipts } from '../utils/diagnostics';

/** Direct mutable-fact writes (spec `specs/core-remember/spec.md` §3.3–§3.6). */
export class RememberService {
  constructor(
    private db: SQLiteAdapter,
    private entryRepo: EntryRepository,
    private ontologyService: OntologyService,
    private searchService: SearchService,
    private embeddingService: EmbeddingService,
    private options?: Pick<WikiOptions, 'onDiagnostic'>,
  ) {}

  async remember(entityId: string, input: RememberInput): Promise<WikiFact> {
    const now = Date.now();
    const { fact, validFrom, okfType } = normalizeRememberInput(entityId, input, now);
    let stored: WikiFact | undefined;
    // Receipts buffer until the transaction COMMITS: a rolled-back write
    // (failed upsert/setTemporal/read-back/commit) must deliver none
    // (CodeRabbit #441; mirrors the DiagnosticBuffer flush-after-commit
    // pattern the other write paths use).
    const pendingReceipts: WikiDiagnosticInput[] = [];

    await this.db.withTransactionAsync(async (tx) => {
      if (okfType !== null) {
        const { mode, manifest } = await this.ontologyService.getEffectiveState(entityId, tx);
        // Mode gate (CodeRabbit #441): a host with ontology 'off' sees no
        // ontology behavior at the remember door — the caller's slug is
        // stored verbatim, no fold, no drop, no throw, no receipt
        // (release-surface guarantee). "Never replace a type a person
        // stated" extends to the off mode.
        if (mode !== 'off') {
          // Same rule as an upsertGraph node type (IngestionService.upsertGraphCore):
          // canonical slug when the manifest knows it, a throw under strict, null otherwise.
          const factLike = { okf_type: okfType, edges: [] } as unknown as ExtractedFactWithOntology;
          const normalized = this.ontologyService.validateAndNormalizeFact(factLike, manifest, {
            strict: mode === 'strict',
            entityId,
          });
          fact.okf_type = normalized.okf_type;
          // Person-door receipts (spec §4): in strict mode a miss throws inside
          // validateAndNormalizeFact (before any commit — the throw is the only
          // signal, no receipt), so these only fire in the non-strict modes.
          if (shouldEmitOntologyReceipt(mode)) {
            for (const receipt of nodeTypeReceipts(
              { entityId, operation: 'remember', trigger: 'call' },
              fact.id,
              okfType,
              normalized.okf_type,
              normalized.match,
            )) {
              pendingReceipts.push(receipt);
            }
          }
        } else {
          // Off mode: store the caller's slug verbatim — no fold, no drop.
          fact.okf_type = okfType;
        }
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

    // Commit landed — now deliver the buffered receipts.
    for (const receipt of pendingReceipts) {
      emitDiagnostic(this.options ?? {}, receipt);
    }

    await this.searchService.syncEntries(entityId, [fact.id]);
    // A delete that lands during the vector call is settled inside
    // storeFactVector (spec durable-vector-removal §5.7, G10).
    await this.embeddingService.embedFact(
      { id: fact.id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags },
      { operation: 'remember', trigger: 'call' },
    );
    this.searchService.evictCache(entityId);
    return stored!;
  }

}
