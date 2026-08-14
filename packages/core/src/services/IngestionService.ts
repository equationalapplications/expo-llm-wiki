import { chunkText, withConcurrency, validateFact, parseJsonResponse, normalizeSourceRef, normalizeSourceHash } from '../utils/pure';
import { normalizeTitleKey } from '../utils/ontology';
import { generateId } from '../utils/ids';
import { WikiDuplicateHashError, WikiTransactionError, WikiStrictOntologyViolation } from '../types';
import type { WikiOptions, ExtractedFact, ExtractedFactWithOntology, WikiFact, OntologyUpdates, OntologyMode, OntologyManifest, WikiEdge } from '../types';
import type { SQLiteAdapter } from '../types';
import { extractSqliteCode } from '../db/sqliteCodes';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { SourceRefIndexRepository } from '../repositories/SourceRefIndexRepository';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import type { EdgeRepository } from '../repositories/EdgeRepository';
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
    private metadataRepo: MetadataRepository,
    private edgeRepo: EdgeRepository,
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
          // Capture the IDs of facts about to be soft-deleted so we can fire
          // onEmbeddingPersisted hooks AFTER the transaction commits. The
          // capture happens BEFORE the softDelete, so even though
          // upsertGraphCore performs its own findIdsBySource for edge
          // supersession, the IDs here are the canonical "what we retired"
          // set for the embedding lifecycle.
          deletedSourceFactIds.push(...(await this.entryRepo.findIdsBySource(entityId, sourceRef, null, tx, false)));

          // Build title index from existing facts (used to resolve LLM
          // target_title → target_id) and merge emergent ontology updates.
          const titleIndex = new Map<string, TitleIndexEntry>();
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

          // Convert LLM extraction into host-facing (nodes, edges) shape:
          // concrete sourceId / targetId per edge, with title→id resolution
          // already applied. upsertGraphCore owns the persistence step.
          const hostNodes: { id: string; type: string; title: string; body: string }[] = [];
          const hostEdges: { type: string; sourceId: string; targetId: string }[] = [];

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
              hostNodes.push({
                id,
                type: ontologyFact.okf_type ?? '',
                title: fact.title,
                body: fact.body,
              });
              insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });

              titleIndex.set(normalizeTitleKey(fact.title), { id, okf_type: normalized.okf_type });

              if (normalized.edges.length > 0) {
                const resolved = this.ontologyService?.resolveEdges(
                  entityId, id, normalized.okf_type, normalized.edges, manifest, titleIndex, now,
                ) ?? [];
                for (const e of resolved) {
                  hostEdges.push({ type: e.edge_type, sourceId: e.source_id, targetId: e.target_id });
                }
              }
            }
          }

          await this.upsertGraphCore(
            entityId,
            { sourceRef, sourceHash, nodes: hostNodes, edges: hostEdges },
            tx,
            { strict: false },
          );
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

  /**
   * Implements spec §2 data flow steps a–j with the host-facing
   * `{sourceRef, sourceHash, nodes, edges}` parameter shape. Shared between
   * `ingestDocument` (with `{ strict: false }` to preserve current behavior)
   * and `WikiMemory.upsertGraph` (which lets the persisted ontology mode
   * decide strictness).
   *
   * Runs ENTIRELY inside the supplied `tx`. Does not acquire locks, does not
   * open a nested transaction, does not perform post-commit work (search
   * sync, embedding, cache eviction). Those concerns remain in `ingestDocument`.
   *
   * The pre-flight validation (steps a–c) lives INSIDE this method per the
   * spec, so the public `WikiMemory.upsertGraph` can be a thin wrapper that
   * performs only the C2 probe before delegating.
   *
   * @returns Counts: nodesWritten (validated nodes persisted), edgesWritten
   *   (manifest-valid edges persisted), superseded (prior facts soft-deleted
   *   plus prior source-ref edges hard-deleted).
   */
  async upsertGraphCore(
    entityId: string,
    params: {
      sourceRef: string;
      sourceHash: string;
      nodes: readonly { id: string; type: string; title: string; body?: string }[];
      edges: readonly { type: string; sourceId: string; targetId: string; id?: string }[];
    },
    tx: SQLiteAdapter,
    opts?: { strict?: boolean },
  ): Promise<{ nodesWritten: number; edgesWritten: number; superseded: number }> {
    const now = Date.now();

    // (a) Read persisted ontology mode.
    const ontologyRow = await this.metadataRepo.getManifest(entityId, tx);
    const persistedMode: OntologyMode = ontologyRow?.mode ?? 'off';
    // `opts.strict === false` overrides the persisted mode (used by
    // ingestDocument to preserve its pre-strict-mode silent-drop behavior).
    // `opts.strict === true` forces strict. `opts.strict === undefined`
    // follows the persisted mode.
    const strictEffective = opts?.strict === false
      ? false
      : opts?.strict === true || persistedMode === 'strict';
    const manifest: OntologyManifest = ontologyRow?.manifest ?? { node_types: [], edge_types: [] };

    // (b) Pre-flight node validation — all-or-nothing under strict mode.
    // Build WikiFacts ready for upsert, with canonical okf_type.
    const wikiFacts: WikiFact[] = [];
    for (const node of params.nodes) {
      const factLike = { okf_type: node.type, edges: [] } as unknown as ExtractedFactWithOntology;
      const normalized = this.ontologyService?.validateAndNormalizeFact(factLike, manifest, {
        strict: strictEffective,
        entityId,
      }) ?? { okf_type: null, edges: [] };
      const wikiFact: WikiFact = {
        id: node.id,
        entity_id: entityId,
        title: node.title,
        body: node.body ?? '',
        tags: [],
        confidence: 'certain', // host-supplied deterministic nodes default to 'certain'
        source_type: 'immutable_document',
        source_hash: params.sourceHash,
        source_ref: params.sourceRef,
        created_at: now,
        updated_at: now,
        last_accessed_at: null,
        access_count: 0,
        deleted_at: null,
        okf_type: normalized.okf_type,
      };
      wikiFacts.push(wikiFact);
    }

    // (c) Pre-flight edge validation, grouped by sourceId.
    // C3: dangling targetIds are stored verbatim. We only validate against
    // the manifest's (source_type, edge_type) lookup.
    const sourceIdToType = new Map<string, string | null>();
    for (const fact of wikiFacts) sourceIdToType.set(fact.id, fact.okf_type ?? null);

    // When the manifest is empty (no node_types AND no edge_types), the user
    // has expressed no constraints; edges pass through verbatim. This is
    // the documented "no validation" semantics — the host gets exactly the
    // edges it supplied, including dangling targetIds (C3).
    const hasConstraints = (manifest.node_types?.length ?? 0) > 0 || (manifest.edge_types?.length ?? 0) > 0;

    const validEdges: WikiEdge[] = [];
    for (const edge of params.edges) {
      if (!hasConstraints) {
        validEdges.push({
          id: edge.id ?? generateId(),
          entity_id: entityId,
          source_id: edge.sourceId,
          target_id: edge.targetId,
          edge_type: edge.type,
          created_at: now,
        });
        continue;
      }
      const sourceType = sourceIdToType.get(edge.sourceId) ?? null;
      const candidates = (manifest.edge_types ?? []).filter(d =>
        d.type.toLowerCase() === edge.type.toLowerCase()
        && d.source_type.toLowerCase() === (sourceType ?? '').toLowerCase(),
      );
      const match = candidates[0];
      if (!match) {
        if (strictEffective) throw new WikiStrictOntologyViolation(entityId, 'edge', edge.type);
        continue;
      }
      validEdges.push({
        id: edge.id ?? generateId(),
        entity_id: entityId,
        source_id: edge.sourceId,
        target_id: edge.targetId,
        edge_type: match.type,
        created_at: now,
      });
    }

    // (d) Supersede prior facts for sourceRef.
    const deletedFactIds = await this.entryRepo.findIdsBySource(entityId, params.sourceRef, null, tx, false);
    await this.entryRepo.softDeleteBySource(entityId, tx, params.sourceRef, null);

    // (e) Supersede prior edges whose source is in deletedFactIds.
    const deletedEdgeCount = await this.edgeRepo.softDeleteBySourceFactIds(entityId, deletedFactIds, tx);

    // (f) Clear prior source_ref_index row for (entity, sourceRef).
    await this.sourceRefIndexRepo.softDeleteByEntityAndSourceRef(entityId, params.sourceRef, tx);

    // (g) Take ownership of (entity, hash).
    await this.sourceRefIndexRepo.upsert(entityId, params.sourceHash, params.sourceRef, tx);

    // (h) Write nodes (per-row outbox INSERT via entryRepo.upsert).
    for (const wikiFact of wikiFacts) {
      await this.entryRepo.upsert(wikiFact, tx);
    }

    // (i) Write edges (C3: dangling targets stored verbatim, no FK, no title-index resolution).
    for (const edge of validEdges) {
      await this.edgeRepo.addIgnoreDuplicate(edge, tx);
    }

    // (j) Return counts.
    return {
      nodesWritten: wikiFacts.length,
      edgesWritten: validEdges.length,
      superseded: deletedFactIds.length + deletedEdgeCount,
    };
  }
}
