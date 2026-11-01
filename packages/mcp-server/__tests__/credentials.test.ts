import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEY_PATTERN, configDir, deleteCredentials, maskKey, readConfig, readCredentials, resolveSettings, writeConfig, writeCredentials,
} from '../src/credentials';
import { UsageError } from '../src/errors';

const KEY = 'stree_' + 'a'.repeat(39) + 'wxyz';
let dir: string;
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'stmcp-')), 'synapsetree'); });
afterEach(() => { /* temp dirs are left to the OS */ });

describe('configDir (spec §5.4)', () => {
  it('prefers SYNAPSETREE_CONFIG_DIR, then XDG_CONFIG_HOME, then the platform default', () => {
    expect(configDir({ SYNAPSETREE_CONFIG_DIR: '/x' }, 'darwin', '/home/u')).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/u')).toBe(join('/xdg', 'synapsetree'));
    expect(configDir({}, 'darwin', '/Users/u')).toBe(join('/Users/u', 'Library', 'Application Support', 'synapsetree'));
    expect(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'synapsetree'));
    expect(configDir({}, 'linux', '/home/u')).toBe(join('/home/u', '.config', 'synapsetree'));
  });
});

describe('credentials file', () => {
  it('round-trips and leaves no temp file behind', async () => {
    const creds = { apiKey: KEY, accountId: 'acc_1', source: 'dashboard' as const, obtainedAt: '2026-11-01T00:00:00Z' };
    await writeCredentials(dir, creds);
    expect(await readCredentials(dir)).toEqual(creds);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes the file 0600 and the directory 0700 on POSIX', async () => {
    if (process.platform === 'win32') return;
    await writeCredentials(dir, { apiKey: KEY, accountId: null, source: 'authmd', obtainedAt: 'now' });
    expect((await stat(join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('returns null when missing and deletes idempotently', async () => {
    expect(await readCredentials(dir)).toBeNull();
    expect(await deleteCredentials(dir)).toBe(false);
    await writeCredentials(dir, { apiKey: KEY, accountId: null, source: 'authmd', obtainedAt: 'now' });
    expect(await deleteCredentials(dir)).toBe(true);
    expect(await readCredentials(dir)).toBeNull();
  });

  it('refuses a malformed file with an error naming the path', async () => {
    await writeConfig(dir, {}); // creates the dir
    await writeFile(join(dir, 'credentials.json'), '{not json');
    await expect(readCredentials(dir)).rejects.toThrow(join(dir, 'credentials.json'));
    await expect(readCredentials(dir)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('config file', () => {
  it('round-trips and defaults to an empty object', async () => {
    expect(await readConfig(dir)).toEqual({});
    await writeConfig(dir, { namespace: 'repo:x' });
    await writeConfig(dir, { ...(await readConfig(dir)), baseUrl: 'https://t' });
    expect(await readConfig(dir)).toEqual({ namespace: 'repo:x', baseUrl: 'https://t' });
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual({ namespace: 'repo:x', baseUrl: 'https://t' });
  });
});

describe('resolveSettings precedence', () => {
  it('env beats file beats default', async () => {
    await writeCredentials(dir, { apiKey: KEY, accountId: 'acc', source: 'dashboard', obtainedAt: 'now' });
    await writeConfig(dir, { namespace: 'repo:file', baseUrl: 'https://file' });
    const fromFile = await resolveSettings({}, dir);
    expect(fromFile).toMatchObject({ apiKey: KEY, keySource: 'file', accountId: 'acc', baseUrl: 'https://file', namespace: 'repo:file' });
    const envKey = 'stree_' + 'b'.repeat(43);
    const fromEnv = await resolveSettings({ SYNAPSETREE_API_KEY: envKey, SYNAPSETREE_BASE_URL: 'https://env/', SYNAPSETREE_NAMESPACE: 'repo:env' }, dir);
    expect(fromEnv).toMatchObject({ apiKey: envKey, keySource: 'env', accountId: null, baseUrl: 'https://env', namespace: 'repo:env' });
  });

  it('falls back to the production base URL and no key', async () => {
    const s = await resolveSettings({}, dir);
    expect(s).toMatchObject({ apiKey: undefined, keySource: null, baseUrl: 'https://api.synapsetree.dev', namespace: undefined });
  });
});

describe('maskKey and KEY_PATTERN', () => {
  it('shows only the prefix and the last four characters', () => {
    expect(maskKey(KEY)).toBe('stree_…wxyz');
    expect(maskKey(KEY)).not.toContain('aaaa');
  });
  it('matches the documented key shape', () => {
    expect(KEY_PATTERN.test(KEY)).toBe(true);
    expect(KEY_PATTERN.test('stree_short')).toBe(false);
    expect(KEY_PATTERN.test('sk_' + 'a'.repeat(43))).toBe(false);
  });
});
