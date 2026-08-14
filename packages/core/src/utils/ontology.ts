import type {
  OntologyManifest,
  OntologyUpdates,
  ExtractedFactEdge,
} from '../types';
import { WikiStrictOntologyViolation } from '../types';

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

export function resolveEdgeDefinitions(
  rawEdgeType: string,
  manifest: OntologyManifest,
): OntologyManifest['edge_types'][number][] {
  const slug = rawEdgeType.trim();
  if (!slug) return [];
  return manifest.edge_types.filter(e => e.type.toLowerCase() === slug.toLowerCase());
}

function edgeTripleKey(type: string, sourceType: string, targetType: string): string {
  return `${type.trim().toLowerCase()}|${sourceType.trim().toLowerCase()}|${targetType.trim().toLowerCase()}`;
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
  const edgeKeys = new Set<string>();
  const edgeNames = new Map<string, string>();
  for (const edge of manifest.edge_types ?? []) {
    const edgeType = edge.type?.trim();
    const sourceType = edge.source_type?.trim();
    const targetType = edge.target_type?.trim();
    if (!edgeType) throw new Error('Ontology edge type slug must be non-empty');
    if (!sourceType || !targetType || !nodeSlugs.has(sourceType.toLowerCase()) || !nodeSlugs.has(targetType.toLowerCase())) {
      throw new Error(`Edge type ${edgeType} references unknown node type`);
    }
    const edgeKey = edgeTripleKey(edgeType, sourceType, targetType);
    if (edgeKeys.has(edgeKey)) {
      throw new Error(`Duplicate edge definition: ${edgeType} (${sourceType} → ${targetType})`);
    }
    edgeKeys.add(edgeKey);
    // Persisted edge_type values come from def.type verbatim, so every triple
    // sharing a name must agree on casing or storage ends up mixed.
    const canonical = edgeNames.get(edgeType.toLowerCase());
    if (canonical === undefined) {
      edgeNames.set(edgeType.toLowerCase(), edgeType);
    } else if (canonical !== edgeType) {
      throw new Error(`Inconsistent casing for edge type: ${edgeType} conflicts with ${canonical}`);
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
  const edgeKeys = new Set(edge_types.map(e => edgeTripleKey(e.type, e.source_type, e.target_type)));
  const edgeNames = new Map(edge_types.map(e => [e.type.trim().toLowerCase(), e.type.trim()]));

  for (const node of updates.node_types ?? []) {
    const type = node?.type?.trim();
    if (!type) continue;
    const key = type.toLowerCase();
    if (nodeSlugs.has(key)) continue;
    node_types.push({ type, description: String(node.description ?? '') });
    nodeSlugs.add(key);
  }
  for (const edge of updates.edge_types ?? []) {
    const rawEdgeType = edge?.type?.trim();
    const sourceType = edge?.source_type?.trim();
    const targetType = edge?.target_type?.trim();
    if (!rawEdgeType || !sourceType || !targetType) continue;
    // First-seen casing wins for a given edge name, as with node types, so a
    // later triple spelled differently cannot make the manifest fail validation.
    const edgeType = edgeNames.get(rawEdgeType.toLowerCase()) ?? rawEdgeType;
    const edgeKey = edgeTripleKey(edgeType, sourceType, targetType);
    if (edgeKeys.has(edgeKey)) continue;
    if (!nodeSlugs.has(sourceType.toLowerCase()) || !nodeSlugs.has(targetType.toLowerCase())) continue;
    edgeNames.set(edgeType.toLowerCase(), edgeType);
    edge_types.push({
      type: edgeType,
      source_type: sourceType,
      target_type: targetType,
      description: String(edge.description ?? ''),
    });
    edgeKeys.add(edgeKey);
  }
  return { node_types, edge_types };
}

export function validateInlineEdges(
  sourceType: string,
  _targetType: string | null,
  edges: ExtractedFactEdge[],
  manifest: OntologyManifest,
  opts?: { strict?: boolean; entityId?: string },
): ExtractedFactEdge[] {
  if (!Array.isArray(edges)) return [];
  const strict = opts?.strict === true;
  const entityId = opts?.entityId ?? '';
  const valid: ExtractedFactEdge[] = [];
  for (const edge of edges) {
    if (typeof edge?.edge_type !== 'string' || typeof edge?.target_title !== 'string') {
      if (strict) throw new WikiStrictOntologyViolation(entityId, 'edge', String(edge?.edge_type ?? ''));
      continue;
    }
    const defs = resolveEdgeDefinitions(edge.edge_type, manifest);
    const match = defs.find(d => d.source_type.toLowerCase() === sourceType.toLowerCase());
    if (!match) {
      if (strict) throw new WikiStrictOntologyViolation(entityId, 'edge', edge.edge_type);
      continue;
    }
    valid.push({ edge_type: match.type, target_title: edge.target_title });
  }
  return valid;
}
