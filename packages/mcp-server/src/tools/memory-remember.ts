import { z } from 'zod';
import { compact, confidenceField, dateTimeField, defineTool, namespaceField, resolveNamespace } from './shared';

export const memoryRemember = defineTool({
  name: 'memory_remember',
  description:
    'Store one fact the user decided or you observed. Works with no provider registered. Use `memory_ingest` for a whole document.',
  operation: 'rememberFact',
  inputSchema: z.object({
    namespace: namespaceField,
    title: z.string().min(1).max(1000),
    body: z.string().min(1).max(100000),
    tags: z.array(z.string().min(1).max(100)).max(100).optional(),
    confidence: confidenceField.optional(),
    okfType: z.string().min(1).max(128).optional().describe('Ontology node type, e.g. project, person, design_spec, procedure.'),
    validFrom: dateTimeField.optional().describe('When the fact became true. Defaults to now.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('rememberFact', {
      body: compact({
        namespace,
        title: input.title,
        body: input.body,
        tags: input.tags,
        confidence: input.confidence,
        sourceType: 'user_stated',
        okfType: input.okfType,
        validFrom: input.validFrom,
      }),
    });
    return res.data;
  },
});
