import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BASE_URL } from './client';
import { UsageError } from './errors';

export interface Credentials {
  apiKey: string;
  accountId: string | null;
  source: 'dashboard' | 'authmd';
  obtainedAt: string;
}

export interface Config {
  namespace?: string;
  baseUrl?: string;
}

export interface DirEnv {
  SYNAPSETREE_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  APPDATA?: string;
}

export const KEY_PATTERN = /^stree_[A-Za-z0-9_-]{43}$/;
const CREDENTIALS_FILE = 'credentials.json';
const CONFIG_FILE = 'config.json';

export function configDir(env: DirEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.SYNAPSETREE_CONFIG_DIR) return env.SYNAPSETREE_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'synapsetree');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'synapsetree');
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'synapsetree');
  return join(home, '.config', 'synapsetree');
}

async function readJson<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UsageError(`${path} is not valid JSON. Fix it or delete it.`);
  }
}

/** Atomic: temp file in the same directory, mode 0600, then rename over the target. Modes are best-effort on Windows. */
async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const target = join(dir, name);
  const tmp = join(dir, `${name}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function readCredentials(dir: string): Promise<Credentials | null> {
  const value = await readJson<Credentials>(join(dir, CREDENTIALS_FILE));
  if (value && typeof value.apiKey !== 'string') throw new UsageError(`${join(dir, CREDENTIALS_FILE)} has no apiKey. Fix it or delete it.`);
  return value;
}

export function writeCredentials(dir: string, creds: Credentials): Promise<void> {
  return writeJson(dir, CREDENTIALS_FILE, creds);
}

export async function deleteCredentials(dir: string): Promise<boolean> {
  try {
    await unlink(join(dir, CREDENTIALS_FILE));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function readConfig(dir: string): Promise<Config> {
  return (await readJson<Config>(join(dir, CONFIG_FILE))) ?? {};
}

export function writeConfig(dir: string, config: Config): Promise<void> {
  return writeJson(dir, CONFIG_FILE, config);
}

export interface Settings {
  apiKey?: string;
  keySource: 'env' | 'file' | null;
  accountId: string | null;
  baseUrl: string;
  namespace?: string;
  dir: string;
}

export async function resolveSettings(env: NodeJS.ProcessEnv = process.env, dir: string = configDir(env)): Promise<Settings> {
  const creds = await readCredentials(dir);
  const config = await readConfig(dir);
  const envKey = env.SYNAPSETREE_API_KEY;
  const apiKey = envKey || creds?.apiKey;
  return {
    apiKey,
    keySource: envKey ? 'env' : creds ? 'file' : null,
    accountId: envKey ? null : (creds?.accountId ?? null),
    baseUrl: (env.SYNAPSETREE_BASE_URL || config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    namespace: env.SYNAPSETREE_NAMESPACE || config.namespace,
    dir,
  };
}

export function maskKey(key: string): string {
  return `stree_…${key.slice(-4)}`;
}
