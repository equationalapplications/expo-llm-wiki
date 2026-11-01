import { describe, expect, it } from 'vitest';
import { ClaimError, registerByEmail } from '../src/authmd';
import { SynapseTreeClient } from '../src/client';

const KEY = 'stree_' + 'z'.repeat(43);
const REG = { claim_token: 'stclaim_' + 'c'.repeat(43), user_code: '123456', poll: { token_endpoint: 'https://api.test/oauth2/token', grant: 'urn:synapsetree:claim', interval: 5 } };
const MINT = { access_token: KEY, token_type: 'Bearer', account_id: 'acc_7', scope: 'memory:full' };

type Scripted = { status: number; body: unknown; problem?: boolean } | Error;

function scenario(responses: Scripted[]) {
  const calls: { url: string; body: string | null }[] = [];
  const waits: number[] = [];
  const lines: string[] = [];
  let clock = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: (init?.body as string | null) ?? null });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': next.problem ? 'application/problem+json' : 'application/json' } });
  }) as typeof fetch;
  const client = new SynapseTreeClient({ baseUrl: 'https://api.test', userAgent: 'ua', fetch: fetchImpl, sleep: async () => {}, random: () => 0 });
  const run = () => registerByEmail(client, 'dev@example.com', {
    info: (l) => lines.push(l),
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    now: () => clock,
  });
  return { run, calls, waits, lines };
}

describe('registerByEmail (spec §7)', () => {
  it('maps a malformed token response to invalid_response instead of a TypeError', async () => {
    const empty = scenario([{ status: 200, body: REG }, { status: 400, body: undefined }]);
    await expect(empty.run()).rejects.toMatchObject({ code: 'invalid_response' });
    const garbage = scenario([{ status: 200, body: REG }, { status: 200, body: { hello: 'world' } }]);
    await expect(garbage.run()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('registers, shows the code, waits poll.interval, then stores the key from the first 200', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 400, body: { error: 'authorization_pending', interval: 5 } }, { status: 200, body: MINT }]);
    const result = await s.run();
    expect(result).toEqual({ apiKey: KEY, accountId: 'acc_7' });
    expect(s.calls[0].url).toBe('https://api.test/agent/identity');
    expect(s.calls[0].body).toBe(JSON.stringify({ email: 'dev@example.com' }));
    expect(s.calls[1].url).toBe('https://api.test/oauth2/token');
    expect(s.calls[1].body).toBe(`grant_type=urn%3Asynapsetree%3Aclaim&assertion=${REG.claim_token}`);
    expect(s.waits).toEqual([5000, 5000]);
    expect(s.lines.join('\n')).toContain('123456');
    expect(s.lines.join('\n')).toContain('dev@example.com');
  });

  it('honors a larger interval on pending and adds 5 s on slow_down without one', async () => {
    const s = scenario([
      { status: 200, body: REG },
      { status: 400, body: { error: 'authorization_pending', interval: 8 } },
      { status: 400, body: { error: 'slow_down' } },
      { status: 400, body: { error: 'slow_down', interval: 20 } },
      { status: 200, body: MINT },
    ]);
    await s.run();
    expect(s.waits).toEqual([5000, 8000, 13000, 20000]);
  });

  it('keeps polling through server_error and network errors', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 500, body: { error: 'server_error' } }, new TypeError('fetch failed'), { status: 200, body: MINT }]);
    await expect(s.run()).resolves.toMatchObject({ apiKey: KEY });
  });

  it('treats a surviving 429 from the token endpoint as slow_down and keeps polling', async () => {
    // three 429s exhaust the client's internal retries; authmd must then
    // keep polling with a +5 s interval instead of aborting.
    const s = scenario([{ status: 200, body: REG }, { status: 429, body: { error: 'rate_limited' } }, { status: 429, body: { error: 'rate_limited' } }, { status: 429, body: { error: 'rate_limited' } }, { status: 200, body: MINT }]);
    const result = await s.run();
    expect(result.apiKey).toBe(KEY);
    expect(s.waits[1]).toBe(10_000); // 5 s interval + 5 s slow-down
  });

  it('stops on invalid_grant with the restart message', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 400, body: { error: 'invalid_grant' } }]);
    await expect(s.run()).rejects.toBeInstanceOf(ClaimError);
    await expect(scenario([{ status: 200, body: REG }, { status: 400, body: { error: 'invalid_grant' } }]).run()).rejects.toThrow(/expired|already used/);
  });

  it('prints the remedy and keeps polling on the account-wall codes', async () => {
    for (const code of ['key_limit_reached', 'database_name_taken', 'database_quota_exceeded']) {
      const s = scenario([
        { status: 200, body: REG },
        { status: 400, body: { error: code, error_description: 'fix it', error_uri: 'https://synapsetree.dev/dashboard' } },
        { status: 200, body: MINT },
      ]);
      await expect(s.run()).resolves.toMatchObject({ apiKey: KEY });
      expect(s.lines.join('\n')).toContain('fix it');
      expect(s.lines.join('\n')).toContain('https://synapsetree.dev/dashboard');
    }
  });

  it('stops with the server message on an unknown error', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 400, body: { error: 'unsupported_grant_type', error_description: 'nope' } }]);
    await expect(s.run()).rejects.toThrow(/unsupported_grant_type.*nope/);
  });

  it('stops when the registration quota is exceeded', async () => {
    const s = scenario([{ status: 403, body: { code: 'quota_exceeded', detail: 'five outstanding' }, problem: true }]);
    await expect(s.run()).rejects.toThrow(/five outstanding/);
  });

  it('gives up at the deadline', async () => {
    const pending = { status: 400, body: { error: 'authorization_pending', interval: 300 } };
    const s = scenario([{ status: 200, body: REG }, pending, pending, pending, pending, pending]);
    await expect(s.run()).rejects.toThrow(/expired/);
    expect(s.calls.length).toBeLessThanOrEqual(5);
  });

  it('never prints the claim token or the key', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 200, body: MINT }]);
    await s.run();
    const text = s.lines.join('\n');
    expect(text).not.toContain(REG.claim_token);
    expect(text).not.toContain(KEY);
  });
});
