import { describe, expect, it } from 'vitest';
import {
  applyTierWeight,
  normalizeEntityIds,
  sanitizeTierWeights,
  shouldExposeReadMetadata,
} from '../src/readOptions';

describe('multi-entity read option helpers', () => {
  it('normalizes a string entity id to a one-element array', () => {
    expect(normalizeEntityIds('user-1')).toEqual(['user-1']);
  });

  it('deduplicates array entity ids while preserving first-seen order', () => {
    expect(normalizeEntityIds(['tier_wisdom', 'tier_fact', 'tier_wisdom', 'tier_working'])).toEqual([
      'tier_wisdom',
      'tier_fact',
      'tier_working',
    ]);
  });

  it('allows an empty entity id array', () => {
    expect(normalizeEntityIds([])).toEqual([]);
  });

  it('sanitizes missing, non-finite, negative, and zero weights', () => {
    const result = sanitizeTierWeights(
      ['tier_wisdom', 'tier_fact', 'tier_working', 'tier_zero', 'tier_missing'],
      {
        tier_wisdom: 2,
        tier_fact: Number.NaN,
        tier_working: -0.5,
        tier_zero: 0,
      },
    );

    expect(result).toEqual({
      tier_wisdom: 2,
      tier_fact: 1,
      tier_working: 0,
      tier_zero: 0,
      tier_missing: 1,
    });
  });

  it('returns undefined sanitized weights when caller did not provide tierWeights', () => {
    expect(sanitizeTierWeights(['tier_wisdom'], undefined)).toBeUndefined();
  });

  it('multiplies scores by sanitized entity weight', () => {
    expect(applyTierWeight(0.4, 'tier_wisdom', { tier_wisdom: 2 })).toBeCloseTo(0.8);
    expect(applyTierWeight(0.4, 'tier_fact', { tier_wisdom: 2 })).toBeCloseTo(0.4);
  });

  it('exposes metadata only for array-shaped entity ids', () => {
    expect(shouldExposeReadMetadata('tier_wisdom')).toBe(false);
    expect(shouldExposeReadMetadata(['tier_wisdom'])).toBe(true);
    expect(shouldExposeReadMetadata('tier_wisdom')).toBe(false);
  });
});
