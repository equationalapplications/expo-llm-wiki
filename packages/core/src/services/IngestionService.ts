import { chunkText, withConcurrency, validateFact, parseJsonResponse, normalizeSourceRef, normalizeSourceHash } from '../utils/pure';
import { normalizeTitleKey } from '../utils/ontology';
import { generateId } from '../utils/ids';
import { WikiDuplicateHashError, WikiTransactionError } from '../types';
import type { WikiOptions, ExtractedFact, ExtractedFactWithOntology, WikiFact, OntologyUpdates } from '../types';
import type { SQLiteAdapter } from '../types';
import { extractSqliteCode } from '../db/sqliteCodes';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { SourceRefIndexRepository } from '../repositories/SourceRefIndexRepository';
import type { SearchService } from './SearchService';
import type { JobManager } from './JobManager';
import type { EmbeddingService } from './EmbeddingService';
import type { OntologyService, TitleIndexEntry } from './OntologyService';
import { PromptService } from './PromptService';
import { DEFAULT_MAX_CHUNK_LENGTH, DEFAULT_CHUNK_OVERLAP } from '../utils/chunkingDefaults';

export class IngestionService {
  private promptService: PromptService;

  constructor(
    private db: SQLiteAdapter,
    private prefix: string,
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private sourceRefIndexRepo: SourceRefIndexRepository,
    private searchService: SearchService,
    private jobManager: JobManager,
    private embeddingService: EmbeddingService,
    promptService?: PromptService,
    private ontologyService?: OntologyService,
  ) {
    // Fallback for direct instantiation outside WikiMemory facade (e.g. isolated tests).
    this.promptService = promptService ?? new PromptService(this.options.config?.prompts);
  }

  async ingestDocument(
    entityId: string,
    params: {
      sourceRef: string;
      sourceHash: string;
      documentChunk: string;
      maxChunkLength?: number;
      chunkOverlap?: number;
      chunkConcurrency?: number;
      promptOverride?: string;
    },
    opts?: { onDuplicateHash?: 'ingest' | 'skip' | 'throw' },
  ): Promise<{ truncated: boolean; chunks: number; duplicateOf?: string }> {
    const sourceRef = normalizeSourceRef(params.sourceRef);
    if (!sourceRef) throw new Error('Invalid sourceRef');

    const sourceHash = normalizeSourceHash(params.sourceHash);
    if (!sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

    const maxChunkLength = params.maxChunkLength ?? this.options.config?.maxChunkLength ?? DEFAULT_MAX_CHUNK_LENGTH;
    const rawOverlap = params.chunkOverlap ?? this.options.config?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    const chunkOverlap = Math.min(
      Number.isFinite(rawOverlap) && rawOverlap >= 0 ? Math.floor(rawOverlap) : DEFAULT_CHUNK_OVERLAP,
      maxChunkLength - 1
    );

    const rawConcurrency = params.chunkConcurrency ?? this.options.config?.chunkConcurrency ?? 1;
    const chunkConcurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;

    if (typeof params.documentChunk !== 'string') {
      throw new Error(`documentChunk must be a string, received ${typeof params.documentChunk}`);
    }

    // Acquire the hash + sourceRef ingest locks BEFORE the duplicate pre-check
    // so concurrent same-hash callers serialize here. Two callers that both
    // observe no duplicate at the pre-check can otherwise both reach the
    // INSERT and trip the v9 UNIQUE constraint — see
    // docs/superpowers/specs/2026-08-07-dependabot-concurrency-release-hygiene-design.md §B.
    const releaseIngestLocks = await this.jobManager.acquireIngestLocks(entityId, sourceRef, sourceHash);

    try {
      // Duplicate-hash guard: runs AFTER acquireIngestLocks but BEFORE chunking
      // and any LLM call. With the per-hash lock held by the previous holder,
      // we are guaranteed to observe any committed write they made before
      // releasing. Early duplicate returns go through the `finally` block
      // below so both locks are released cleanly.
      const onDuplicateHash = opts?.onDuplicateHash ?? 'ingest';
      if (onDuplicateHash !== 'ingest') {
        // Source_ref_index is the source of truth for "who currently holds
        // this hash"; the pre-check queries it directly. At most one sourceRef
        // can hold a given hash, so the result is either null (no live ref)
        // or a single sourceRef (which cannot echo the incoming ref because
        // the source_ref_index row is the OTHER writer's).
        const canonical = await this.sourceRefIndexRepo.findActiveByEntityAndHash(entityId, sourceHash);
        if (canonical !== null && canonical !== sourceRef) {
          if (onDuplicateHash === 'throw') {
            throw new WikiDuplicateHashError({ canonical, sourceHash, entityId });
          }
          // 'skip'
          return { truncated: false, chunks: 0, duplicateOf: canonical };
        }
      }

      const { chunks, truncated } = chunkText(params.documentChunk, maxChunkLength, chunkOverlap);
      if (chunks.length === 0) return { truncated: false, chunks: 0 };

      const chunkResults = await withConcurrency(
        chunks.map((chunk) => async () => {
          const ontologyContext = await this.ontologyService?.buildPromptContext(entityId) ?? null;
          const { systemPrompt, userPrompt } = this.promptService.buildIngestPrompt(
            chunk,
            params.promptOverride,
            ontologyContext,
          );
          const responseText = await this.options.llmProvider.generateText({ systemPrompt, userPrompt });
          const result = parseJsonResponse<{ facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }>(responseText);
          return {
            facts: (Array.isArray(result.facts) ? result.facts : [])
              .map(validateFact)
              .filter((f): f is ExtractedFact => f !== null),
            ontology_updates: result.ontology_updates,
          };
        }),
        chunkConcurrency
      );

      const seen = new Set<string>();
      const orderedChunkFacts: Array<{ facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }> = [];
      for (const chunkResult of chunkResults) {
        const dedupedFacts: ExtractedFact[] = [];
        for (const fact of chunkResult.facts) {
          const normalizedTitle = normalizeTitleKey(fact.title);
          if (!seen.has(normalizedTitle)) {
            seen.add(normalizedTitle);
            dedupedFacts.push(fact);
          }
        }
        orderedChunkFacts.push({ facts: dedupedFacts, ontology_updates: chunkResult.ontology_updates });
      }

      const now = Date.now();
      const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
      const deletedSourceFactIds: string[] = [];

      try {
        await this.db.withTransactionAsync(async (tx) => {
          deletedSourceFactIds.push(...(await this.entryRepo.findIdsBySource(entityId, sourceRef, null, tx, false)));
          await this.entryRepo.softDeleteBySource(entityId, tx, sourceRef, null);
          // Remove the prior run's source_ref_index row for this sourceRef so
          // the upsert below doesn't collide with ourselves. No-op when the
          // sourceRef has never been ingested before.
          await this.sourceRefIndexRepo.softDeleteByEntityAndSourceRef(entityId, sourceRef, tx);
          // Take ownership of (entity, hash). The partial UNIQUE index on
          // source_ref_index (entity_id, source_hash) WHERE deleted_at IS NULL
          // catches concurrent writers for the same hash from a DIFFERENT
          // sourceRef; the catch-and-translate below turns the violation into
          // the per-mode duplicate-hash outcome.
          await this.sourceRefIndexRepo.upsert(entityId, sourceHash, sourceRef, tx);

          const titleIndex = new Map<string, TitleIndexEntry>();
          const pendingEdges: Array<{
            sourceId: string;
            sourceType: string | null;
            edges: ExtractedFactWithOntology['edges'];
          }> = [];

          const existingFacts = await this.entryRepo.findRecentByEntityId(entityId, 500, tx);
          for (const existing of existingFacts) {
            titleIndex.set(normalizeTitleKey(existing.title), {
              id: existing.id,
              okf_type: existing.okf_type ?? null,
            });
          }

          let ontologyState = await this.ontologyService?.getEffectiveState(entityId, tx)
            ?? { mode: 'off' as const, manifest: { node_types: [], edge_types: [] } };
          let { mode, manifest } = ontologyState;

          for (const { facts, ontology_updates } of orderedChunkFacts) {
            if (mode === 'emergent' && ontology_updates && this.ontologyService) {
              manifest = await this.ontologyService.mergeEmergentUpdates(entityId, ontology_updates, tx);
              ontologyState = await this.ontologyService.getEffectiveState(entityId, tx);
              mode = ontologyState.mode;
            }

            for (const fact of facts) {
              const ontologyFact = fact as ExtractedFactWithOntology;
              const normalized = this.ontologyService?.validateAndNormalizeFact(ontologyFact, manifest, { strict: false })
                ?? { okf_type: null, edges: [] };

              const id = generateId('fact_');
              const wikiFact: WikiFact = {
                id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
                source_type: 'immutable_document', source_hash: sourceHash, source_ref: sourceRef,
                created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
                okf_type: normalized.okf_type,
              };
              await this.entryRepo.upsert(wikiFact, tx);
              insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });

              titleIndex.set(normalizeTitleKey(fact.title), { id, okf_type: normalized.okf_type });

              if (normalized.edges.length > 0) {
                pendingEdges.push({ sourceId: id, sourceType: normalized.okf_type, edges: normalized.edges });
              }
            }
          }

          for (const item of pendingEdges) {
            await this.ontologyService?.resolveAndPersistEdges(
              entityId, item.sourceId, item.sourceType, item.edges ?? [], manifest, titleIndex, tx, now,
            );
          }
        });
      } catch (err) {
        // A concurrent ingest for a DIFFERENT sourceRef beat us to the same
        // sourceHash between the pre-check above and this write — the
        // source_ref_index partial UNIQUE index (entity_id, source_hash)
        // rejected the upsert. Translate into the same duplicate-hash
        // outcome the pre-check would have produced, by mode. Any other
        // error re-throws unmodified. With the entries-level UNIQUE gone,
        // every UNIQUE violation inside this transaction originates from
        // source_ref_index, so the single check is sufficient.
        const sqliteCode = err instanceof WikiTransactionError
          ? err.sqliteErrorCode
          : extractSqliteCode(err);
        if (sqliteCode !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;

        const canonical = await this.sourceRefIndexRepo.findActiveByEntityAndHash(entityId, sourceHash);
        // No other live ref holds this hash (e.g. a different constraint
        // fired, or the racing writer's row was itself rolled back) — the
        // UNIQUE violation isn't explained by a duplicate-hash race; surface
        // the original error rather than a misleading result.
        if (canonical === null) throw err;

        if (onDuplicateHash === 'throw' || onDuplicateHash === 'ingest') {
          throw new WikiDuplicateHashError({ canonical, sourceHash, entityId });
        }
        // 'skip'
        return { truncated: false, chunks: 0, duplicateOf: canonical };
      }

      await this.searchService.sync(entityId);

      const uniqueDeletedSourceFactIds = Array.from(new Set(deletedSourceFactIds));
      for (const factId of uniqueDeletedSourceFactIds) {
        try {
          await this.embeddingService.notifyEmbeddingPersisted(entityId, factId, null);
        } catch (hookErr) {
          console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during ingest for ${factId}:`, hookErr);
        }
      }

      for (const fact of insertedFacts) {
        await this.embeddingService.embedFact(fact);
      }

      this.searchService.evictCache(entityId);
      return { truncated, chunks: chunks.length };

    } finally {
      releaseIngestLocks();
    }
  }
}
