import { describe, expect, it } from 'vitest';
import { runBatched } from '../../src/services/BoundedLlmCall';

const overflowErr = new Error("prompt is too long: 100 tokens > 50 token maximum");
const netErr = new Error('socket hang up');

function makeArgs<T>(opts: {
  items: T[];
  call: (p: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  supportsEscalation?: boolean;
  onSkip?: (item: T, err: unknown) => void;
}) {
  return {
    items: opts.items,
    buildPrompt: (batch: T[]) => ({ systemPrompt: 's', userPrompt: batch.map(String).join(',') }),
    call: opts.call,
    parse: (_text: string, batch: T[]) => batch,
    maxPromptChars: 100000,
    supportsEscalation: opts.supportsEscalation,
    onSkip: opts.onSkip,
  };
}

describe('runBatched overflow', () => {
  it('splits at batch size > 1 and extracts every item (no call_error)', async () => {
    const items = [1, 2, 3, 4];
    let first = true;
    const outcome = await runBatched<number, number[]>(makeArgs({
      items,
      call: async (p) => {
        if (first && p.userPrompt.split(',').length > 2) { first = false; throw overflowErr; }
        return 'ok';
      },
    }));
    expect(outcome.results.flat().sort()).toEqual([1, 2, 3, 4]);
    expect(outcome.skipped).toEqual([]);
  });

  it('opt-out caller: overflow at size 1 skips non_convergent, calls onSkip with the error', async () => {
    const skipped: Array<[number, unknown]> = [];
    const outcome = await runBatched<number, number[]>(makeArgs({
      items: [7],
      call: async () => { throw overflowErr; },
      onSkip: (item, err) => skipped.push([item, err]),
    }));
    expect(outcome.results).toEqual([]);
    expect(outcome.skipped).toEqual([{ item: 7, reason: 'non_convergent' }]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0][0]).toBe(7);
    expect(skipped[0][1]).toBe(overflowErr);
  });

  it('opt-out caller: overflow does NOT rethrow at batch > 1 (old behavior threw)', async () => {
    const outcome = await runBatched<number, number[]>(makeArgs({
      items: [1, 2],
      call: async () => { throw overflowErr; },
    }));
    expect(outcome.results).toEqual([]);
    expect(outcome.skipped.map(s => s.item).sort()).toEqual([1, 2]);
  });

  it('non-overflow call errors at batch > 1 still propagate (unchanged)', async () => {
    await expect(runBatched<number, number[]>(makeArgs({
      items: [1, 2],
      call: async () => { throw netErr; },
    }))).rejects.toBe(netErr);
  });

  it('opt-out caller: vLLM dual-match message at size 1 makes exactly one call, then skips', async () => {
    let calls = 0;
    const dual = new Error('max_tokens is too large: 4096 tokens. This model supports at most 8192 context length tokens.');
    const outcome = await runBatched<number, number[]>(makeArgs({
      items: [7],
      call: async () => { calls += 1; throw dual; },
    }));
    expect(calls).toBe(1);
    expect(outcome.skipped).toEqual([{ item: 7, reason: 'non_convergent' }]);
  });

  it('opt-in caller: overflow at size 1 escalates then skips (ladder still capped at 3)', async () => {
    let calls = 0;
    const outcome = await runBatched<number, number[]>({
      items: [7],
      buildPrompt: (batch: number[], attemptLevel = 0) => ({
        systemPrompt: 's'.repeat(200 - attemptLevel * 50),
        userPrompt: String(batch[0]),
      }),
      call: async () => { calls += 1; throw overflowErr; },
      parse: (_t: string, b: number[]) => b,
      maxPromptChars: 100000,
      supportsEscalation: true,
    });
    // ladder levels L0..L3 each make one call, then L3 gives up
    expect(calls).toBe(4);
    expect(outcome.results).toEqual([]);
    expect(outcome.skipped).toEqual([{ item: 7, reason: 'non_convergent' }]);
  });

  it('singleton batch, rate-limit wording skips as transient call_error (not non_convergent cooldown)', async () => {
    const rateLimitErr = new Error('Input exceeds the tokens-per-minute limit. Please retry after 30 seconds.');
    const outcome = await runBatched<number, number[]>(makeArgs({
      items: [7],
      call: async () => { throw rateLimitErr; },
    }));
    expect(outcome.results).toEqual([]);
    expect(outcome.skipped).toEqual([{ item: 7, reason: 'call_error' }]);
  });
});
