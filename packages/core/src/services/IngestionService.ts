import { chunkText, withConcurrency, validateFact, parseJsonResponse, normalizeSourceRef, normalizeSourceHash } from '../utils/pure';
import { INGEST_SYSTEM_PROMPT } from '../prompts';
import { generateId } from '../utils/ids';
import type { WikiOptions, ExtractedFact, WikiFact } from '../types';
import type { SQLiteAdapter } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { SearchService } from './SearchService';
import type { JobManager } from './JobManager';

export class IngestionService {
  constructor(
    private db: SQLiteAdapter,
    private prefix: string,
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private searchService: SearchService,
    private jobManager: JobManager,
    private embedFactFn: (fact: { id: string; entity_id: string; title: string; body: string; tags: string | string[] }) => Promise<boolean>,
    private notifyPersistedFn: (entityId: string, factId: string, vector: Float32Array | null) => Promise<void>
  ) {}

  async ingestDocument(
    entityId: string,
    params: {
      sourceRef: string;
      sourceHash: string;
      documentChunk: string;
      maxChunkLength?: number;
      chunkOverlap?: number;
      chunkConcurrency?: number;
    }
  ): Promise<{ truncated: boolean; chunks: number }> {
    const sourceRef = normalizeSourceRef(params.sourceRef);
    if (!sourceRef) throw new Error('Invalid sourceRef');

    const sourceHash = normalizeSourceHash(params.sourceHash);
    if (!sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

    const maxChunkLength = params.maxChunkLength ?? this.options.config?.maxChunkLength ?? 12000;
    const rawOverlap = params.chunkOverlap ?? this.options.config?.chunkOverlap ?? 400;
    const chunkOverlap = Math.min(
      Number.isFinite(rawOverlap) && rawOverlap >= 0 ? Math.floor(rawOverlap) : 400,
      maxChunkLength - 1
    );

    const rawConcurrency = params.chunkConcurrency ?? this.options.config?.chunkConcurrency ?? 1;
    const chunkConcurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;

    if (typeof params.documentChunk !== 'string') {
      throw new Error(`documentChunk must be a string, received ${typeof params.documentChunk}`);
    }

    this.jobManager.acquireLock('ingest', entityId, sourceRef);

    try {
      const { chunks, truncated } = chunkText(params.documentChunk, maxChunkLength, chunkOverlap);
      if (chunks.length === 0) return { truncated: false, chunks: 0 };

      const chunkResults = await withConcurrency(
        chunks.map((chunk) => async () => {
          const userPrompt = `Document Chunk:\n${chunk}`;
          const responseText = await this.options.llmProvider.generateText({
            systemPrompt: INGEST_SYSTEM_PROMPT,
            userPrompt,
          });
          const result = parseJsonResponse<{ facts: ExtractedFact[] }>(responseText);
          return (Array.isArray(result.facts) ? result.facts : [])
            .map(validateFact)
            .filter((f): f is ExtractedFact => f !== null);
        }),
        chunkConcurrency
      );

      const seen = new Set<string>();
      const allValidFacts: ExtractedFact[] = [];
      for (const facts of chunkResults) {
        for (const fact of facts) {
          const normalized = fact.title.trim().toLowerCase().replace(/\s+/g, ' ');
          if (!seen.has(normalized)) {
            seen.add(normalized);
            allValidFacts.push(fact);
          }
        }
      }

      const now = Date.now();
      const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
      const deletedSourceFactIds: string[] = [];

      await this.db.withTransactionAsync(async (tx) => {
        deletedSourceFactIds.push(...(await this.entryRepo.findIdsBySource(entityId, sourceRef, null, tx, false)));
        await this.entryRepo.softDeleteBySource(entityId, tx, sourceRef, null);

        for (const fact of allValidFacts) {
          const id = generateId('fact_');
          const wikiFact: WikiFact = {
            id, entity_id: entityId, title: fact.title, body: fact.body, tags: fact.tags, confidence: fact.confidence,
            source_type: 'immutable_document', source_hash: sourceHash, source_ref: sourceRef,
            created_at: now, updated_at: now, last_accessed_at: null, access_count: 0, deleted_at: null,
          };
          await this.entryRepo.upsert(wikiFact, tx);
          insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
        }
      });

      await this.searchService.sync(entityId);

      const uniqueDeletedSourceFactIds = Array.from(new Set(deletedSourceFactIds));
      for (const factId of uniqueDeletedSourceFactIds) {
        try {
          await this.notifyPersistedFn(entityId, factId, null);
        } catch (hookErr) {
          console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during ingest for ${factId}:`, hookErr);
        }
      }

      for (const fact of insertedFacts) {
        await this.embedFactFn(fact);
      }

      this.searchService.evictCache(entityId);
      return { truncated, chunks: chunks.length };

    } finally {
      this.jobManager.releaseLock('ingest', entityId, sourceRef);
    }
  }
}
