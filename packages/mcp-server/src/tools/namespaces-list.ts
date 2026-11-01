import { z } from 'zod';
import { defineTool, namespaceField } from './shared';

const PAGE = 100;
const CAP = 500;

interface Page { data: { namespace: string }[]; hasMore: boolean; nextCursor: string | null }

export const namespacesList = defineTool({
  name: 'namespaces_list',
  description: "List the namespaces in the user's database, optionally by prefix. Stops after 500 names and sets `truncated`.",
  operation: 'listNamespaces',
  inputSchema: z.object({
    // Accepted for uniformity (spec §5.6, §8) but never sent: listNamespaces is database-wide in the contract.
    namespace: namespaceField.describe('Ignored: listing is database-wide. Use `prefix` to filter.'),
    prefix: z.string().max(128).optional(),
  }),
  async handler(input, ctx) {
    const namespaces: string[] = [];
    let after: string | undefined;
    let truncated = false;
    for (;;) {
      const res = await ctx.client.call<Page>('listNamespaces', { query: { prefix: input.prefix, limit: PAGE, after } });
      for (const row of res.data.data) namespaces.push(row.namespace);
      if (!res.data.hasMore || !res.data.nextCursor) break;
      if (namespaces.length >= CAP) { truncated = true; break; }
      after = res.data.nextCursor;
    }
    return { namespaces: namespaces.slice(0, CAP), truncated };
  },
});
