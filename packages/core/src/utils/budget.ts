import { estimateTokens } from './usage';
import { safeSlice } from './pure';

export interface PackResult<T> { items: T[]; tokensUsed: number; candidates: number; packed: number }

type Packable = { id: string; title: string; body: string; tags: string[] };

export function factTokenCost(f: { title: string; body: string; tags: string[] }): number {
  return estimateTokens(`${f.title} ${f.body} ${f.tags.join(' ')}`);
}

/** Greedy value-per-token packing (spec 2026-09-29 §7.1). Pure. */
export function packFactsByBudget<T extends Packable>(items: T[], budget: number, scores?: ReadonlyMap<string, number>): PackResult<T> {
  const candidates = items.length;
  if (candidates === 0) return { items: [], tokensUsed: 0, candidates: 0, packed: 0 };

  let top = items[0];
  let topCost = factTokenCost(top);
  if (topCost > budget) {
    const overhead = estimateTokens(`${top.title}  ${top.tags.join(' ')}`);
    top = { ...top, body: safeSlice(top.body, 0, Math.max(0, (budget - overhead) * 4)) };
    topCost = factTokenCost(top);
  }

  const kept: Array<{ rank: number; item: T }> = [{ rank: 0, item: top }];
  let used = topCost;
  const rest = items.slice(1).map((item, i) => {
    const rank = i + 1;
    const cost = factTokenCost(item);
    const s = scores?.get(item.id);
    const value = typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1 / (rank + 1);
    return { rank, item, cost, density: value / Math.max(1, cost) };
  });
  rest.sort((a, b) => (b.density - a.density) || (a.rank - b.rank));
  for (const r of rest) {
    if (used + r.cost <= budget) {
      kept.push({ rank: r.rank, item: r.item });
      used += r.cost;
    }
  }
  kept.sort((a, b) => a.rank - b.rank);
  return { items: kept.map((k) => k.item), tokensUsed: used, candidates, packed: kept.length };
}