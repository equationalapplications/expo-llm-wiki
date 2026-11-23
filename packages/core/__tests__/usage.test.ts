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

describe('UsageMeter reservations', () => {
  const rec = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, estimated: false });
  it('holds tokens: remaining and fits see reservations; used does not', () => {
    const m = new UsageMeter(250);
    m.reserve(60, 120);
    expect(m.reserved).toBe(120);
    expect(m.remaining).toBe(130);
    expect(m.used).toBe(0);
    expect(m.fits(130)).toBe(true);
    expect(m.fits(131)).toBe(false);
  });
  it('settle frees the hold and charges actual; release charges nothing', () => {
    const m = new UsageMeter(250);
    const a = m.reserve(60, 120);
    m.settle(a, rec(60, 50));
    expect(m.reserved).toBe(0);
    expect(m.used).toBe(110);
    const b = m.reserve(60);
    m.release(b);
    expect(m.reserved).toBe(0);
    expect(m.used).toBe(110);
  });
  it('double settle/release is a no-op', () => {
    const m = new UsageMeter(250);
    const a = m.reserve(60, 120);
    m.settle(a, rec(60, 50));
    m.settle(a, rec(60, 50));
    m.release(a);
    expect(m.used).toBe(110);
    expect(m.reserved).toBe(0);
  });
  it('admits on the estimate, holds max(estimate, hold)', () => {
    const m = new UsageMeter(100);
    m.reserve(60, 120); // estimate fits although the hold exceeds the budget
    expect(m.reserved).toBe(120);
    expect(m.remaining).toBe(0);
    const n = new UsageMeter(100);
    n.reserve(60, 10);
    expect(n.reserved).toBe(60);
  });
  it('throws WikiBudgetExhausted(estimate, unreserved remaining)', () => {
    const m = new UsageMeter(250);
    m.reserve(60, 240);
    const err = (() => { try { m.reserve(60); } catch (e) { return e as WikiBudgetExhausted; } })();
    expect(err).toBeInstanceOf(WikiBudgetExhausted);
    expect(err!.requiredEstimate).toBe(60);
    expect(err!.remaining).toBe(10);
  });
  it('unbounded meter always reserves', () => {
    const m = new UsageMeter();
    m.reserve(1e9);
    expect(m.remaining).toBe(Infinity);
  });
  it('actual above the hold: used passes the budget, remaining clamps at 0, next reserve throws', () => {
    const m = new UsageMeter(250);
    m.settle(m.reserve(60, 120), rec(100, 200));
    expect(m.used).toBe(300);
    expect(m.remaining).toBe(0);
    expect(() => m.reserve(1)).toThrow(WikiBudgetExhausted);
  });
});
