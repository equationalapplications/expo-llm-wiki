import { z } from 'zod';
import { defineTool } from './shared';

export interface WhoamiResult {
  apiKeyId: string;
  organizationId: string;
  tenantDatabaseId: string;
  scope: 'read' | 'read_write';
  planCode: string | null;
  subscriptionStatus: string;
}

export const whoami = defineTool({
  name: 'whoami',
  description: 'Show which SynapseTree account, database, scope, and plan this server is using.',
  operation: 'whoami',
  inputSchema: z.object({}),
  async handler(_input, ctx) {
    const res = await ctx.client.call<WhoamiResult>('whoami');
    return res.data;
  },
});
