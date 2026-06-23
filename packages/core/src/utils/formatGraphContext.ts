import type { GraphNeighborhood, WikiEdge } from '../types';

/**
 * Pure presenter — dense text serialization of a GraphNeighborhood for LLM prompt
 * injection. Deterministic: same input always produces byte-identical output
 * (matters for prompt caching).
 */
export function formatGraphContext(neighborhood: GraphNeighborhood): string {
  const { nodes, edges } = neighborhood;
  if (nodes.length === 0) return '';

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const lines: string[] = [];

  for (const node of nodes) {
    lines.push(`[${node.okf_type ?? 'fact'}] ${node.title} (ID: ${node.id})`);

    const outbound = edgesByDirection(edges, node.id, 'source_id', nodeById, nodeIndex);
    const inbound = edgesByDirection(edges, node.id, 'target_id', nodeById, nodeIndex);

    for (const { edge, other } of outbound) {
      lines.push(`  -[${edge.edge_type}]-> [${other.okf_type ?? 'fact'}] ${other.title}`);
    }
    for (const { edge, other } of inbound) {
      lines.push(`  <-[${edge.edge_type}]- [${other.okf_type ?? 'fact'}] ${other.title}`);
    }
  }

  return lines.join('\n');
}

function edgesByDirection(
  edges: WikiEdge[],
  nodeId: string,
  endpoint: 'source_id' | 'target_id',
  nodeById: Map<string, GraphNeighborhood['nodes'][number]>,
  nodeIndex: Map<string, number>,
) {
  const otherEndpoint = endpoint === 'source_id' ? 'target_id' : 'source_id';
  return edges
    .filter((e) => e[endpoint] === nodeId)
    .filter((e) => {
      const otherId = e[otherEndpoint];
      const selfIdx = nodeIndex.get(nodeId)!;
      const otherIdx = nodeIndex.get(otherId);
      return otherIdx !== undefined && selfIdx < otherIdx;
    })
    .map((edge) => ({ edge, other: nodeById.get(edge[otherEndpoint])! }))
    .sort(
      (a, b) =>
        a.edge.edge_type.localeCompare(b.edge.edge_type) ||
        a.other.title.localeCompare(b.other.title) ||
        a.other.id.localeCompare(b.other.id) ||
        a.edge.id.localeCompare(b.edge.id),
    );
}
