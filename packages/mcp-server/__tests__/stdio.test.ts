import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('dist/cli.js over stdio (spec §12.1 "stdio")', () => {
  it('serves tools/list from the built bin', async () => {
    if (!existsSync(CLI)) throw new Error(`build first: pnpm --filter @equationalapplications/mcp-server build (missing ${CLI})`);
    const dir = await mkdtemp(join(tmpdir(), 'stmcp-stdio-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve'],
      env: { ...process.env, SYNAPSETREE_API_KEY: 'stree_' + 'x'.repeat(43), SYNAPSETREE_BASE_URL: 'http://127.0.0.1:9', SYNAPSETREE_CONFIG_DIR: dir },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['memory_search', 'memory_remember', 'memory_supersede', 'memory_ingest', 'memory_log_event', 'graph_traverse', 'namespaces_list', 'whoami']);
    } finally {
      await client.close();
    }
  }, 20_000);
});
