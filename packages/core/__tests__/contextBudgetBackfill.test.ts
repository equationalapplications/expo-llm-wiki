import { describe, it, expect } from 'vitest';
import { resolveContextBudget, resolveMaxPromptChars } from '../src/config/context';
import { ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS } from '../src/utils/contextCaps';

describe('resolveMaxPromptChars: backfill op (spec test 3)', () => {
  it('R1: legacy shapes return 40_000', () => {
    expect(resolveMaxPromptChars(resolveContextBudget(undefined), 'backfill')).toBe(40_000);
    expect(
      resolveMaxPromptChars(resolveContextBudget({ context: { budget: 'legacy' } }), 'backfill'),
    ).toBe(40_000);
    expect(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS).toBe(40_000);
  });

  it('R2: declared formula matches resolve and heal', () => {
    const budget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 32_000 } });
    // (32000 - 4000) * 0.9 * 4 = 100800
    expect(resolveMaxPromptChars(budget, 'backfill')).toBe(100_800);
    expect(resolveMaxPromptChars(budget, 'backfill')).toBe(resolveMaxPromptChars(budget, 'resolve'));
    expect(resolveMaxPromptChars(budget, 'backfill')).toBe(resolveMaxPromptChars(budget, 'heal'));
  });

  it('R3: floors at 40_000 when the derived cap is smaller', () => {
    // (8000 - 4000) * 0.9 * 4 = 14400 < 40_000
    const budget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 8_000 } });
    expect(resolveMaxPromptChars(budget, 'backfill')).toBe(40_000);
  });
});
