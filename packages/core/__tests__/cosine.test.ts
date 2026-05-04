import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/utils/cosine';

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
