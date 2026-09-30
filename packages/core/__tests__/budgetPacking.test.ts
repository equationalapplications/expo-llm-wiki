import { describe, it, expect } from 'vitest';
import { packFactsByBudget, factTokenCost } from '../src/utils/budget';

const f = (id: string, chars: number) => ({ id, title: '', body: 'x'.repeat(chars), tags: [] as string[] });

describe('packFactsByBudget', () => {
  it('cost is ceil(chars/4) over title, body, tags', () => {
    expect(factTokenCost({ title: 'ab', body: 'cd', tags: ['e'] })).toBe(2); // "ab cd e" = 7 chars
  });
  it('keeps rank order and skips items that do not fit', () => {
    const r = packFactsByBudget([f('a', 40), f('b', 400), f('c', 40)], 30);
    expect(r.items.map((x) => x.id)).toEqual(['a', 'c']);
    expect(r).toMatchObject({ candidates: 3, packed: 2 });
    expect(r.tokensUsed).toBeLessThanOrEqual(30);
  });
  it('prefers value per token using scores', () => {
    const scores = new Map([['a', 1], ['b', 0.9], ['c', 0.1]]);
    const r = packFactsByBudget([f('a', 40), f('b', 40), f('c', 40)], 23, scores);
    expect(r.items.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('always keeps and truncates the top item when it alone is too big', () => {
    const r = packFactsByBudget([f('a', 4000), f('b', 4)], 10);
    expect(r.items[0].id).toBe('a');
    expect(factTokenCost(r.items[0])).toBeLessThanOrEqual(10);
    expect(r.items[0].body.length).toBeLessThan(4000);
  });
  it('budget 0 keeps an emptied top item only', () => {
    const r = packFactsByBudget([f('a', 40), f('b', 4)], 0);
    expect(r.items.map((x) => x.id)).toEqual(['a']);
    expect(r.items[0].body).toBe('');
  });
  it('does not mutate inputs', () => {
    const items = [f('a', 4000)];
    packFactsByBudget(items, 10);
    expect(items[0].body.length).toBe(4000);
  });
});