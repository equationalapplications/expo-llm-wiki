/**
 * File helpers for the benchmark CLI. A private temp file plus an atomic rename
 * replaces existsSync/writeFileSync pairs (CodeQL js/file-system-race,
 * js/insecure-temporary-file).
 */

import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** Writes via an exclusive 0600 temp file beside `path`, then renames it over `path`. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    // Only remove what this call created; an EEXIST tmp belongs to someone else.
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(tmp, { force: true });
    throw e;
  }
}

/** File contents, or null when it does not exist. Never splits the check from the read. */
export function readCached(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export function assertHttps(url: string): void {
  if (new URL(url).protocol !== 'https:') throw new Error(`Refusing non-HTTPS URL: ${url}`);
}
