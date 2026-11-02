import { describe, expect, it } from 'vitest';
import { ClaimError, registerByEmail } from '../src/authmd';
import { SynapseTreeClient } from '../src/client';

const KEY = 'stree_' + 'z'.repeat(43);
const REG = { claim_token: 'stclaim_' + 'c'.repeat(43), user_code: '123456', poll: { token_endpoint: 'https://api.test/oauth2/token', grant: 'urn:synapsetree:claim', interval: 5 } };
const MINT = { access_token: KEY, token_type: 'Bearer', account_id: 'acc_7', scope: 'memory:full' };

type Scripted = { status: number; body: unknown; problem?: boolean } | Error;

function scenario(responses: Scripted[], deadlineMs?: number) {
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
    deadlineMs,
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

  it('keeps polling through a 408 and clamps a zero interval to one second', async () => {
    const s = scenario([
      { status: 200, body: { ...REG, poll: { ...REG.poll, interval: 0 } } },
      { status: 408, body: {} },
      { status: 200, body: MINT },
    ]);
    const result = await s.run();
    expect(result.apiKey).toBe(KEY);
    expect(s.waits[0]).toBe(1000);
  });

  it('throws at exactly the deadline instead of spinning on a zero-length sleep', async () => {
    // interval 60 lands the clock exactly on the deadline; remaining is 0,
    // so the loop must throw rather than sleep(0) forever.
    const s = scenario([
      { status: 200, body: { ...REG, poll: { ...REG.poll, interval: 60 } } },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
    ]);
    await expect(s.run()).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('caps a server-supplied interval at 60 s so the deadline can fire', async () => {
    const s = scenario([
      { status: 200, body: { ...REG, poll: { ...REG.poll, interval: 1e9 } } },
      { status: 400, body: { error: 'authorization_pending', interval: 1e9 } },
      { status: 200, body: MINT },
    ]);
    const result = await s.run();
    expect(result.apiKey).toBe(KEY);
    expect(s.waits[0]).toBe(60_000);
    expect(s.waits[1]).toBe(60_000);
  });

  it('never sleeps past the deadline when the interval does not divide the window', async () => {
    // 7 s does not divide 960 s: after 137 sleeps the clock is at 959 s and
    // the final sleep must be clamped to the 1 s that remains (#326: the
    // clamp compared milliseconds with seconds and never bound).
    const pending = { status: 400, body: { error: 'authorization_pending', interval: 7 } };
    const s = scenario([{ status: 200, body: { ...REG, poll: { ...REG.poll, interval: 7 } } }, ...Array.from({ length: 200 }, () => pending)]);
    await expect(s.run()).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(s.waits.reduce((a, b) => a + b, 0)).toBe(16 * 60 * 1000);
    expect(s.waits.at(-1)).toBe(1000);
  });

  it('lands the last sleep exactly on a deadline that is not a whole second', async () => {
    // 960 003 ms leaves 1003 ms after 137 sleeps of 7 s. A seconds round-trip
    // (1003 / 1000 * 1000) is inexact; the clamp must be done in milliseconds
    // so the waits sum to the window exactly and no extra near-zero poll follows.
    const pending = { status: 400, body: { error: 'authorization_pending', interval: 7 } };
    const s = scenario([{ status: 200, body: { ...REG, poll: { ...REG.poll, interval: 7 } } }, ...Array.from({ length: 200 }, () => pending)], 16 * 60 * 1000 + 3);
    await expect(s.run()).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(s.waits.at(-1)).toBe(1003);
    expect(s.waits.reduce((a, b) => a + b, 0)).toBe(16 * 60 * 1000 + 3);
    expect(s.calls.length).toBe(1 + 138);
    expect(s.waits.every((w) => Number.isInteger(w) && w >= 1)).toBe(true);
  });

  it('fails closed on a server-chosen token endpoint', async () => {
    const s = scenario([{ status: 200, body: { ...REG, poll: { ...REG.poll, token_endpoint: 'https://evil.example/oauth2/token' } } }]);
    await expect(s.run()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(s.lines.join('\n')).not.toContain('stclaim_');
  });

  it('explains a possibly-minted key when an ambiguous poll ends in invalid_grant', async () => {
    const s = scenario([
      { status: 200, body: REG },
      { status: 503, body: { code: 'unavailable' } },
      { status: 503, body: { code: 'unavailable' } },
      { status: 503, body: { code: 'unavailable' } },
      { status: 400, body: { error: 'invalid_grant' } },
    ]);
    await expect(s.run()).rejects.toMatchObject({ code: 'invalid_grant', message: expect.stringContaining('may have been issued') });
  });

  it('treats a surviving 429 from the token endpoint as slow_down and keeps polling', async () => {
    // oauthToken is single-attempt in the client, so each 429 reaches authmd
    // as one error; authmd must keep polling with a +5 s interval instead of
    // aborting.
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
      expect(s.waits).toEqual([5000, 10000]);
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
    // the 60 s poll ceiling means more polls fit in the deadline window
    expect(s.calls.length).toBeLessThanOrEqual(20);
  });

  it('never prints the claim token or the key', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 200, body: MINT }]);
    await s.run();
    const text = s.lines.join('\n');
    expect(text).not.toContain(REG.claim_token);
    expect(text).not.toContain(KEY);
  });
});

describe('registerByEmail remedy pacing (#326, spec auth-email-remedy-poll §8)', () => {
  const Q = { status: 400, body: { error: 'database_quota_exceeded', error_description: 'no free slot', error_uri: 'https://synapsetree.dev/dashboard' } };
  const K = { status: 400, body: { ...Q.body, error: 'key_limit_reached' } };
  const P = { status: 400, body: { error: 'authorization_pending' } };
  const OK = { status: 200, body: MINT };
  const R = { status: 200, body: REG };
  const WAIT = 'Waiting; approve again once it is fixed.';
  const QLINE = 'database_quota_exceeded: no free slot — https://synapsetree.dev/dashboard';
  const KLINE = 'key_limit_reached: no free slot — https://synapsetree.dev/dashboard';
  const count = (lines: string[], prefix: string) => lines.filter((l) => l.startsWith(prefix)).length;

  it('1: a persisting wall prints one pair, keyed on the code, and backs off to a 30 s ceiling', async () => {
    const varied = { status: 400, body: { ...Q.body, error_description: 'still no free slot' } };
    const s = scenario([R, Q, Q, varied, Q, Q, Q, OK]);
    await expect(s.run()).resolves.toMatchObject({ apiKey: KEY });
    expect(s.waits).toEqual([5000, 10000, 15000, 20000, 25000, 30000, 30000]);
    expect(s.lines.slice(2)).toEqual([QLINE, WAIT]);
  });

  it('2: a change of code reprints once', async () => {
    const s = scenario([R, Q, Q, K, K, OK]);
    await s.run();
    expect(s.waits).toEqual([5000, 10000, 15000, 20000, 25000]);
    expect(s.lines.slice(2)).toEqual([QLINE, WAIT, KLINE, WAIT]);
  });

  it('3: authorization_pending clears the wall; a recurrence reprints and the backoff restarts', async () => {
    const s = scenario([R, Q, Q, P, Q, OK]);
    await s.run();
    expect(s.waits).toEqual([5000, 10000, 15000, 5000, 10000]);
    expect(count(s.lines, 'database_quota_exceeded')).toBe(2);
    expect(s.lines.filter((l) => l === WAIT)).toHaveLength(2);
  });

  it('4: slow_down also clears the wall and zeroes the backoff', async () => {
    const s = scenario([R, Q, { status: 400, body: { error: 'slow_down' } }, Q, OK]);
    await s.run();
    expect(s.waits).toEqual([5000, 10000, 10000, 15000]);
    expect(count(s.lines, 'database_quota_exceeded')).toBe(2);
  });

  it('5: a transient error inside a wall neither reprints nor resets', async () => {
    const s = scenario([R, Q, { status: 503, body: { code: 'unavailable' } }, Q, OK]);
    await s.run();
    expect(s.waits).toEqual([5000, 10000, 10000, 15000]);
    expect(count(s.lines, 'database_quota_exceeded')).toBe(1);
  });

  it('6: a 429 inside a wall adds to the backoff', async () => {
    const s = scenario([R, Q, { status: 429, body: { error: 'rate_limited' } }, Q, OK]);
    await s.run();
    expect(s.waits).toEqual([5000, 10000, 15000, 20000]);
    expect(count(s.lines, 'database_quota_exceeded')).toBe(1);
  });

  it('7: a server interval on a remedy body is adopted as the floor under the backoff', async () => {
    const s = scenario([R, { status: 400, body: { ...Q.body, interval: 20 } }, Q, OK]);
    await s.run();
    expect(s.waits).toEqual([5000, 25000, 30000]);
  });

  it('8: the 60 s cap still binds', async () => {
    const s = scenario([{ status: 200, body: { ...REG, poll: { ...REG.poll, interval: 60 } } }, Q, Q, OK]);
    await s.run();
    expect(s.waits).toEqual([60000, 60000, 60000]);
    expect(count(s.lines, 'database_quota_exceeded')).toBe(1);
  });

  it('9: the deadline still ends a wall, and sleeps never decrease before the final clamp', async () => {
    const s = scenario([R, ...Array.from({ length: 40 }, () => Q)]);
    await expect(s.run()).rejects.toMatchObject({ code: 'invalid_grant', message: expect.stringMatching(/expired/) });
    expect(s.calls.length).toBe(36);
    expect(Math.max(...s.waits)).toBe(30000);
    expect(s.waits.at(-1)).toBe(15000);
    for (let i = 1; i < s.waits.length - 1; i++) expect(s.waits[i]).toBeGreaterThanOrEqual(s.waits[i - 1]);
    expect(count(s.lines, 'database_quota_exceeded')).toBe(1);
  });
});
