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

/**
 * True when `concreteType` satisfies a declared type: an exact
 * (case-insensitive) match, or a one-hop parent match — the concrete type's
 * `parent_type` equals the declared type. Never recursive (D1). Exact matches
 * short-circuit before the node lookup, so manifests with no `parent_type`
 * behave bit-for-bit as before.
 */
export function typeSatisfies(
  declaredType: string,
  concreteType: string,
  manifest: OntologyManifest,
): boolean {
  const concrete = concreteType.trim().toLowerCase();
  const declared = declaredType.trim().toLowerCase();
  if (!concrete || !declared) return false;
  if (declared === concrete) return true;
  // `node_types` is typed non-optional but arrives from JSON.parse of a DB row
  // at runtime, so guard it the way validateManifest already does — and for the
  // same reason, `typeof`-check the fields rather than calling .trim() on them.
  // This runs inside the caller's transaction, so a TypeError here aborts an
  // ingest exactly like one in the merge path. Manifests reaching this point
  // have already passed validateManifest (getManifest:164, and seeds via D11),
  // so this is defense in depth, not the primary guard.
  const def = (manifest.node_types ?? []).find(
    n => typeof n?.type === 'string' && n.type.trim().toLowerCase() === concrete,
  );
  const parent = typeof def?.parent_type === 'string'
    ? def.parent_type.trim().toLowerCase()
    : '';
  return parent !== '' && parent === declared;
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
  // D1: optional one-level parent inheritance. A parent must be a real,
  // distinct node in the same manifest, and must not itself have a parent.
  // The chain check also rejects 2-cycles, which self-parent alone misses.
  const parentOf = new Map<string, string | undefined>();
  for (const node of manifest.node_types ?? []) {
    const parent = typeof node.parent_type === 'string'
      ? node.parent_type.trim().toLowerCase()
      : undefined;
    parentOf.set(node.type.trim().toLowerCase(), parent);
  }
  for (const node of manifest.node_types ?? []) {
    // D10: absent means "no parent"; present-but-unusable is malformed.
    if (node.parent_type === undefined) continue;
    // Typed `string | undefined`, but this runs on JSON.parse output from
    // `entity_manifests.manifest_json` on every read (MetadataRepository:164),
    // so a legacy or hand-edited row can carry a number or `null`. Unguarded,
    // `.trim()` on those raises a bare TypeError instead of this error.
    if (typeof node.parent_type !== 'string' || !node.parent_type.trim()) {
      throw new Error(`Ontology parent_type must be a non-empty string when present: ${node.type}`);
    }
    const parentSlug = node.parent_type.trim().toLowerCase();
    if (parentSlug === node.type.trim().toLowerCase()) {
      throw new Error(`Self-parent: ${node.type}`);
    }
    if (!nodeSlugs.has(parentSlug)) {
      throw new Error(`Parent type not found: ${node.parent_type}`);
    }
    const grandparent = parentOf.get(parentSlug);
    if (grandparent) {
      throw new Error(`Parent chain too deep: ${node.type} → ${node.parent_type} → ${grandparent}`);
    }
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
  const strict = opts?.strict === true;
  const entityId = opts?.entityId ?? '';
  if (!Array.isArray(edges)) {
    if (strict) throw new WikiStrictOntologyViolation(entityId, 'edge', '');
    return [];
  }
  const valid: ExtractedFactEdge[] = [];
  for (const edge of edges) {
    if (typeof edge?.edge_type !== 'string' || typeof edge?.target_title !== 'string') {
      if (strict) throw new WikiStrictOntologyViolation(entityId, 'edge', String(edge?.edge_type ?? ''));
      continue;
    }
    const defs = resolveEdgeDefinitions(edge.edge_type, manifest);
    const match = defs.find(d => typeSatisfies(d.source_type, sourceType, manifest));
    if (!match) {
      if (strict) throw new WikiStrictOntologyViolation(entityId, 'edge', edge.edge_type);
      continue;
    }
    valid.push({ edge_type: match.type, target_title: edge.target_title });
  }
  return valid;
}
