import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { SynapseTreeError, UsageError } from '../src/errors';

interface Recorded { url: string; method: string; headers: Record<string, string>; body: string | null }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail: `detail for ${code}`, requestId: 'req-42', ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'request-id': 'req-42' },
  });
}

function makeClient(responses: Array<Response | Error>, opts: { apiKey?: string | null } = {}) {
  const calls: Recorded[] = [];
  const waits: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: (init?.body as string | null) ?? null });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const client = new SynapseTreeClient({
    apiKey: opts.apiKey === null ? undefined : (opts.apiKey ?? 'stree_' + 'k'.repeat(43)),
    baseUrl: 'https://api.test.example/',
    userAgent: 'synapsetree-mcp/test',
    fetch: fetchImpl,
    sleep: async (ms) => { waits.push(ms); },
    random: () => 0,
  });
  return { client, calls, waits };
}

describe('SynapseTreeClient (spec §5.2)', () => {
  it('builds URLs with path and query parameters and strips the trailing slash', async () => {
    const { client, calls } = makeClient([json(200, { ok: true })]);
    await client.call('listNamespaces', { query: { prefix: 'repo:', limit: 100, after: undefined } });
    expect(calls[0].url).toBe('https://api.test.example/v1/namespaces?prefix=repo%3A&limit=100');
    expect(calls[0].method).toBe('GET');
  });

  it('substitutes and encodes path parameters', async () => {
    const { client, calls } = makeClient([json(200, {})]);
    await client.call('supersedeFact', { path: { factId: 'fact/1' }, body: { namespace: 'n', replacement: { kind: 'new' } } });
    expect(calls[0].url).toBe('https://api.test.example/v1/memory/facts/fact%2F1/supersede');
  });

  it('sends the bearer, accept, user-agent and JSON content-type headers', async () => {
    const { client, calls } = makeClient([json(201, {})]);
    await client.call('rememberFact', { body: { namespace: 'n', title: 't', body: 'b' } });
    const h = calls[0].headers;
    expect(h.authorization).toBe('Bearer stree_' + 'k'.repeat(43));
    expect(h.accept).toBe('application/json, application/problem+json');
    expect(h['user-agent']).toBe('synapsetree-mcp/test');
    expect(h['content-type']).toBe('application/json');
    expect(calls[0].body).toBe(JSON.stringify({ namespace: 'n', title: 't', body: 'b' }));
  });

  it('sends an Idempotency-Key only where the contract allows one, and reuses it across retries', async () => {
    const { client, calls } = makeClient([problem(503, 'unavailable'), json(201, {})]);
    await client.call('rememberFact', { body: { namespace: 'n', title: 't', body: 'b' } });
    expect(calls).toHaveLength(2);
    expect(calls[0].headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{1,255}$/);
    expect(calls[1].headers['idempotency-key']).toBe(calls[0].headers['idempotency-key']);

    const read = makeClient([json(200, {})]);
    await read.client.call('queryMemory', { body: { namespaces: ['n'], query: '' } });
    expect(read.calls[0].headers['idempotency-key']).toBeUndefined();
  });

  it('form-encodes the OAuth operations and sends no bearer on the unauthenticated ones', async () => {
    const { client, calls } = makeClient([json(200, { claim_token: 'x' }), json(400, { error: 'authorization_pending', interval: 5 }), json(200, undefined)], { apiKey: null });
    await client.call('registerAgentIdentity', { body: { email: 'a@b.c' } });
    expect(calls[0].headers.authorization).toBeUndefined();
    await client.call('oauthToken', { form: { grant_type: 'urn:synapsetree:claim', assertion: 'stclaim_abc' } });
    expect(calls[1].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[1].body).toBe('grant_type=urn%3Asynapsetree%3Aclaim&assertion=stclaim_abc');
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it('returns oauthToken 400 bodies as values instead of throwing', async () => {
    const { client } = makeClient([json(400, { error: 'authorization_pending', error_description: 'wait', interval: 7 })], { apiKey: null });
    const res = await client.call<{ error: string; interval: number }>('oauthToken', { form: { grant_type: 'g', assertion: 'a' } });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('authorization_pending');
    expect(res.data.interval).toBe(7);
  });

  it('sends the key as bearer and as the token field on revoke', async () => {
    const { client, calls } = makeClient([new Response(null, { status: 200 })]);
    const key = 'stree_' + 'k'.repeat(43);
    const res = await client.call('oauthRevoke', { form: { token: key, token_type_hint: 'access_token' } });
    expect(calls[0].headers.authorization).toBe(`Bearer ${key}`);
    expect(calls[0].body).toContain(`token=${key}`);
    expect(res.data).toBeUndefined();
  });

  it('throws a UsageError (no HTTP call) when an authenticated operation has no key', async () => {
    const { client, calls } = makeClient([], { apiKey: null });
    await expect(client.call('whoami')).rejects.toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it('retries 408/429/502/503/504 and network errors at most twice, honoring Retry-After', async () => {
    const { client, calls, waits } = makeClient([
      problem(429, 'rate_limited', { retryAfterSeconds: 2 }),
      new TypeError('fetch failed'),
      json(200, { ok: true }),
    ]);
    // the 429 above carries no Retry-After header; add one on a second scenario below
    await client.call('whoami');
    expect(calls).toHaveLength(3);
    expect(waits[0]).toBe(2000); // from the problem body's retryAfterSeconds
    expect(waits[1]).toBe(4000); // 1000 * 2^2, random() = 0

    const withHeader = makeClient([new Response('', { status: 503, headers: { 'retry-after': '3' } }), json(200, {})]);
    await withHeader.client.call('whoami');
    expect(withHeader.waits).toEqual([3000]);
  });

  it('maps a mid-body failure to a transient network error and retries', async () => {
    const failing = (): Response =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial"'));
            controller.error(new Error('terminated'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const { client, calls } = makeClient([failing(), failing(), failing()]);
    await expect(client.call('whoami')).rejects.toMatchObject({ status: 0, code: 'network_error' });
    expect(calls).toHaveLength(3);
  });

  it('caps a Retry-After wait at 30 seconds', async () => {
    const { client, waits } = makeClient([json(429, { code: 'rate_limited' }, { 'retry-after': '86400' }), json(200, {})]);
    await client.call('whoami');
    expect(waits[0]).toBe(30_000);
  });

  it('never retries oauthToken: each poll can mint the one-time key', async () => {
    const { client, calls } = makeClient([problem(503, 'unavailable')]);
    await expect(client.call('oauthToken', { form: { grant_type: 'urn:g', assertion: 'a' } })).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  it('gives up after three attempts with the last error', async () => {
    const { client, calls } = makeClient([problem(503, 'unavailable'), problem(503, 'unavailable'), problem(503, 'unavailable')]);
    await expect(client.call('whoami')).rejects.toMatchObject({ code: 'unavailable', status: 503 });
    expect(calls).toHaveLength(3);
  });

  it('never retries other 4xx or a 500', async () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422, 500]) {
      const { client, calls } = makeClient([problem(status, 'whatever')]);
      await expect(client.call('whoami')).rejects.toBeInstanceOf(SynapseTreeError);
      expect(calls).toHaveLength(1);
    }
  });

  it('maps problem+json to a typed error with request id and retryAfterSeconds', async () => {
    const { client } = makeClient([problem(409, 'inference_not_configured', { retryAfterSeconds: 9 })]);
    const err = await client.call('whoami').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SynapseTreeError);
    expect(err).toMatchObject({ status: 409, code: 'inference_not_configured', detail: 'detail for inference_not_configured', requestId: 'req-42', retryAfterSeconds: 9 });
  });

  it('maps the gateway 401 and a non-problem 403 to unauthorized', async () => {
    const a = makeClient([new Response('{"message":"Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })]);
    await expect(a.client.call('whoami')).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    const b = makeClient([new Response('{"message":"Forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } })]);
    await expect(b.client.call('whoami')).rejects.toMatchObject({ code: 'unauthorized', status: 403 });
  });

  it('maps an unparseable error to http_<status> with the body as detail', async () => {
    const { client } = makeClient([new Response('<html>bad gateway</html>', { status: 500, headers: { 'content-type': 'text/html' } })]);
    await expect(client.call('whoami')).rejects.toMatchObject({ code: 'http_500', detail: '<html>bad gateway</html>' });
  });

  it('captures Request-Id, RateLimit, RateLimit-Policy and Idempotent-Replayed', async () => {
    const { client } = makeClient([json(201, { id: 'fact_1' }, { 'request-id': 'r-1', ratelimit: '"default";r=58', 'ratelimit-policy': '"default";q=60;w=60', 'idempotent-replayed': 'true' })]);
    const res = await client.call('rememberFact', { body: { namespace: 'n', title: 't', body: 'b' } });
    expect(res).toMatchObject({ status: 201, data: { id: 'fact_1' }, requestId: 'r-1', rateLimit: '"default";r=58', rateLimitPolicy: '"default";q=60;w=60', idempotentReplayed: true });
  });

  it('aborts a request that exceeds the timeout and counts it as a network error', async () => {
    let aborted = false;
    const hanging = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason ?? new Error('aborted')); });
      })) as typeof fetch;
    const client = new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://x', userAgent: 'ua', fetch: hanging, sleep: async () => {}, random: () => 0 });
    await expect(client.call('whoami', { timeoutMs: 5 })).rejects.toMatchObject({ code: 'network_error' });
    expect(aborted).toBe(true);
  });
});
