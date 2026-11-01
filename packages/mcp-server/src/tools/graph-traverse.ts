import { z } from 'zod';
import { compact, defineTool, namespaceField, resolveNamespace } from './shared';

export const graphTraverse = defineTool({
  name: 'graph_traverse',
  description: 'Walk the knowledge graph from a fact or node id, up to three hops. Returns the anchor first, then neighbours by depth, and the edges between them.',
  operation: 'traverseGraph',
  inputSchema: z.object({
    namespace: namespaceField,
    sourceId: z.string().min(1).max(255).describe('The fact or graph node id to start from.'),
    maxDepth: z.number().int().min(1).max(3).default(1),
    direction: z.enum(['inbound', 'outbound', 'both']).optional(),
    edgeTypes: z.array(z.string().min(1).max(128)).max(100).optional().describe('Allowed edge types, e.g. dependsOn, documents, supersedes. Omit for all.'),
    maxNodes: z.number().int().min(1).max(200).default(20),
    excludeDrafts: z.boolean().optional(),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('traverseGraph', {
      body: compact({
        namespace,
        sourceId: input.sourceId,
        maxDepth: input.maxDepth,
        direction: input.direction,
        edgeTypes: input.edgeTypes,
        maxNodes: input.maxNodes,
        excludeDrafts: input.excludeDrafts,
      }),
    });
    return res.data;
  },
});
