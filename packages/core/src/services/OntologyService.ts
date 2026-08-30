import type {
  OntologyConfig,
  OntologyManifest,
  OntologyMode,
  OntologyPromptContext,
  OntologyUpdates,
  ExtractedFactWithOntology,
  ExtractedFactEdge,
  SQLiteAdapter,
  WikiEdge,
} from '../types';
import { WikiStrictOntologyViolation } from '../types';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import type { EdgeRepository } from '../repositories/EdgeRepository';
import { buildOntologyPromptAppendix } from '../prompts/ontology';
import {
  emptyManifest,
  normalizeTitleKey,
  resolveNodeType,
  resolveEdgeDefinitions,
  typeSatisfies,
  validateInlineEdges,
  validateManifest,
} from '../utils/ontology';
import { generateId } from '../utils/ids';

export type TitleIndexEntry = { id: string; okf_type: string | null };

/**
 * Coordinates ontology mode resolution, manifest caching, LLM output validation, and edge persistence.
 * Cache is per WikiMemory instance (single-process); not shared across instances.
 */
export class OntologyService {
  private cache = new Map<string, { mode: OntologyMode; manifest: OntologyManifest }>();

  constructor(
    private metadataRepo: MetadataRepository,
    private edgeRepo: EdgeRepository,
    private ontologyConfig?: OntologyConfig,
  ) {}

  resolveMode(storedMode?: OntologyMode): OntologyMode {
    return storedMode ?? this.ontologyConfig?.mode ?? 'off';
  }

  invalidateCache(entityId: string): void {
    this.cache.delete(entityId);
  }

  async getEffectiveState(entityId: string, tx?: SQLiteAdapter): Promise<{
    mode: OntologyMode;
    manifest: OntologyManifest;
  }> {
    if (!tx) {
      const cached = this.cache.get(entityId);
      if (cached) return cached;
    }

    const row = await this.metadataRepo.getManifest(entityId, tx);
    if (row) {
      const state = { mode: this.resolveMode(row.mode), manifest: row.manifest };
      if (!tx) this.cache.set(entityId, state);
      return state;
    }

    const seed = this.ontologyConfig?.seedManifests?.[entityId];
    if (seed) {
      // D11: the tx branch validates via setManifest; the cache branch did not.
      validateManifest(seed.manifest);
      const state = {
        mode: this.resolveMode(seed.mode),
        manifest: seed.manifest,
      };
      if (tx) {
        await this.metadataRepo.setManifest(entityId, state, tx);
      } else {
        this.cache.set(entityId, state);
      }
      return state;
    }

    return { mode: 'off', manifest: emptyManifest() };
  }

  async buildPromptContext(entityId: string): Promise<OntologyPromptContext | null> {
    const { mode, manifest } = await this.getEffectiveState(entityId);
    if (mode === 'off') return null;
    const manifestJson = JSON.stringify(manifest, null, 2);
    return buildOntologyPromptAppendix(mode, manifestJson);
  }

  async mergeEmergentUpdates(
    entityId: string,
    updates: OntologyUpdates,
    tx: SQLiteAdapter,
  ): Promise<OntologyManifest> {
    const merged = await this.metadataRepo.mergeManifestUpdates(entityId, updates, tx);
    this.invalidateCache(entityId);
    return merged;
  }

  validateAndNormalizeFact(
    fact: ExtractedFactWithOntology,
    manifest: OntologyManifest,
    opts?: { strict?: boolean; entityId?: string },
  ): { okf_type: string | null; edges: ExtractedFactEdge[] } {
    const rawType = typeof fact.okf_type === 'string' ? fact.okf_type : '';
    const strict = opts?.strict === true;
    const canonical = resolveNodeType(rawType, manifest);
    if (!canonical) {
      if (strict) throw new WikiStrictOntologyViolation(opts?.entityId ?? '', 'node', rawType);
      return { okf_type: null, edges: [] };
    }
    const edges = validateInlineEdges(canonical, null, fact.edges ?? [], manifest, opts);
    return { okf_type: canonical, edges };
  }

  /**
   * Pure resolver: given a source type, LLM-supplied edges, the manifest,
   * and a title index, return a list of concrete `WikiEdge` objects ready
   * for persistence. Performs no DB writes. Used by callers that batch edge
   * writes inside their own transaction (e.g. `IngestionService.ingestDocument`
   * when delegating to `upsertGraphCore`).
   */
  resolveEdges(
    entityId: string,
    sourceId: string,
    sourceType: string | null,
    edges: ExtractedFactEdge[],
    manifest: OntologyManifest,
    titleIndex: Map<string, TitleIndexEntry>,
    now: number,
  ): WikiEdge[] {
    if (!sourceType || edges.length === 0) return [];
    const out: WikiEdge[] = [];
    for (const edge of edges) {
      const candidates = resolveEdgeDefinitions(edge.edge_type, manifest)
        .filter(d => typeSatisfies(d.source_type, sourceType, manifest));
      if (candidates.length === 0) continue;

      const targetKey = normalizeTitleKey(edge.target_title);
      const target = titleIndex.get(targetKey);
      if (!target) continue;

      const targetType = (target.okf_type ?? '').trim().toLowerCase();
      const def = candidates.find(d => d.target_type.trim().toLowerCase() === targetType)
        ?? candidates.find(d => typeSatisfies(d.target_type, targetType, manifest));
      if (!def) continue;

      out.push({
        id: generateId(),
        entity_id: entityId,
        source_id: sourceId,
        target_id: target.id,
        edge_type: def.type,
        created_at: now,
      });
    }
    return out;
  }

  /**
   * Backwards-compatible wrapper: resolves edges via {@link resolveEdges},
   * then persists each via `edgeRepo.addIgnoreDuplicate` in the supplied
   * transaction. Returns the number of edges persisted. Used by paths that
   * want self-contained edge persistence (e.g. MaintenanceService heal /
   * backfill callers that do not have a separate edge-write step).
   */
  async resolveAndPersistEdges(
    entityId: string,
    sourceId: string,
    sourceType: string | null,
    edges: ExtractedFactEdge[],
    manifest: OntologyManifest,
    titleIndex: Map<string, TitleIndexEntry>,
    tx: SQLiteAdapter,
    now: number,
  ): Promise<number> {
    const resolved = this.resolveEdges(entityId, sourceId, sourceType, edges, manifest, titleIndex, now);
    let persisted = 0;
    for (const edge of resolved) {
      const inserted = await this.edgeRepo.addIgnoreDuplicate(edge, tx);
      if (inserted) persisted++;
    }
    return persisted;
  }
}
