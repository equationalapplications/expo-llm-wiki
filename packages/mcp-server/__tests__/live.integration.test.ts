import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { TOOLS } from '../src/tools';
import type { ToolContext, ToolDefinition } from '../src/tools/shared';

const apiKey = process.env.SYNAPSETREE_API_KEY;
const baseUrl = process.env.SYNAPSETREE_BASE_URL;
// Double-gated: env credentials AND an explicit opt-in, so a developer with
// production env vars exported never runs a writing suite by accident.
const enabled = Boolean(apiKey && baseUrl) && process.env.SYNAPSETREE_LIVE_TESTS === '1';

const tool = (name: string): ToolDefinition => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t;
};

describe.skipIf(!enabled)('live chain against the SynapseTree test stage (spec §12.2; set SYNAPSETREE_API_KEY and SYNAPSETREE_BASE_URL)', () => {
  const namespace = `repo:mcp-server-live-${randomUUID().slice(0, 8)}`;
  const ctx: ToolContext = { client: new SynapseTreeClient({ apiKey, baseUrl: baseUrl ?? '', userAgent: 'synapsetree-mcp/live-test' }), defaultNamespace: namespace };
  const call = (name: string, input: Record<string, unknown>) => tool(name).handler(tool(name).inputSchema.parse(input), ctx);
  const title = `live ${randomUUID()}`;
  let factId = '';

  it('whoami', async () => {
    expect(await call('whoami', {})).toMatchObject({ scope: expect.stringMatching(/read/) });
  });
  it('memory_remember → memory_search finds it', async () => {
    const fact = (await call('memory_remember', { title, body: 'first body', confidence: 'certain' })) as { id: string };
    factId = fact.id;
    const found = (await call('memory_search', { query: title, limit: 5 })) as { facts: { id: string }[] };
    expect(found.facts.map((f) => f.id)).toContain(factId);
  });
  it('memory_supersede → memory_search returns the replacement', async () => {
    const res = (await call('memory_supersede', { factId, title, body: 'second body', confidence: 'certain' })) as { replacement: { id: string } };
    const found = (await call('memory_search', { query: title, limit: 5 })) as { facts: { id: string; body: string }[] };
    expect(found.facts.find((f) => f.id === res.replacement.id)?.body).toBe('second body');
  });
  it('memory_log_event and namespaces_list', async () => {
    await call('memory_log_event', { eventType: 'outcome', summary: 'live chain ran', relatedFactId: factId });
    const list = (await call('namespaces_list', { prefix: 'repo:mcp-server-live-' })) as { namespaces: string[] };
    expect(list.namespaces).toContain(namespace);
  });
}, 60_000);
