// packages/core/__tests__/normalizeSourceRef.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeSourceRef } from '../src/utils/pure';

const ALPHABET = 'ab Z09._-/\\\u0000日 \t';
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

describe('normalizeSourceRef', () => {
  it('trims a trailing space exposed by the 255-char cut (was non-idempotent)', () => {
    const raw = 'a'.repeat(254) + ' ' + 'tail';
    const once = normalizeSourceRef(raw);
    expect(once).toBe('a'.repeat(254));
    expect(normalizeSourceRef(once!)).toBe(once);
  });

  it('is a fixed point: n(n(x)) === n(x) for 5000 generated strings', () => {
    const rnd = lcg(280);
    for (let i = 0; i < 5000; i++) {
      const len = Math.floor(rnd() * 600);
      let s = '';
      for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      const n = normalizeSourceRef(s);
      if (n !== null) expect(normalizeSourceRef(n)).toBe(n);
    }
  });

  it('keeps existing behavior for ordinary refs', () => {
    expect(normalizeSourceRef('  docs/a b.md ')).toBe('docsa b.md');
    expect(normalizeSourceRef('///')).toBeNull();
    expect(normalizeSourceRef('日本語')).toBeNull();
    expect(normalizeSourceRef('a/b')).toBe('ab');
  });
});