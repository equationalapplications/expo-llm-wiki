import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { createServer } from '../src/server';
import { CANONICAL_TOOL_NAMES } from '../src/tools';

// The vendored contract (contract/synapsetree-openapi.subset.json) carries
// operationIds, not MCP tool names, so parity is asserted against the single
// canonical constant rather than the contract.
describe('tool-name parity (spec §8, ruling R9)', () => {
  it('registers exactly the canonical tool names: set equality, no duplicates', async () => {
    const server = createServer({
      client: new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://api.test', userAgent: 'ua', fetch: (async () => new Response('{}')) as typeof fetch }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'parity', version: '0.0.0' });
    await client.connect(clientTransport);

    const registered = (await client.listTools()).tools.map((t) => t.name);
    await server.close();

    expect(new Set(registered).size).toBe(registered.length);
    expect(new Set(CANONICAL_TOOL_NAMES).size).toBe(CANONICAL_TOOL_NAMES.length);
    expect(new Set(registered)).toEqual(new Set(CANONICAL_TOOL_NAMES));
  });
});
