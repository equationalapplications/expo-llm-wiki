import { describe, it, expect } from 'vitest';
import { runBatched } from '../src/services/BoundedLlmCall';
import { WikiBudgetExhausted } from '../src/utils/usage';

const build = (b: number[]) => ({ systemPrompt: 's', userPrompt: b.join(',') });

describe('runBatched budget stop', () => {
  it('stops at the first budget error, keeps earlier results, reports the rest as unattempted', async () => {
    // No maxOutputTokens ⇒ DEFAULT_BATCH_SIZE (10) items per call.
    const items = Array.from({ length: 30 }, (_, i) => i + 1);
    let calls = 0;
    const out = await runBatched<number, number[]>({
      items,
      buildPrompt: build,
      call: async () => { calls++; if (calls === 2) throw new WikiBudgetExhausted(99, 1); return 'ok'; },
      parse: (_t, batch) => batch,
      maxPromptChars: 1e9,
    });
    expect(out.results).toEqual([items.slice(0, 10)]);
    expect(out.skipped).toEqual([]);
    expect(out.unattempted).toEqual(items.slice(10));
    expect(out.budgetStop).toEqual({ requiredEstimate: 99 });
    expect(calls).toBe(2);
  });

  it('a budget error on a single-item batch is not a skip', async () => {
    const out = await runBatched<number, number[]>({
      items: [1],
      buildPrompt: build,
      call: async () => { throw new WikiBudgetExhausted(5, 0); },
      parse: (_t, b) => b,
      maxPromptChars: 1e9,
    });
    expect(out.skipped).toEqual([]);
    expect(out.unattempted).toEqual([1]);
  });

  it('without a budget error, unattempted is empty and budgetStop absent', async () => {
    const out = await runBatched<number, number[]>({
      items: [1, 2], buildPrompt: build, call: async () => 'ok', parse: (_t, b) => b, maxPromptChars: 1e9,
    });
    expect(out.unattempted).toEqual([]);
    expect(out.budgetStop).toBeUndefined();
  });
});
