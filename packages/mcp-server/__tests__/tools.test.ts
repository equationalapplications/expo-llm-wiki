import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { NO_NAMESPACE_MESSAGE, SynapseTreeError, UsageError } from '../src/errors';
import { TOOLS, TOOL_NAMES } from '../src/tools';
import type { ToolContext, ToolDefinition } from '../src/tools/shared';

interface Recorded { url: string; method: string; headers: Record<string, string>; body: unknown }

function harness(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>, defaultNamespace?: string) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': next.status >= 400 ? 'application/problem+json' : 'application/json', ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  const ctx: ToolContext = {
    client: new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://api.test', userAgent: 'ua', fetch: fetchImpl, sleep: async () => {}, random: () => 0 }),
    defaultNamespace,
  };
  return { ctx, calls };
}

const byName = (name: string): ToolDefinition => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};
const run = (name: string, input: Record<string, unknown>, ctx: ToolContext) => {
  const tool = byName(name);
  return tool.handler(tool.inputSchema.parse(input), ctx);
};

describe('tool list (spec §8, §10.2 guard 2)', () => {
  it('is exactly the eight names in order', () => {
    expect(TOOL_NAMES).toEqual(['memory_search', 'memory_remember', 'memory_supersede', 'memory_ingest', 'memory_log_event', 'graph_traverse', 'namespaces_list', 'whoami']);
    expect(TOOLS).toHaveLength(8);
  });
  it('every tool but whoami accepts an optional namespace', () => {
    for (const tool of TOOLS) {
      const hasNamespace = 'namespace' in tool.inputSchema.shape;
      expect(hasNamespace).toBe(tool.name !== 'whoami');
    }
  });
});

describe('namespace rule', () => {
  it('uses the default namespace when none is given', async () => {
    const { ctx, calls } = harness([{ status: 200, body: { facts: [] } }], 'repo:dflt');
    await run('memory_search', { query: 'x' }, ctx);
    expect(calls[0].body).toMatchObject({ namespaces: ['repo:dflt'] });
  });
  it('errors with the documented message when no namespace is configured', async () => {
    const { ctx, calls } = harness([]);
    await expect(run('memory_search', { query: 'x' }, ctx)).rejects.toThrow(NO_NAMESPACE_MESSAGE);
    expect(calls).toHaveLength(0);
  });
  it('rejects a malformed namespace at the schema', () => {
    expect(() => byName('memory_search').inputSchema.parse({ query: 'x', namespace: 'Bad Namespace' })).toThrow();
  });
});

describe('memory_search', () => {
  it('sends only the allowed body fields and returns the response verbatim', async () => {
    const payload = { facts: [{ id: 'fact_1' }], scores: { fact_1: 0.9 }, tasks: [], events: [], diagnostics: { keyword_only: true } };
    const { ctx, calls } = harness([{ status: 200, body: payload }]);
    const result = await run('memory_search', { namespace: 'repo:x', query: 'hello', limit: 5, excludeDrafts: true, asOf: '2026-01-01T00:00:00Z' }, ctx);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/v1/memory/query' });
    expect(calls[0].body).toEqual({ namespaces: ['repo:x'], query: 'hello', limit: 5, excludeDrafts: true, asOf: '2026-01-01T00:00:00Z' });
    expect(result).toEqual(payload);
  });
  it('defaults limit to 10 and rejects 101', () => {
    const schema = byName('memory_search').inputSchema;
    expect(schema.parse({ query: 'q' })).toMatchObject({ limit: 10 });
    expect(() => schema.parse({ query: 'q', limit: 101 })).toThrow();
  });
});

describe('memory_remember', () => {
  it('always sends sourceType user_stated and never an embedding', async () => {
    const { ctx, calls } = harness([{ status: 201, body: { id: 'fact_9' } }]);
    const result = await run('memory_remember', { namespace: 'repo:x', title: 'T', body: 'B', tags: ['a'], confidence: 'certain' }, ctx);
    expect(calls[0].body).toEqual({ namespace: 'repo:x', title: 'T', body: 'B', tags: ['a'], confidence: 'certain', sourceType: 'user_stated' });
    expect(calls[0].headers['idempotency-key']).toBeDefined();
    expect(result).toEqual({ id: 'fact_9' });
  });
  it('maps a 402 subscription_inactive to the typed error', async () => {
    const { ctx } = harness([{ status: 402, body: { code: 'subscription_inactive', detail: 'paused' } }]);
    await expect(run('memory_remember', { namespace: 'repo:x', title: 'T', body: 'B' }, ctx)).rejects.toMatchObject({ code: 'subscription_inactive' });
  });
});

describe('memory_supersede', () => {
  it('sends the factId in the path and a kind:new replacement', async () => {
    const { ctx, calls } = harness([{ status: 200, body: { superseded: {}, replacement: {} } }]);
    await run('memory_supersede', { namespace: 'repo:x', factId: 'fact_1', title: 'T2', body: 'B2', confidence: 'inferred', validFrom: '2026-02-01T00:00:00Z' }, ctx);
    expect(calls[0].url).toBe('https://api.test/v1/memory/facts/fact_1/supersede');
    expect(calls[0].body).toEqual({ namespace: 'repo:x', validFrom: '2026-02-01T00:00:00Z', replacement: { kind: 'new', title: 'T2', body: 'B2', confidence: 'inferred', sourceType: 'user_stated' } });
  });
});

describe('memory_ingest', () => {
  it('computes sourceHash, encodes sourceRef, and sends server_extraction', async () => {
    const { ctx, calls } = harness([{ status: 200, body: { chunks: 1, ingestedChunks: 1, failedChunks: 0, truncated: false, duplicateOf: null, parseFailures: [] } }]);
    const content = 'hello world';
    await run('memory_ingest', { namespace: 'repo:x', sourceRef: 'docs/guide.md', content }, ctx);
    expect(calls[0].body).toEqual({
      mode: 'server_extraction', namespace: 'repo:x', sourceRef: 'docs__guide.md',
      sourceHash: createHash('sha256').update(content, 'utf8').digest('hex'), content, onDuplicateHash: 'skip',
    });
  });
  it('rejects a sourceRef that still has illegal characters after encoding', async () => {
    const { ctx, calls } = harness([]);
    await expect(run('memory_ingest', { namespace: 'repo:x', sourceRef: 'bad:ref?', content: 'x' }, ctx)).rejects.toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });
  it('surfaces inference_not_configured', async () => {
    const { ctx } = harness([{ status: 409, body: { code: 'inference_not_configured', detail: 'no provider' } }]);
    await expect(run('memory_ingest', { namespace: 'repo:x', sourceRef: 'a', content: 'x' }, ctx)).rejects.toMatchObject({ code: 'inference_not_configured' });
  });
});

describe('memory_log_event', () => {
  it('sends the event body', async () => {
    const { ctx, calls } = harness([{ status: 201, body: { id: 'evt_1' } }]);
    await run('memory_log_event', { namespace: 'repo:x', eventType: 'decision', summary: 'chose zod', relatedFactId: 'fact_1' }, ctx);
    expect(calls[0].body).toEqual({ namespace: 'repo:x', eventType: 'decision', summary: 'chose zod', relatedFactId: 'fact_1' });
  });
  it('rejects an unknown eventType', () => {
    expect(() => byName('memory_log_event').inputSchema.parse({ eventType: 'guess', summary: 's' })).toThrow();
  });
});

describe('graph_traverse', () => {
  it('sends the traversal body with defaults', async () => {
    const { ctx, calls } = harness([{ status: 200, body: { nodes: [], edges: [] } }]);
    await run('graph_traverse', { namespace: 'repo:x', sourceId: 'fact_1', edgeTypes: ['dependsOn'] }, ctx);
    expect(calls[0].body).toEqual({ namespace: 'repo:x', sourceId: 'fact_1', maxDepth: 1, maxNodes: 20, edgeTypes: ['dependsOn'] });
  });
  it('rejects maxDepth 4', () => {
    expect(() => byName('graph_traverse').inputSchema.parse({ sourceId: 'a', maxDepth: 4 })).toThrow();
  });
});

describe('namespaces_list', () => {
  it('follows nextCursor and stops at 500 with truncated', async () => {
    const page = (start: number, hasMore: boolean) => ({
      status: 200,
      body: { data: Array.from({ length: 100 }, (_, i) => ({ namespace: `ns${start + i}` })), hasMore, nextCursor: hasMore ? `c${start + 100}` : null },
    });
    const { ctx, calls } = harness([page(0, true), page(100, true), page(200, true), page(300, true), page(400, true), page(500, true)]);
    const result = (await run('namespaces_list', { prefix: 'ns' }, ctx)) as { namespaces: string[]; truncated: boolean };
    expect(result.namespaces).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls[0].url).toBe('https://api.test/v1/namespaces?prefix=ns&limit=100');
    expect(calls[1].url).toContain('after=c100');
  });
  it('returns a short list untruncated', async () => {
    const { ctx } = harness([{ status: 200, body: { data: [{ namespace: 'a' }], hasMore: false, nextCursor: null } }]);
    expect(await run('namespaces_list', {}, ctx)).toEqual({ namespaces: ['a'], truncated: false });
  });
});

describe('whoami', () => {
  it('returns the account summary', async () => {
    const body = { apiKeyId: 'k', organizationId: 'o', tenantDatabaseId: 'd', scope: 'read_write', planCode: 'pro', subscriptionStatus: 'active' };
    const { ctx, calls } = harness([{ status: 200, body }]);
    expect(await run('whoami', {}, ctx)).toEqual(body);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/v1/whoami' });
  });
  it('surfaces a revoked key as unauthorized', async () => {
    const { ctx } = harness([{ status: 401, body: { message: 'Unauthorized' }, headers: { 'content-type': 'application/json' } }]);
    await expect(run('whoami', {}, ctx)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(new SynapseTreeError({ status: 401, code: 'unauthorized' }).code).toBe('unauthorized');
  });
});
