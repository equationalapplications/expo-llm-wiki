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

export function validateManifest(manifest: OntologyManifest): void {
  const nodeSlugs = new Set<string>();
  for (const node of manifest.node_types ?? []) {
    if (!node.type?.trim()) throw new Error('Ontology node type slug must be non-empty');
    if (nodeSlugs.has(node.type)) throw new Error(`Duplicate node type: ${node.type}`);
    nodeSlugs.add(node.type);
  }
  const edgeSlugs = new Set<string>();
  for (const edge of manifest.edge_types ?? []) {
    if (!edge.type?.trim()) throw new Error('Ontology edge type slug must be non-empty');
    if (edgeSlugs.has(edge.type)) throw new Error(`Duplicate edge type: ${edge.type}`);
    edgeSlugs.add(edge.type);
    if (!nodeSlugs.has(edge.source_type) || !nodeSlugs.has(edge.target_type)) {
      throw new Error(`Edge type ${edge.type} references unknown node type`);
    }
  }
}

export function mergeOntologyUpdates(
  current: OntologyManifest,
  updates: OntologyUpdates,
): OntologyManifest {
  const node_types = [...current.node_types];
  const edge_types = [...current.edge_types];
  const nodeSlugs = new Set(node_types.map(n => n.type));
  const edgeSlugs = new Set(edge_types.map(e => e.type));

  for (const node of updates.node_types ?? []) {
    if (!node?.type?.trim() || nodeSlugs.has(node.type)) continue;
    node_types.push({ type: node.type, description: String(node.description ?? '') });
    nodeSlugs.add(node.type);
  }
  for (const edge of updates.edge_types ?? []) {
    if (!edge?.type?.trim() || edgeSlugs.has(edge.type)) continue;
    if (!nodeSlugs.has(edge.source_type) || !nodeSlugs.has(edge.target_type)) continue;
    edge_types.push({
      type: edge.type,
      source_type: edge.source_type,
      target_type: edge.target_type,
      description: String(edge.description ?? ''),
    });
    edgeSlugs.add(edge.type);
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
    const def = manifest.edge_types.find(e => e.type === edge.edge_type);
    if (!def) continue;
    if (def.source_type !== sourceType) continue;
    valid.push({ edge_type: edge.edge_type, target_title: edge.target_title });
  }
  return valid;
}
