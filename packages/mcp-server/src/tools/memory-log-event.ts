import { z } from 'zod';
import { compact, dateTimeField, defineTool, namespaceField, resolveNamespace } from './shared';

export const memoryLogEvent = defineTool({
  name: 'memory_log_event',
  description: 'Record that something happened: an observation, decision, action, or outcome, optionally tied to a fact.',
  operation: 'createEvent',
  inputSchema: z.object({
    namespace: namespaceField,
    eventType: z.enum(['observation', 'decision', 'action', 'outcome']),
    summary: z.string().min(1).max(8000),
    relatedFactId: z.string().min(1).max(255).optional(),
    occurredAt: dateTimeField.optional().describe('When it happened. Defaults to now.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('createEvent', {
      body: compact({ namespace, eventType: input.eventType, summary: input.summary, relatedFactId: input.relatedFactId, occurredAt: input.occurredAt }),
    });
    return res.data;
  },
});
