import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { OPERATIONS } from '../src/contract';
import { TOOLS } from '../src/tools';
import type { ToolContext } from '../src/tools/shared';

/** A full input for every tool: every optional field present, so every property the tool can send is exercised. */
const FULL_INPUTS: Record<string, Record<string, unknown>> = {
  memory_search: { namespace: 'repo:x', query: 'q', limit: 5, excludeDrafts: true, asOf: '2026-01-01T00:00:00Z' },
  memory_remember: { namespace: 'repo:x', title: 't', body: 'b', tags: ['a'], confidence: 'certain', okfType: 'project', validFrom: '2026-01-01T00:00:00Z' },
  memory_supersede: { namespace: 'repo:x', factId: 'fact_1', title: 't', body: 'b', tags: ['a'], confidence: 'inferred', validFrom: '2026-01-01T00:00:00Z' },
  memory_ingest: { namespace: 'repo:x', sourceRef: 'docs/a.md', content: 'hello', onDuplicateHash: 'ingest' },
  memory_log_event: { namespace: 'repo:x', eventType: 'decision', summary: 's', relatedFactId: 'fact_1', occurredAt: '2026-01-01T00:00:00Z' },
  graph_traverse: { namespace: 'repo:x', sourceId: 'fact_1', maxDepth: 2, direction: 'both', edgeTypes: ['dependsOn'], maxNodes: 50, excludeDrafts: false },
  namespaces_list: { prefix: 'repo:' },
  whoami: {},
};

const CANNED: Record<string, unknown> = {
  listNamespaces: { data: [{ namespace: 'repo:x' }], hasMore: false, nextCursor: null },
};

describe('request fidelity against the vendored contract (spec §10.2 guard 1)', () => {
  for (const tool of TOOLS) {
    it(`${tool.name} sends only what ${tool.operation} declares`, async () => {
      const op = OPERATIONS[tool.operation];
      const recorded: { url: URL; method: string; headers: Headers; body: Record<string, unknown> | undefined }[] = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        recorded.push({ url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(CANNED[tool.operation] ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      const ctx: ToolContext = { client: new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://api.test', userAgent: 'ua', fetch: fetchImpl }) };
      await tool.handler(tool.inputSchema.parse(FULL_INPUTS[tool.name]), ctx);

      expect(recorded.length).toBeGreaterThan(0);
      const first = recorded[0];
      expect(first.method).toBe(op.method);
      const pathPattern = new RegExp('^' + op.path.replace(/\{[^}]+\}/g, '[^/]+') + '$');
      expect(first.url.pathname).toMatch(pathPattern);
      for (const key of first.url.searchParams.keys()) expect(op.queryParameters).toContain(key);
      if (first.body) {
        for (const key of Object.keys(first.body)) expect(op.requestProperties).toContain(key);
        for (const required of op.requiredProperties) expect(first.body).toHaveProperty(required);
      } else {
        expect(op.requiredProperties).toEqual([]);
      }
      expect(first.headers.has('idempotency-key')).toBe(op.acceptsIdempotencyKey);
    });
  }
});
