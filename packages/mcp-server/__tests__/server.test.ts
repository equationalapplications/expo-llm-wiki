import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { createServer } from '../src/server';

const WHOAMI = { apiKeyId: 'k', organizationId: 'o', tenantDatabaseId: 'd', scope: 'read_write', planCode: null, subscriptionStatus: 'active' };

async function connected(responses: Array<{ status: number; body: unknown; problem?: boolean }>, defaultNamespace?: string) {
  const fetchImpl = (async () => {
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': next.problem ? 'application/problem+json' : 'application/json' } });
  }) as typeof fetch;
  const server = createServer({
    client: new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://api.test', userAgent: 'ua', fetch: fetchImpl, sleep: async () => {}, random: () => 0 }),
    defaultNamespace,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('createServer (spec §5.7)', () => {
  it('lists exactly the eight tools, in order, with descriptions and schemas', async () => {
    const { client, server } = await connected([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['memory_search', 'memory_remember', 'memory_supersede', 'memory_ingest', 'memory_log_event', 'graph_traverse', 'namespaces_list', 'whoami']);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'memory_search')?.inputSchema.properties).toHaveProperty('namespace');
    await server.close();
  });

  it('answers a tool call with pretty JSON text', async () => {
    const { client, server } = await connected([{ status: 200, body: WHOAMI }]);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe('text');
    expect(JSON.parse(content[0].text)).toEqual(WHOAMI);
    await server.close();
  });

  it('turns a SynapseTree error into isError with the mapped text, not a protocol error', async () => {
    const { client, server } = await connected([{ status: 401, body: { message: 'Unauthorized' } }]);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('synapsetree-mcp auth');
    await server.close();
  });

  it('turns a missing namespace into isError with the documented message', async () => {
    const { client, server } = await connected([]);
    const result = await client.callTool({ name: 'memory_search', arguments: { query: 'x' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('config set namespace');
    await server.close();
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const { client, server } = await connected([]);
    const outcome = await client.callTool({ name: 'graph_traverse', arguments: { sourceId: 'a', maxDepth: 9 } }).then(
      (r) => ({ kind: 'result' as const, isError: r.isError === true }),
      () => ({ kind: 'thrown' as const, isError: true }),
    );
    expect(outcome.isError).toBe(true);
    await server.close();
  });
});
