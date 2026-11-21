import { describe, it, expect } from 'vitest';
import { estimateTokensWith, type ContextBudget } from '../src/utils/contextBudget';
import { estimateTokens } from '../src/utils/usage';

const legacy: ContextBudget = {
  mode: 'legacy',
  charsPerToken: 4,
  safetyFraction: 0.9,
  outputReserveTokens: 4000,
};

describe('estimateTokensWith (spec test 5)', () => {
  it('chars/4 rounds up (9 chars → 3)', () => {
    expect(estimateTokensWith(legacy, 'x'.repeat(9))).toBe(3);
  });

  it('a denser budget estimates above the chars/4 figure', () => {
    expect(estimateTokensWith({ ...legacy, charsPerToken: 2 }, 'x'.repeat(9))).toBe(5);
  });

  it('is byte-equal to estimateTokens under the legacy budget', () => {
    for (const n of [0, 1, 3, 4, 5, 399, 400, 401, 12_000, 40_000]) {
      expect(estimateTokensWith(legacy, 'y'.repeat(n))).toBe(estimateTokens('y'.repeat(n)));
    }
  });
});
