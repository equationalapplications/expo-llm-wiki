import { z } from 'zod';
import { compact, confidenceField, dateTimeField, defineTool, namespaceField, resolveNamespace } from './shared';

export const memorySupersede = defineTool({
  name: 'memory_supersede',
  description: 'Replace a fact with a corrected one and keep the old one in history. Never deletes.',
  operation: 'supersedeFact',
  inputSchema: z.object({
    namespace: namespaceField,
    factId: z.string().min(1).max(255).describe('The fact to replace.'),
    title: z.string().min(1).max(1000),
    body: z.string().min(1).max(100000),
    tags: z.array(z.string().min(1).max(100)).max(100).optional(),
    confidence: confidenceField.optional(),
    validFrom: dateTimeField.optional().describe('When the replacement became true. Defaults to now.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('supersedeFact', {
      path: { factId: input.factId },
      body: compact({
        namespace,
        validFrom: input.validFrom,
        replacement: compact({ kind: 'new', title: input.title, body: input.body, tags: input.tags, confidence: input.confidence, sourceType: 'user_stated' }),
      }),
    });
    return res.data;
  },
});
