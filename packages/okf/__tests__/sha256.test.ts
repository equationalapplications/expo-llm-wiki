import { describe, it, expect } from 'vitest';
import { sha256, utf8Encode } from '../src/sha256';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('sha256 (FIPS 180-4 vectors)', () => {
  it('empty message', () => {
    expect(hex(sha256(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('abc', () => {
    expect(hex(sha256(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('56-byte two-block message', () => {
    expect(hex(sha256(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
  it('lengths around the padding boundary match node:crypto', async () => {
    const { createHash } = await import('node:crypto');
    for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) {
      const msg = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
      expect(hex(sha256(msg))).toBe(createHash('sha256').update(msg).digest('hex'));
    }
  });
});

describe('utf8Encode', () => {
  const enc = new TextEncoder();
  it.each([['ascii', 'hello'], ['two-byte', 'é'], ['three-byte', '☕'], ['four-byte', '😀'], ['mixed', 'Café ☕ visit — see [docs] 😀']])(
    '%s matches TextEncoder', (_n, s) => {
      expect(Array.from(utf8Encode(s))).toEqual(Array.from(enc.encode(s)));
    });
  it('a lone surrogate encodes as U+FFFD (EF BF BD)', () => {
    expect(Array.from(utf8Encode('\uD800'))).toEqual([0xef, 0xbf, 0xbd]);
    expect(Array.from(utf8Encode('a\uDC00b'))).toEqual(Array.from(enc.encode('a\uDC00b')));
    expect(Array.from(utf8Encode('\uD83D'))).toEqual(Array.from(enc.encode('\uD83D')));
  });
});

describe('sha256WithPrefix', () => {
  it('matches node:crypto over prefix + suffix at every block boundary', async () => {
    const { createHash } = await import('node:crypto');
    const { sha256WithPrefix } = await import('../src/sha256');
    const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
    for (const p of [0, 1, 55, 56, 63, 64, 65, 119, 128, 1000]) {
      const finish = sha256WithPrefix(bytes(p, 7));
      for (const q of [0, 1, 8, 55, 64, 200]) {
        const want = createHash('sha256').update(bytes(p, 7)).update(bytes(q, 3)).digest('hex');
        expect(Buffer.from(finish(bytes(q, 3))).toString('hex'), `p=${p} q=${q}`).toBe(want);
      }
    }
  });
});
