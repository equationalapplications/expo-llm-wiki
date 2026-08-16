import { chunkText, withConcurrency, validateFact, parseJsonResponse, normalizeSourceRef, normalizeSourceHash, safeErrorToString } from '../utils/pure';
import { normalizeTitleKey } from '../utils/ontology';
import { generateId } from '../utils/ids';
import { WikiParseError, WikiIngestEmptyError, WikiDuplicateHashError, WikiTransactionError, WikiStrictOntologyViolation } from '../types';
import type { ChunkFailure, WikiOptions, ExtractedFact, ExtractedFactEdge, ExtractedFactWithOntology, WikiFact, OntologyUpdates, WikiEdge, IngestDocumentResult } from '../types';
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

type ChunkResult =
  | { status: 'ok'; facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }
  | { status: 'failed'; error: ChunkFailure };

/** Shape returned by {@link IngestionService.ingestDocument} when no chunks
 * ran — used for both the `chunks.length === 0` early-return and the
 * `onDuplicateHash: 'skip'` early-return. `duplicateOf` is set only when
 * the skip is owed to a duplicate-hash collision; undefined is allowed on
 * the optional field without `exactOptionalPropertyTypes`. */
function zeroChunkResult(duplicateOf?: string): IngestDocumentResult {
  return {
    truncated: false,
    chunks: 0,
    ingestedChunks: 0,
    failedChunks: 0,
    duplicateOf,
  };
}

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
  ): Promise<IngestDocumentResult> {
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
          return zeroChunkResult(canonical);
        }
      }

      const { chunks, truncated } = chunkText(params.documentChunk, maxChunkLength, chunkOverlap);
      if (chunks.length === 0) return zeroChunkResult();

      // Hoist the ontology prompt context out of the per-chunk closure:
      // `buildPromptContext(entityId)` depends only on entityId and reads
      // the manifest ONCE; running it per chunk is N-1 wasted DB reads.
      // Hoisting also makes its DB-systemic nature structural — a fault
      // surfaces before any LLM tokens are spent, not buried under
      // `WikiIngestEmptyError` after the first LLM call. See spec §3.
      const ontologyContext = await this.ontologyService?.buildPromptContext(entityId) ?? null;

      const chunkResults = await withConcurrency(
        chunks.map((chunk, chunkIndex) => async () => {
          // Prompt building is INTENTIONALLY outside the try — it's a
          // template-driven step whose failures (malformatted
          // `promptOverride`, configured-template regression) are systemic
          // and identical for every chunk. Surfacing as a raw throw means
          // the host sees the real cause on the first chunk instead of
          // after `chunks.length` LLM calls under a `WikiIngestEmptyError`.
          // See spec §3.
          const { systemPrompt, userPrompt } = this.promptService.buildIngestPrompt(
            chunk,
            params.promptOverride,
            ontologyContext,
          );
          try {
            const responseText = await this.options.llmProvider.generateText({ systemPrompt, userPrompt });
            const result = parseJsonResponse<{ facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }>(responseText);
            return {
              status: 'ok' as const,
              facts: (Array.isArray(result.facts) ? result.facts : [])
                .map(validateFact)
                .filter((f): f is ExtractedFact => f !== null),
              ontology_updates: result.ontology_updates,
            };
          } catch (e) {
            const failure: ChunkFailure = e instanceof WikiParseError
              ? {
                  chunkIndex,
                  sourceRef,
                  source: 'parse',
                  tier: e.tier,
                  position: e.position,
                  message: e.message,
                }
              : {
                  chunkIndex,
                  sourceRef,
                  source: 'llm',
                  // `safeErrorToString` is a non-throwing coercion: an LLM
                  // provider may reject with a non-Error value, and even
                  // `String(e)` itself can throw when `e.toString()` throws.
                  // Letting such an exception escape this catch would cause
                  // `withConcurrency` to reject, discarding every sibling
                  // chunk's results — the exact failure mode this per-chunk
                  // try/catch exists to prevent. Keeping the value in the
                  // `ChunkFailure` preserves the typed diagnostic for
                  // callers (see parseFailures) without unwinding the loop.
                  position: null,
                  message: safeErrorToString(e),
                };
            // Spec §2: log once per failure, NEVER include the raw response.
            // We deliberately omit `failure.message` here:
            //  - For `source: 'parse'` the message is the parser's diagnostic
            //    (safe) but in the interest of a single, narrow warn format we
            //    surface only the tier (and position when known) on the log.
            //  - For `source: 'llm'` the message is provider-controlled: an
            //    LLM SDK commonly surfaces the raw response body, document
            //    content, or a multi-megabyte HTTP error in `Error.message`.
            //    Even a parser-diagnostic message that happens to share bytes
            //    with a never-logged raw response would leak if we printed
            //    it verbatim. The full message stays in `parseFailures` for
            //    callers that want it; the warn line is intentionally narrow.
            const total = chunks.length;
            const tierTag = failure.tier ? ` tier=${failure.tier}` : '';
            const positionTag = failure.position !== null ? ` position=${failure.position}` : '';
            console.warn(
              `[WikiMemory] ingest chunk ${chunkIndex + 1}/${total} ${failure.source} failed (sourceRef=${sourceRef};${tierTag}${positionTag})`,
            );
            return { status: 'failed' as const, error: failure };
          }
        }),
        chunkConcurrency
      );

      // Single pass: collect failures, dedup ok facts against the cross-chunk
      // `seen` set, and count `ingestedChunks` / `failedChunks` together.
      let ingestedChunks = 0;
      let failedChunks = 0;
      const failures: ChunkFailure[] = [];
      const seen = new Set<string>();
      const orderedChunkFacts: Array<{ facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }> = [];
      for (const slot of chunkResults) {
        if (slot.status === 'failed') {
          failedChunks++;
          failures.push(slot.error);
          continue;
        }
        ingestedChunks++;
        const dedupedFacts: ExtractedFact[] = [];
        for (const fact of slot.facts) {
          const normalizedTitle = normalizeTitleKey(fact.title);
          if (!seen.has(normalizedTitle)) {
            seen.add(normalizedTitle);
            dedupedFacts.push(fact);
          }
        }
        orderedChunkFacts.push({ facts: dedupedFacts, ontology_updates: slot.ontology_updates });
      }

      // Total failure: throw WikiIngestEmptyError before any persistence runs.
      // A silent zero-fact ingest is a worse regression than a typed throw.
      if (failedChunks === chunks.length) {
        throw new WikiIngestEmptyError({
          parseFailures: failures,
          sourceRef,
          chunks: chunks.length,
        });
      }

      const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
      const deletedSourceFactIds: string[] = [];

      try {
        if (failedChunks === 0) {
          // Happy path — full upsertGraphCore supersession + ownership.
          const fullResult = await this.db.withTransactionAsync(async (tx) => {
            return await this.runFullUpsertGraph(entityId, sourceRef, sourceHash, orderedChunkFacts, tx);
          });
          deletedSourceFactIds.push(...fullResult.deletedSourceFactIds);
          insertedFacts.push(...fullResult.insertedFacts);
        } else {
          // Partial path — append dedup-only, NO supersession, NO ownership update.
          // See spec §4.2. `insertedFacts` carries the per-fact descriptors
          // the post-commit hook loop needs to fire `embedFact` after the
          // partial transaction commits — without this, partial-row facts
          // would never reach the embedding service and the vector ranker
          // would never be notified for them (despite them being live in
          // the entries table). See the copilot review note on
          // `embeddingService.embedFact` vs. the partial-path gate.
          const partialResult = await this.db.withTransactionAsync(async (tx) => {
            const flat: ExtractedFact[] = [];
            for (const slot of orderedChunkFacts) flat.push(...slot.facts);
            return await this.appendPartialFacts(entityId, sourceRef, flat, tx);
          });
          insertedFacts.push(...partialResult.insertedDescriptors);
        }
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
        return zeroChunkResult(canonical);
      }

      await this.searchService.sync(entityId);

      // Post-commit hook loop. `notifyEmbeddingPersisted(entityId, factId, null)`
      // is the embedding-lifecycle retirement signal — only relevant on the
      // full path, which is the only path that calls `softDeleteBySource`.
      // `embedFact` runs for every newly-inserted fact on EITHER path: the
      // partial path appends live rows, and those rows must participate in
      // semantic retrieval just like full-path facts — otherwise a 6-of-7
      // partial commit would leave the embedded fields null until a later
      // full retry, and a vector ranker wouldn't be notified for them.
      // (The earlier gate `if (failedChunks === 0)` blocked both halves of
      // this block on the partial path and was the bug copilot flagged.)
      if (failedChunks === 0) {
        const uniqueDeletedSourceFactIds = Array.from(new Set(deletedSourceFactIds));
        for (const factId of uniqueDeletedSourceFactIds) {
          try {
            await this.embeddingService.notifyEmbeddingPersisted(entityId, factId, null);
          } catch (hookErr) {
            console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during ingest for ${factId}:`, hookErr);
          }
        }
      }

      for (const fact of insertedFacts) {
        await this.embeddingService.embedFact(fact);
      }

      this.searchService.evictCache(entityId);

      const result: IngestDocumentResult = {
        truncated,
        chunks: chunks.length,
        ingestedChunks,
        failedChunks,
      };
      if (failedChunks > 0) result.parseFailures = failures;
      return result;

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
      nodes: readonly { id: string; type: string; title: string; body?: string; tags?: readonly string[]; confidence?: 'certain' | 'inferred' | 'tentative' }[];
      edges: readonly { type: string; sourceId: string; targetId: string; id?: string }[];
    },
    tx: SQLiteAdapter,
    opts?: { strict?: boolean },
  ): Promise<{ nodesWritten: number; edgesWritten: number; superseded: number }> {
    const now = Date.now();

    // (a) Resolve the effective ontology state through OntologyService rather
    // than reading metadataRepo.getManifest directly. OntologyService handles
    // the seedManifests contract (types.ts:65-66 — seeds are persisted on
    // first access when a tx is supplied, and cached otherwise) and the
    // ontologyConfig.mode fallback. Reading the repo directly here would
    // return null for an entity that has only a seedManifests entry, leaving
    // the strict mode silently unwritten and letting out-of-manifest data
    // through even when the host configured strict via the seed.
    const ontologyState = await this.ontologyService?.getEffectiveState(entityId, tx)
      ?? { mode: 'off' as const, manifest: { node_types: [], edge_types: [] } };
    let { mode, manifest } = ontologyState;
    // `opts.strict === false` overrides the persisted mode (used by
    // ingestDocument to preserve its pre-strict-mode silent-drop behavior).
    // `opts.strict === true` forces strict. `opts.strict === undefined`
    // follows the persisted mode.
    const strictEffective = opts?.strict === false
      ? false
      : opts?.strict === true || mode === 'strict';

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
        // Public upsertGraph callers don't supply tags/confidence, so they
        // default to [] / 'certain' for deterministic AST-grade facts.
        // ingestDocument routes through this method for the LLM path and
        // forwards the LLM-supplied tags + confidence, preserving the prior
        // behavior (search filterability, heal-candidate selection, runReembed
        // embedding-text signal).
        tags: node.tags ? Array.from(node.tags) : [],
        confidence: node.confidence ?? 'certain',
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
      // Per spec step (c): "for each source node `n` in `params.nodes`, validate
      // that node's outgoing edges". Edges whose sourceId references a node
      // OUTSIDE this call's nodes (a prior sourceRef's node) cannot have their
      // source type resolved without a DB lookup, so they pass through verbatim
      // — same lenient treatment C3 gives dangling targetIds.
      if (!sourceIdToType.has(edge.sourceId)) {
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
      const sourceType = sourceIdToType.get(edge.sourceId);
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
    // Count actual inserts via addIgnoreDuplicate; an edge whose id already
    // exists with the same (entity_id, source_id, target_id, edge_type) tuple
    // — e.g. a deterministic edge id reused across two distinct sourceRefs —
    // is silently skipped (returns false) and must NOT be counted as written.
    // Counting `validEdges.length` over-reports when caller-supplied edge ids
    // collide across sourceRefs, breaking the spec's C3 invariant that the
    // caller can rely on `edgesWritten` to assert "did you drop anything?".
    let edgesInsertedCount = 0;
    for (const edge of validEdges) {
      const inserted = await this.edgeRepo.addIgnoreDuplicate(edge, tx);
      if (inserted) edgesInsertedCount++;
    }

    // (j) Return counts.
    return {
      nodesWritten: wikiFacts.length,
      edgesWritten: edgesInsertedCount,
      superseded: deletedFactIds.length + deletedEdgeCount,
    };
  }

  /**
   * Full supersession + ownership path: identical to the pre-issue-#92 behavior
   * for the happy path. Called from the `failedChunks === 0` branch of
   * `ingestDocument`. Runs INSIDE the caller's tx.
   *
   * Returns `{ deletedSourceFactIds, insertedFacts }` so the caller can fire
   * post-commit hooks (embedding lifecycle) AFTER the transaction commits.
   * On the partial path the caller never invokes this method; the empty
   * arrays stay empty.
   */
  private async runFullUpsertGraph(
    entityId: string,
    sourceRef: string,
    sourceHash: string,
    orderedChunkFacts: Array<{ facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }>,
    tx: SQLiteAdapter,
  ): Promise<{ deletedSourceFactIds: string[]; insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> }> {
    const deletedSourceFactIds: string[] = [];
    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];

    // Capture the IDs of facts about to be soft-deleted so we can fire
    // onEmbeddingPersisted hooks AFTER the transaction commits. The
    // capture happens BEFORE the softDelete, so even though
    // upsertGraphCore performs its own findIdsBySource for edge
    // supersession, the IDs here are the canonical "what we retired"
    // set for the embedding lifecycle.
    deletedSourceFactIds.push(...(await this.entryRepo.findIdsBySource(entityId, sourceRef, null, tx, false)));

    // Build title index from PRIOR facts EXCLUDING the current sourceRef.
    // Facts from this sourceRef are about to be superseded by
    // upsertGraphCore step (d); seeding them here would let resolveEdges
    // target a soon-to-be-retired fact and leave the new edge pointing
    // at a soft-deleted record (the new edge's source is fresh, so step
    // (e) only retires edges whose SOURCE is in the deleted-fact set).
    // The sourceRef exclusion is applied in SQL (via
    // findRecentByEntityId's excludeSourceRef param) so the 500-row
    // LIMIT applies to usable rows only — a re-ingest where the current
    // sourceRef owns most recent facts otherwise leaves the index empty
    // after the post-query filter, silently losing cross-sourceRef edges
    // that a first ingest would have resolved.
    const titleIndex = new Map<string, TitleIndexEntry>();
    const existingFacts = await this.entryRepo.findRecentByEntityId(entityId, 500, tx, sourceRef);
    for (const existing of existingFacts) {
      titleIndex.set(normalizeTitleKey(existing.title), {
        id: existing.id,
        okf_type: existing.okf_type ?? null,
      });
    }

    let ontologyState = await this.ontologyService?.getEffectiveState(entityId, tx)
      ?? { mode: 'off' as const, manifest: { node_types: [], edge_types: [] } };
    let { mode, manifest } = ontologyState;

    // Two-pass conversion of LLM extraction into host-facing shape.
    // Pass 1 (below) populates hostNodes and stages raw edge requests
    // for every replacement fact — facts from this ingest enter the
    // titleIndex as they're added, so forward references resolve in
    // pass 2 against the FINALIZED index. Pass 2 then resolves each
    // staged request into concrete hostEdges. upsertGraphCore owns the
    // persistence step.
    const hostNodes: { id: string; type: string; title: string; body: string; tags?: readonly string[]; confidence?: 'certain' | 'inferred' | 'tentative' }[] = [];
    const rawEdgeRequests: { sourceId: string; sourceType: string | null; edges: ExtractedFactEdge[] }[] = [];
    const now = Date.now();

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
          // Forward the LLM-extracted tags/confidence through the
          // extracted-shape upsertGraphCore path so the entries row
          // stores them (search filterability, heal-candidate
          // selection, runReembed embedding-text signal). The public
          // WikiMemory.upsertGraph API doesn't accept tags/confidence
          // — host-supplied deterministic nodes default to [] and
          // 'certain' as documented.
          tags: fact.tags,
          confidence: fact.confidence,
        });
        insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });

        titleIndex.set(normalizeTitleKey(fact.title), { id, okf_type: normalized.okf_type });

        if (normalized.edges.length > 0) {
          rawEdgeRequests.push({ sourceId: id, sourceType: normalized.okf_type, edges: normalized.edges });
        }
      }
    }

    // Pass 2: resolve every staged edge against the finalized title
    // index. By this point the index contains both surviving prior
    // facts (excluding this sourceRef) AND every replacement fact from
    // this ingest, so forward references resolve correctly and no
    // resolved edge points at a fact that's about to be soft-deleted.
    const hostEdges: { type: string; sourceId: string; targetId: string }[] = [];
    for (const req of rawEdgeRequests) {
      const resolved = this.ontologyService?.resolveEdges(
        entityId, req.sourceId, req.sourceType, req.edges, manifest, titleIndex, now,
      ) ?? [];
      for (const e of resolved) {
        hostEdges.push({ type: e.edge_type, sourceId: e.source_id, targetId: e.target_id });
      }
    }

    await this.upsertGraphCore(
      entityId,
      { sourceRef, sourceHash, nodes: hostNodes, edges: hostEdges },
      tx,
      { strict: false },
    );

    return { deletedSourceFactIds, insertedFacts };
  }

  /**
   * Partial-commit path for `ingestDocument`. Inserts ONLY facts whose
   * normalized title is not already in the live set for this (entityId,
   * sourceRef). Does NOT call `entryRepo.softDeleteBySource` (no
   * supersession) and does NOT call `sourceRefIndexRepo.upsert` (no
   * ownership). Edges are NOT resolved on this path (no ontology-context
   * build, no `resolveEdges`, no `mergeEmergentUpdates`). Stale edges from
   * prior attempts are recovered on the next full run's supersession.
   *
   * Source-hash is stored as NULL on partial rows. `findLatestSourceHash`
   * reads from the most recently updated live row for the sourceRef, so
   * storing the incoming hash here would cause `hasChanged` to return
   * `false` on a same-hash retry — the failed chunks would never get a
   * second chance. With NULL, a retry sees `storedHash === null`, `hasChanged`
   * returns `true`, and the partial commit's sibling rows remain live
   * (deduped, not superseded) for the next attempt to extend.
   *
   * Runs INSIDE the caller's `tx`. Does not open a nested transaction.
   * Returns `{ inserted, skippedDuplicate }` for observability.
   */
  private async appendPartialFacts(
    entityId: string,
    sourceRef: string,
    dedupedFacts: ExtractedFact[],
    tx: SQLiteAdapter,
  ): Promise<{
    inserted: number;
    skippedDuplicate: number;
    /** Descriptors for the rows this call actually inserted, in the same
     * shape `runFullUpsertGraph` returns — the post-commit hook loop
     * passes these to `embedFact`. Without them, partial-path inserts
     * would skip the embedding service entirely. */
    insertedDescriptors: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }>;
  }> {
    // Partial rows are intentionally stored with `source_hash: null` so
    // `hasChanged` keeps returning true on every retry of the same hash —
    // the failed chunks get a second chance. The full path stamps the actual
    // hash via `runFullUpsertGraph`; this helper deliberately does not.
    // Load the live (sourceRef, *) rows so we can dedup by title against prior
    // partial attempts AND prior full attempts. includeDeleted=false matches
    // the pre-supersession dedup semantics of the full path. Per spec §4.2:
    // `findIdsBySource` returns the ids; `findByIds` resolves titles.
    const liveIds = await this.entryRepo.findIdsBySource(entityId, sourceRef, null, tx, false);
    const liveFacts = liveIds.length === 0
      ? []
      : await this.entryRepo.findByIds(liveIds, [entityId], tx);
    const liveTitles = new Set(liveFacts.map((f) => normalizeTitleKey(f.title)));

    let inserted = 0;
    let skippedDuplicate = 0;
    const now = Date.now();
    const insertedDescriptors: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
    for (const fact of dedupedFacts) {
      const normalizedTitle = normalizeTitleKey(fact.title);
      if (liveTitles.has(normalizedTitle)) {
        skippedDuplicate++;
        continue;
      }
      liveTitles.add(normalizedTitle);

      const id = generateId('fact_');
      const wikiFact: WikiFact = {
        id,
        entity_id: entityId,
        title: fact.title,
        body: fact.body,
        tags: fact.tags,
        confidence: fact.confidence,
        source_type: 'immutable_document',
        // source_hash: null on partial rows — see method docstring. The
        // full path stamps the actual hash; partial rows stay hash-less so
        // `hasChanged` keeps returning true for retries.
        source_hash: null,
        source_ref: sourceRef,
        created_at: now,
        updated_at: now,
        last_accessed_at: null,
        access_count: 0,
        deleted_at: null,
        okf_type: null,
      };
      await this.entryRepo.upsert(wikiFact, tx);
      // Mirror the shape `runFullUpsertGraph` returns so the caller's
      // post-commit `embedFact` loop is path-agnostic.
      insertedDescriptors.push({
        id,
        entity_id: entityId,
        title: fact.title,
        body: fact.body,
        tags: JSON.stringify(fact.tags),
      });
      inserted++;
    }
    return { inserted, skippedDuplicate, insertedDescriptors };
  }
}
