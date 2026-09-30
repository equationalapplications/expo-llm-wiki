import { describe, it, expect } from 'vitest';
import { estimateTokens, UsageMeter, WikiBudgetExhausted } from '../src/utils/usage';

describe('estimateTokens', () => {
  it('is ceil(chars/4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('UsageMeter', () => {
  it('unbounded meter always fits and tracks usage', () => {
    const m = new UsageMeter();
    expect(m.remaining).toBe(Infinity);
    expect(m.fits(1e9)).toBe(true);
    m.record({ inputTokens: 10, outputTokens: 5, estimated: false });
    expect(m.used).toBe(15);
    expect(m.estimated).toBe(false);
  });
  it('bounded meter subtracts and flags estimates', () => {
    const m = new UsageMeter(100);
    m.record({ inputTokens: 60, outputTokens: 10, estimated: true });
    expect(m.remaining).toBe(30);
    expect(m.estimated).toBe(true);
    expect(m.fits(30)).toBe(true);
    expect(m.fits(31)).toBe(false);
    m.record({ inputTokens: 50, outputTokens: 0, estimated: false });
    expect(m.remaining).toBe(0);
  });
  it('rejects a negative or non-finite budget', () => {
    expect(() => new UsageMeter(-1)).toThrow(TypeError);
    expect(() => new UsageMeter(NaN)).toThrow(TypeError);
  });
});

describe('WikiBudgetExhausted', () => {
  it('carries the estimate and remaining budget', () => {
    const e = new WikiBudgetExhausted(500, 20);
    expect(e).toBeInstanceOf(Error);
    expect(e.requiredEstimate).toBe(500);
    expect(e.remaining).toBe(20);
    expect(e.name).toBe('WikiBudgetExhausted');
  });
});
