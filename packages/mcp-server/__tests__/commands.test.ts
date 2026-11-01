import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, run } from '../src/commands';
import { readConfig, readCredentials, writeCredentials } from '../src/credentials';
import { UsageError } from '../src/errors';

const KEY = 'stree_' + 'q'.repeat(39) + 'tail';
const WHOAMI = { apiKeyId: 'k', organizationId: 'org_1', tenantDatabaseId: 'db_1', scope: 'read_write', planCode: 'pro', subscriptionStatus: 'active' };

let dir: string;
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'stmcp-cli-')), 'cfg'); });

function io(responses: Array<{ status: number; body?: unknown; problem?: boolean }>, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { 'content-type': next.problem ? 'application/problem+json' : 'application/json' } });
  }) as typeof fetch;
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env, fetch: fetchImpl, configDir: dir }, out, err, calls };
}

describe('parseArgs (spec §6)', () => {
  it('parses every command', () => {
    expect(parseArgs([])).toEqual({ kind: 'serve' });
    expect(parseArgs(['serve'])).toEqual({ kind: 'serve' });
    expect(parseArgs(['auth', '--key', KEY])).toEqual({ kind: 'auth-key', key: KEY });
    expect(parseArgs(['auth', '--email', 'a@b.c'])).toEqual({ kind: 'auth-email', email: 'a@b.c' });
    expect(parseArgs(['auth', '--email', 'a@b.c', '--base-url', 'https://t'])).toEqual({ kind: 'auth-email', email: 'a@b.c', baseUrl: 'https://t' });
    expect(parseArgs(['auth', '--revoke'])).toEqual({ kind: 'auth-revoke' });
    expect(parseArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseArgs(['config', 'set', 'namespace', 'repo:x'])).toEqual({ kind: 'config-set', key: 'namespace', value: 'repo:x' });
    expect(parseArgs(['config', 'set', 'base-url', 'https://t'])).toEqual({ kind: 'config-set', key: 'base-url', value: 'https://t' });
    expect(() => parseArgs(['config', 'set', 'base-url', 'http://api.example.com'])).toThrow(UsageError);
    expect(parseArgs(['config', 'set', 'base-url', 'http://localhost:8080'])).toEqual({ kind: 'config-set', key: 'base-url', value: 'http://localhost:8080' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
  });
  it('rejects bad input without echoing a key-shaped value', () => {
    expect(() => parseArgs(['bogus'])).toThrow(UsageError);
    expect(() => parseArgs(['auth'])).toThrow(UsageError);
    expect(() => parseArgs(['config', 'set', 'colour', 'x'])).toThrow(UsageError);
    expect(() => parseArgs(['auth', '--key', 'stree_short'])).toThrow(UsageError);
    try { parseArgs(['auth', '--key', 'stree_short']); } catch (e) { expect((e as Error).message).not.toContain('stree_short'); }
    expect(() => parseArgs(['config', 'set', 'namespace', 'Bad NS'])).toThrow(UsageError);
  });
});

describe('run', () => {
  it('auth --key verifies with whoami, stores the key, and prints status without the key', async () => {
    const h = io([{ status: 200, body: WHOAMI }, { status: 200, body: WHOAMI }]);
    expect(await run({ kind: 'auth-key', key: KEY }, h.io)).toBe(0);
    expect(await readCredentials(dir)).toMatchObject({ apiKey: KEY, source: 'dashboard' });
    const text = h.err.join('\n');
    expect(text).toContain('org_1');
    expect(text).toContain('stree_…tail');
    expect(text).not.toContain(KEY);
    expect(h.out).toEqual([]);
  });

  it('auth --key stores nothing when whoami fails', async () => {
    const h = io([{ status: 401, body: { message: 'Unauthorized' } }]);
    expect(await run({ kind: 'auth-key', key: KEY }, h.io)).toBe(1);
    expect(await readCredentials(dir)).toBeNull();
  });

  it('status reports the env key source and exits 3 with no key', async () => {
    const h = io([{ status: 200, body: WHOAMI }], { SYNAPSETREE_API_KEY: KEY, SYNAPSETREE_NAMESPACE: 'repo:z' });
    expect(await run({ kind: 'status' }, h.io)).toBe(0);
    expect(h.err.join('\n')).toMatch(/key source:\s+env/);
    expect(h.err.join('\n')).toContain('repo:z');
    const none = io([]);
    expect(await run({ kind: 'status' }, none.io)).toBe(3);
    expect(none.err.join('\n')).toContain('synapsetree-mcp auth');
  });

  it('config set writes the file', async () => {
    const h = io([]);
    expect(await run({ kind: 'config-set', key: 'namespace', value: 'repo:x' }, h.io)).toBe(0);
    expect(await run({ kind: 'config-set', key: 'base-url', value: 'https://t/' }, h.io)).toBe(0);
    expect(await readConfig(dir)).toEqual({ namespace: 'repo:x', baseUrl: 'https://t' });
  });

  it('auth --revoke deletes the file on 200, keeps it when unreachable, deletes it on 401', async () => {
    await writeCredentials(dir, { apiKey: KEY, accountId: null, source: 'dashboard', obtainedAt: 'now' });
    const ok = io([{ status: 200 }]);
    expect(await run({ kind: 'auth-revoke' }, ok.io)).toBe(0);
    expect(await readCredentials(dir)).toBeNull();

    await writeCredentials(dir, { apiKey: KEY, accountId: null, source: 'dashboard', obtainedAt: 'now' });
    const down = io([{ status: 503 }, { status: 503 }, { status: 503 }]);
    expect(await run({ kind: 'auth-revoke' }, down.io)).toBe(1);
    expect(await readCredentials(dir)).not.toBeNull();
    expect(down.err.join('\n')).toMatch(/unreachable|kept/i);

    const dead = io([{ status: 401, body: { message: 'Unauthorized' } }]);
    expect(await run({ kind: 'auth-revoke' }, dead.io)).toBe(0);
    expect(await readCredentials(dir)).toBeNull();
  });

  it('auth --revoke with an env key tells the user to unset it', async () => {
    const h = io([{ status: 200 }], { SYNAPSETREE_API_KEY: KEY });
    expect(await run({ kind: 'auth-revoke' }, h.io)).toBe(0);
    expect(h.err.join('\n')).toContain('SYNAPSETREE_API_KEY');
  });

  it('auth --email stores the key before printing status', async () => {
    const REG = { claim_token: 'stclaim_' + 'c'.repeat(43), user_code: '654321', poll: { token_endpoint: 'https://api.synapsetree.dev/oauth2/token', grant: 'urn:synapsetree:claim', interval: 0 } };
    const h = io([{ status: 200, body: REG }, { status: 200, body: { access_token: KEY, token_type: 'Bearer', account_id: 'acc', scope: 'memory:full' } }, { status: 200, body: WHOAMI }]);
    expect(await run({ kind: 'auth-email', email: 'a@b.c' }, h.io)).toBe(0);
    expect(await readCredentials(dir)).toMatchObject({ apiKey: KEY, source: 'authmd', accountId: 'acc' });
    expect(h.err.join('\n')).toContain('654321');
    expect(h.err.join('\n')).not.toContain(KEY);
  });

  it('help and version go to stdout; serve with no key exits 3', async () => {
    const h = io([]);
    expect(await run({ kind: 'help' }, h.io)).toBe(0);
    expect(h.out.join('')).toContain('synapsetree-mcp');
    expect(await run({ kind: 'version' }, h.io)).toBe(0);
    const s = io([]);
    expect(await run({ kind: 'serve' }, s.io)).toBe(3);
  });
});
