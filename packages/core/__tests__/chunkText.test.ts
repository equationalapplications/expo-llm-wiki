import { describe, it, expect } from 'vitest';
import { __testables } from '../src/WikiMemory';

const { chunkText } = __testables;

describe('chunkText', () => {
  it('returns empty for empty input', () => {
    expect(chunkText('', 100, 0)).toEqual({ chunks: [], truncated: false });
    expect(chunkText('   ', 100, 0)).toEqual({ chunks: [], truncated: false });
  });

  it('returns single chunk when text fits', () => {
    const r = chunkText('hello world', 100, 0);
    expect(r).toEqual({ chunks: ['hello world'], truncated: false });
  });

  it('splits on paragraph break preferentially', () => {
    const a = 'a'.repeat(50);
    const b = 'b'.repeat(50);
    const text = `${a}\n\n${b}`;
    const r = chunkText(text, 60, 0);
    expect(r.chunks.length).toBe(2);
    expect(r.chunks[0]).toContain(a);
    expect(r.chunks[1]).toContain(b);
    expect(r.truncated).toBe(false);
  });

  it('falls back to sentence boundary when no paragraph break', () => {
    const s1 = 'a'.repeat(40) + '. ';
    const s2 = 'b'.repeat(40) + '.';
    const r = chunkText(s1 + s2, 50, 0);
    expect(r.chunks.length).toBe(2);
    expect(r.chunks[0].trim().endsWith('.')).toBe(true);
  });

  it('falls back to whitespace when no sentence boundary', () => {
    const text = 'word '.repeat(50); // 250 chars, no terminators
    const r = chunkText(text, 60, 0);
    expect(r.chunks.length).toBeGreaterThan(1);
    expect(r.truncated).toBe(false);
    for (const c of r.chunks) expect(c.length).toBeLessThanOrEqual(60);
  });

  it('hard cuts when no break exists at all', () => {
    const text = 'x'.repeat(200);
    const r = chunkText(text, 50, 0);
    expect(r.truncated).toBe(true);
    expect(r.chunks.length).toBe(4);
  });

  it('applies overlap as prefix of next chunk', () => {
    const a = 'a'.repeat(50);
    const b = 'b'.repeat(50);
    const text = `${a}\n\n${b}`;
    const r = chunkText(text, 60, 10);
    expect(r.chunks.length).toBe(2);
    // last 10 chars of chunk[0] should appear at start of chunk[1]
    const tail = r.chunks[0].slice(-10);
    expect(r.chunks[1].startsWith(tail)).toBe(true);
  });

  it('does not infinite loop on pathological single-token input', () => {
    const text = 'x'.repeat(10000);
    const r = chunkText(text, 100, 50);
    expect(r.chunks.length).toBeLessThan(500); // sanity
  });

  it('handles 200KB input quickly', () => {
    const text = ('Sentence one. Sentence two.\n\n').repeat(7000); // ~200KB
    const t0 = Date.now();
    const r = chunkText(text, 12000, 400);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect(r.chunks.length).toBeGreaterThan(1);
  });
});
