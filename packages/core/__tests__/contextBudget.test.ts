import { describe, it, expect } from 'vitest';
import { estimateTokensWith, type ContextBudget } from '../src/utils/contextBudget';
import { estimateTokens } from '../src/utils/usage';

// T5 runtime spot-import: the four value exports resolve from the core index.
import * as coreIndex from '../src/index';

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

describe('T5 export surface', () => {
  it('the resolver surface resolves from the core index', () => {
    expect(typeof coreIndex.resolveContextBudget).toBe('function');
    expect(typeof coreIndex.resolveMaxPromptChars).toBe('function');
    expect(typeof coreIndex.resolveDefaultChunkLength).toBe('function');
    expect(typeof coreIndex.estimateTokensWith).toBe('function');
    expect(coreIndex.resolveMaxPromptChars(coreIndex.resolveContextBudget(undefined), 'resolve')).toBe(40_000);
  });
});
