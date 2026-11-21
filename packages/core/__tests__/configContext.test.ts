import { describe, it, expect } from 'vitest';
import {
  resolveContextBudget,
  resolveMaxPromptChars,
  resolveDefaultChunkLength,
} from '../src/config/context';
import { OPS_RESOLVE_MAX_PROMPT_CHARS, HEAL_MAX_PROMPT_CHARS, OPS_MAX_EXTRACT_CHARS } from '../src/utils/contextCaps';
import { DEFAULT_MAX_CHUNK_LENGTH } from '../src/utils/chunkingDefaults';
import { ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS } from '../src/services/MaintenanceService';
import type { WikiConfig } from '../src/types';

const declared = (context: NonNullable<WikiConfig['context']>): WikiConfig => ({ context });

describe('resolveContextBudget: legacy shapes (spec test 2)', () => {
  it('no context section resolves to legacy', () => {
    expect(resolveContextBudget(undefined).mode).toBe('legacy');
    expect(resolveContextBudget({}).mode).toBe('legacy');
  });

  it('context with no budget key and context.budget legacy resolve to legacy', () => {
    expect(resolveContextBudget({ context: {} }).mode).toBe('legacy');
    expect(resolveContextBudget({ context: { budget: 'legacy' } }).mode).toBe('legacy');
  });

  it('legacy returns today caps literally (constant pin)', () => {
    const budget = resolveContextBudget(undefined);
    expect(resolveMaxPromptChars(budget, 'resolve')).toBe(40_000);
    expect(resolveMaxPromptChars(budget, 'heal')).toBe(40_000);
    expect(resolveMaxPromptChars(budget, 'extract')).toBe(24_000);
    expect(resolveDefaultChunkLength(budget)).toBe(12_000);
    // and the constants themselves are pinned, so a silent constant edit fails here
    expect(OPS_RESOLVE_MAX_PROMPT_CHARS).toBe(40_000);
    expect(HEAL_MAX_PROMPT_CHARS).toBe(40_000);
    expect(OPS_MAX_EXTRACT_CHARS).toBe(24_000);
    expect(DEFAULT_MAX_CHUNK_LENGTH).toBe(12_000);
    expect(budget.charsPerToken).toBe(4);
    expect(budget.safetyFraction).toBe(0.9);
    expect(budget.outputReserveTokens).toBe(4000);
  });
});

describe('resolveContextBudget: declared validation (R3)', () => {
  it('missing contextWindowTokens throws (never falls back to legacy)', () => {
    expect(() => resolveContextBudget(declared({ budget: 'declared' }))).toThrow(/contextWindowTokens/);
  });

  it.each([
    [0], [-5], [Number.NaN], [Infinity], ['32000' as unknown as number],
  ])('non-finite/<=0 contextWindowTokens (%p) throws', (w) => {
    expect(() => resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: w }))).toThrow(/contextWindowTokens/);
  });

  it.each([[0], [-1], [Number.NaN]])('bad charsPerToken (%p) throws', (c) => {
    expect(() => resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: 32_000, charsPerToken: c }))).toThrow(/charsPerToken/);
  });

  it.each([[0], [1.5], [-0.1], [Number.NaN]])('safetyFraction outside (0,1] (%p) throws', (s) => {
    expect(() => resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: 32_000, safetyFraction: s }))).toThrow(/safetyFraction/);
  });

  it.each([[-1], [Number.NaN], [32_000], [40_000]])('effective outputReserveTokens %p throws', (r) => {
    expect(() =>
      resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: 32_000, outputReserveTokens: r })),
    ).toThrow(/outputReserveTokens/);
  });

  it('a typo budget mode throws instead of degrading to legacy', () => {
    expect(() => resolveContextBudget(declared({ budget: 'declard' as 'declared' }))).toThrow(/budget/);
    expect(() => resolveContextBudget(declared({ budget: 'auto' as 'declared' }))).toThrow(/budget/);
  });

  it('errors carry the [core-llm-wiki] prefix', () => {
    expect(() => resolveContextBudget(declared({ budget: 'declared' }))).toThrow(/^\[core-llm-wiki\]/);
  });
});

describe('resolveMaxPromptChars: declared formula (spec test 3)', () => {
  it('window 128000 with defaults derives 124200 for resolve/heal; extract scales by 24/40', () => {
    const budget = resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: 128_000 }));
    // (128000 - 4000) * 0.9 * 4 = 446400 — above the floors
    expect(resolveMaxPromptChars(budget, 'resolve')).toBe(446_400);
    expect(resolveMaxPromptChars(budget, 'heal')).toBe(446_400);
    expect(resolveMaxPromptChars(budget, 'extract')).toBe(Math.floor((446_400 * 24_000) / 40_000));
  });

  it('window 32000 with defaults derives 100800 resolve/heal and 60480 extract', () => {
    const budget = resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: 32_000 }));
    expect(resolveMaxPromptChars(budget, 'resolve')).toBe(100_800);
    expect(resolveMaxPromptChars(budget, 'heal')).toBe(100_800);
    expect(resolveMaxPromptChars(budget, 'extract')).toBe(60_480);
  });

  it('custom charsPerToken scales the estimate', () => {
    const budget = resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: 32_000, charsPerToken: 2 }));
    expect(resolveMaxPromptChars(budget, 'resolve')).toBe(50_400);
  });

  it('floors at today caps: window 8000 clamps to 40_000/40_000/24_000', () => {
    const budget = resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: 8_000 }));
    // (8000 - 4000) * 0.9 * 4 = 14400 → floored
    expect(resolveMaxPromptChars(budget, 'resolve')).toBe(40_000);
    expect(resolveMaxPromptChars(budget, 'heal')).toBe(40_000);
    expect(resolveMaxPromptChars(budget, 'extract')).toBe(24_000);
  });
});

describe('resolveDefaultChunkLength (R2)', () => {
  it('stays 12000 in both modes', () => {
    expect(resolveDefaultChunkLength(resolveContextBudget(undefined))).toBe(12_000);
    expect(
      resolveDefaultChunkLength(resolveContextBudget(declared({ budget: 'declared', contextWindowTokens: 32_000 }))),
    ).toBe(12_000);
  });
});

describe('backfill exclusion (spec test 6)', () => {
  it('ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS stays 40_000', () => {
    expect(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS).toBe(40_000);
  });
});
