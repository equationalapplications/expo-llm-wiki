import { createHash } from 'node:crypto';
import { z } from 'zod';
import { INGEST_PROVIDER_MESSAGE, UsageError } from '../errors';
import { compact, defineTool, namespaceField, resolveNamespace } from './shared';

const SOURCE_REF_PATTERN = /^[A-Za-z0-9._\- ]{1,255}$/;

/** `/` becomes `__` (the SDK's rule); anything else illegal is an error naming the characters. */
export function encodeSourceRef(raw: string): string {
  const encoded = raw.replace(/\//g, '__');
  if (!SOURCE_REF_PATTERN.test(encoded)) {
    const bad = [...new Set(encoded.replace(/[A-Za-z0-9._\- ]/g, ''))].join(' ');
    throw new UsageError(`sourceRef may only contain letters, digits, ".", "_", "-", and spaces (1–255 chars); "/" is encoded as "__". Illegal: ${bad || 'length'}`);
  }
  return encoded;
}

export const memoryIngest = defineTool({
  name: 'memory_ingest',
  description: `Store a whole document; SynapseTree extracts the facts. ${INGEST_PROVIDER_MESSAGE}`,
  operation: 'ingestDocument',
  inputSchema: z.object({
    namespace: namespaceField,
    sourceRef: z.string().min(1).max(255).describe('Identifies the document, e.g. a repo-relative path. "/" is encoded as "__".'),
    content: z.string().min(1).max(524288),
    onDuplicateHash: z.enum(['skip', 'ingest', 'error']).default('skip').describe('What to do when another sourceRef already holds identical content.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const sourceRef = encodeSourceRef(input.sourceRef);
    const sourceHash = createHash('sha256').update(input.content, 'utf8').digest('hex');
    const res = await ctx.client.call('ingestDocument', {
      body: compact({ mode: 'server_extraction', namespace, sourceRef, sourceHash, content: input.content, onDuplicateHash: input.onDuplicateHash }),
    });
    return res.data;
  },
});
