import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/utils/cosine';
import { parseEmbedding } from '../src/utils/embedding';

describe('cosineSimilarity', () => {
  it('identical vectors → 1.0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('orthogonal vectors → 0.0', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it('opposite vectors → -1.0', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
  });

  it('zero vector → 0 (no crash)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it('arbitrary vectors compute correctly', () => {
    // [1,1] · [1,0] = 1; |[1,1]| = √2; |[1,0]| = 1 → 1/√2 ≈ 0.707
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(0.707, 2);
  });

  it('mismatched lengths uses shorter length', () => {
    // [1,0] · [1,0,0] = 1; both unit-ish; doesn't crash
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).not.toThrow();
  });
});

describe('parseEmbedding()', () => {
  it('parses valid BLOB into Float32Array', () => {
    const original = new Float32Array([1.0, 0.5, -0.5]);
    const blob = new Uint8Array(original.buffer);
    const result = parseEmbedding(blob, null);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result![0]).toBeCloseTo(1.0);
    expect(result![1]).toBeCloseTo(0.5);
    expect(result![2]).toBeCloseTo(-0.5);
  });

  it('returns null for corrupt BLOB (byteLength not divisible by 4)', () => {
    const blob = new Uint8Array([1, 2, 3]); // 3 bytes — invalid
    expect(parseEmbedding(blob, null)).toBeNull();
  });

  it('parses JSON TEXT when blob is null', () => {
    const result = parseEmbedding(null, '[1.0, 0.0, -1.0]');
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(1.0);
  });

  it('returns null for corrupt JSON TEXT', () => {
    expect(parseEmbedding(null, 'not-json')).toBeNull();
  });

  it('prefers BLOB over TEXT when both provided', () => {
    const original = new Float32Array([2.0]);
    const blob = new Uint8Array(original.buffer);
    const result = parseEmbedding(blob, '[99.0]'); // TEXT has different value
    expect(result![0]).toBeCloseTo(2.0); // BLOB wins
  });

  it('returns null when both blob and text are null', () => {
    expect(parseEmbedding(null, null)).toBeNull();
    expect(parseEmbedding(undefined, undefined)).toBeNull();
  });

  it('copies BLOB bytes so mutations to source do not affect returned array', () => {
    const original = new Float32Array([1.0, 2.0]);
    const buf = new ArrayBuffer(8);
    new Float32Array(buf).set(original);
    const blob = new Uint8Array(buf);
    const result = parseEmbedding(blob, null)!;
    // Mutate the source buffer
    new Float32Array(buf)[0] = 999.0;
    expect(result[0]).toBeCloseTo(1.0); // copy unaffected
  });
});

describe('cosineSimilarity() with ArrayLike inputs', () => {
  it('accepts Float32Array and produces same result as number[]', () => {
    const a = [0.6, 0.8];
    const b = [1.0, 0.0];
    const float32A = new Float32Array(a);
    const float32B = new Float32Array(b);
    const scoreArr = cosineSimilarity(a, b);
    const scoreF32 = cosineSimilarity(float32A, float32B);
    expect(scoreF32).toBeCloseTo(scoreArr, 5);
  });
});
