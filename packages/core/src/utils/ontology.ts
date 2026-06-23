import type {
  OntologyManifest,
  OntologyUpdates,
  ExtractedFactEdge,
} from '../types';

export function emptyManifest(): OntologyManifest {
  return { node_types: [], edge_types: [] };
}

export function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function resolveNodeType(raw: string, manifest: OntologyManifest): string | null {
  const slug = raw.trim();
  if (!slug) return null;
  const hit = manifest.node_types.find(n => n.type.toLowerCase() === slug.toLowerCase());
  return hit?.type ?? null;
}

export function resolveEdgeDefinition(
  rawEdgeType: string,
  manifest: OntologyManifest,
): OntologyManifest['edge_types'][number] | null {
  const slug = rawEdgeType.trim();
  if (!slug) return null;
  return manifest.edge_types.find(e => e.type.toLowerCase() === slug.toLowerCase()) ?? null;
}

export function validateManifest(manifest: OntologyManifest): void {
  const nodeSlugs = new Set<string>();
  for (const node of manifest.node_types ?? []) {
    const type = node.type?.trim();
    if (!type) throw new Error('Ontology node type slug must be non-empty');
    const key = type.toLowerCase();
    if (nodeSlugs.has(key)) throw new Error(`Duplicate node type: ${type}`);
    nodeSlugs.add(key);
  }
  const edgeSlugs = new Set<string>();
  for (const edge of manifest.edge_types ?? []) {
    const edgeType = edge.type?.trim();
    const sourceType = edge.source_type?.trim();
    const targetType = edge.target_type?.trim();
    if (!edgeType) throw new Error('Ontology edge type slug must be non-empty');
    const edgeKey = edgeType.toLowerCase();
    if (edgeSlugs.has(edgeKey)) throw new Error(`Duplicate edge type: ${edgeType}`);
    edgeSlugs.add(edgeKey);
    if (!sourceType || !targetType || !nodeSlugs.has(sourceType.toLowerCase()) || !nodeSlugs.has(targetType.toLowerCase())) {
      throw new Error(`Edge type ${edgeType} references unknown node type`);
    }
  }
}

export function mergeOntologyUpdates(
  current: OntologyManifest,
  updates: OntologyUpdates,
): OntologyManifest {
  const node_types = [...current.node_types];
  const edge_types = [...current.edge_types];
  const nodeSlugs = new Set(node_types.map(n => n.type.trim().toLowerCase()));
  const edgeSlugs = new Set(edge_types.map(e => e.type.trim().toLowerCase()));

  for (const node of updates.node_types ?? []) {
    const type = node?.type?.trim();
    if (!type) continue;
    const key = type.toLowerCase();
    if (nodeSlugs.has(key)) continue;
    node_types.push({ type, description: String(node.description ?? '') });
    nodeSlugs.add(key);
  }
  for (const edge of updates.edge_types ?? []) {
    const edgeType = edge?.type?.trim();
    const sourceType = edge?.source_type?.trim();
    const targetType = edge?.target_type?.trim();
    if (!edgeType || !sourceType || !targetType) continue;
    const edgeKey = edgeType.toLowerCase();
    if (edgeSlugs.has(edgeKey)) continue;
    if (!nodeSlugs.has(sourceType.toLowerCase()) || !nodeSlugs.has(targetType.toLowerCase())) continue;
    edge_types.push({
      type: edgeType,
      source_type: sourceType,
      target_type: targetType,
      description: String(edge.description ?? ''),
    });
    edgeSlugs.add(edgeKey);
  }
  return { node_types, edge_types };
}

export function validateInlineEdges(
  sourceType: string,
  _targetType: string | null,
  edges: ExtractedFactEdge[],
  manifest: OntologyManifest,
): ExtractedFactEdge[] {
  if (!Array.isArray(edges)) return [];
  const valid: ExtractedFactEdge[] = [];
  for (const edge of edges) {
    if (typeof edge?.edge_type !== 'string' || typeof edge?.target_title !== 'string') continue;
    const def = resolveEdgeDefinition(edge.edge_type, manifest);
    if (!def) continue;
    if (def.source_type.toLowerCase() !== sourceType.toLowerCase()) continue;
    valid.push({ edge_type: def.type, target_title: edge.target_title });
  }
  return valid;
}
