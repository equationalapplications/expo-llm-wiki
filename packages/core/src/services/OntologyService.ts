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
import type { MetadataRepository } from '../repositories/MetadataRepository';
import type { EdgeRepository } from '../repositories/EdgeRepository';
import { buildOntologyPromptAppendix } from '../prompts/ontology';
import {
  emptyManifest,
  normalizeTitleKey,
  resolveNodeType,
  resolveEdgeDefinitions,
  validateInlineEdges,
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
  ): { okf_type: string | null; edges: ExtractedFactEdge[] } {
    const rawType = typeof fact.okf_type === 'string' ? fact.okf_type : '';
    const canonical = resolveNodeType(rawType, manifest);
    if (!canonical) return { okf_type: null, edges: [] };
    const edges = validateInlineEdges(canonical, null, fact.edges ?? [], manifest);
    return { okf_type: canonical, edges };
  }

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
    if (!sourceType || edges.length === 0) return 0;

    let persisted = 0;
    for (const edge of edges) {
      const candidates = resolveEdgeDefinitions(edge.edge_type, manifest)
        .filter(d => d.source_type.toLowerCase() === sourceType.toLowerCase());
      if (candidates.length === 0) continue;

      const targetKey = normalizeTitleKey(edge.target_title);
      const target = titleIndex.get(targetKey);
      if (!target) continue;

      const def = candidates.find(
        d => d.target_type.toLowerCase() === (target.okf_type ?? '').toLowerCase(),
      );
      if (!def) continue;

      const wikiEdge: WikiEdge = {
        id: generateId(),
        entity_id: entityId,
        source_id: sourceId,
        target_id: target.id,
        edge_type: def.type,
        created_at: now,
      };
      const inserted = await this.edgeRepo.addIgnoreDuplicate(wikiEdge, tx);
      if (inserted) persisted++;
    }
    return persisted;
  }
}
