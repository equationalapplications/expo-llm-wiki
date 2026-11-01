import { z } from 'zod';
import { compact, dateTimeField, defineTool, namespaceField, resolveNamespace } from './shared';

export const memorySearch = defineTool({
  name: 'memory_search',
  description:
    "Search the user's SynapseTree memory. Semantic search needs an embeddings provider registered by the account owner in the dashboard; " +
    'without one this is keyword search and `diagnostics.keyword_only` says so. That is normal, not an error. ' +
    'Returns facts with scores, pending tasks, recent events, and diagnostics. Not paginated: raise `limit` (max 100) for more.',
  operation: 'queryMemory',
  inputSchema: z.object({
    namespace: namespaceField,
    query: z.string().max(4096).describe('Search text. Empty returns the most recent facts.'),
    limit: z.number().int().min(1).max(100).default(10),
    excludeDrafts: z.boolean().optional(),
    asOf: dateTimeField.optional().describe('RFC 3339 timestamp; search memory as it was at that moment.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('queryMemory', {
      body: compact({ namespaces: [namespace], query: input.query, limit: input.limit, excludeDrafts: input.excludeDrafts, asOf: input.asOf }),
    });
    return res.data;
  },
});
