import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const uuid = vi.hoisted(() => ({ value: '' as string }));
vi.mock('crypto', async (orig) => {
  const real = await orig<typeof import('crypto')>();
  return { ...real, randomUUID: () => uuid.value || real.randomUUID() };
});

import { writeFileAtomic, readCached, assertHttps } from '../src/fsSafe';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'fssafe-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  uuid.value = '';
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates parent dirs, writes the data with mode 0600, leaves no temp file', () => {
    const dir = scratch();
    const file = join(dir, 'a', 'b', 'out.json');
    writeFileAtomic(file, '{"x":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"x":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['out.json']);
  });

  it('replaces an existing file', () => {
    const file = join(scratch(), 'out.txt');
    writeFileSync(file, 'old');
    writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('refuses to follow a symlink planted at the temp path', () => {
    const dir = scratch();
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    uuid.value = 'fixed-uuid';
    symlinkSync(victim, join(dir, `out.txt.${process.pid}.fixed-uuid.tmp`));
    expect(() => writeFileAtomic(join(dir, 'out.txt'), 'evil')).toThrow(/EEXIST/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
  });

  it('removes the temp file and leaves the destination alone when the rename fails', () => {
    const dir = scratch();
    const dest = join(dir, 'dest');
    mkdirSync(dest);
    writeFileSync(join(dest, 'keep'), 'k'); // non-empty directory: renameSync onto it fails
    expect(() => writeFileAtomic(dest, 'data')).toThrow();
    expect(readdirSync(dir)).toEqual(['dest']);
    expect(readFileSync(join(dest, 'keep'), 'utf8')).toBe('k');
  });
});

describe('readCached', () => {
  it('returns contents, or null when the file is missing', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'f'), 'hi');
    expect(readCached(join(dir, 'f'))).toBe('hi');
    expect(readCached(join(dir, 'missing'))).toBeNull();
  });

  it('rethrows errors other than ENOENT', () => {
    expect(() => readCached(scratch())).toThrow(/EISDIR/);
  });
});

describe('assertHttps', () => {
  it('accepts https and rejects everything else', () => {
    expect(() => assertHttps('https://huggingface.co/x')).not.toThrow();
    expect(() => assertHttps('http://huggingface.co/x')).toThrow('Refusing non-HTTPS URL: http://huggingface.co/x');
    expect(() => assertHttps('file:///etc/passwd')).toThrow(/Refusing non-HTTPS URL/);
  });
});
