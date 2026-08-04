import { describe, it, expect, vi } from 'vitest';
import {
  runBatched,
  initialBatchSize,
  isTruncationError,
  DEFAULT_BATCH_SIZE,
} from '../src/services/BoundedLlmCall';

// ---------------------------------------------------------------------------
// Helpers: a synthetic `call` that fails above a threshold batch size.
// ---------------------------------------------------------------------------

type Item = { id: string; text: string };

function makeItems(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: `i${i}`, text: `item ${i}` }));
}

/** Prompt carrying the batch verbatim, so `call` can count the batch size. */
function buildPrompt(batch: Item[]) {
  return {
    systemPrompt: 'SYS',
    userPrompt: JSON.stringify(batch),
  };
}

/**
 * Fails with a truncation-shaped error whenever the batch exceeds `threshold`.
 * Records the size of every attempted batch.
 */
function makeCall(threshold: number, sizes: number[]) {
  return async (prompts: { systemPrompt: string; userPrompt: string }) => {
    const batch = JSON.parse(prompts.userPrompt) as Item[];
    sizes.push(batch.length);
    if (batch.length > threshold) {
      throw new Error(`Model response truncated at the 8192-token limit`);
    }
    return JSON.stringify({ ids: batch.map((b) => b.id) });
  };
}

const parseIds = (text: string, batch: Item[]) => ({
  batch,
  ids: (JSON.parse(text) as { ids: string[] }).ids,
});

const NO_CHAR_CAP = 1_000_000;

describe('isTruncationError', () => {
  it('matches the shapes providers actually emit', () => {
    expect(isTruncationError(new Error('Model response truncated at the 8192-token limit'))).toBe(true);
    expect(isTruncationError(new Error('Model response truncated at the 9999-token limit'))).toBe(true);
    expect(isTruncationError(new Error('max_tokens reached'))).toBe(true);
    expect(isTruncationError(new Error('finish_reason: length'))).toBe(true);
  });

  it('does not match infrastructure failures', () => {
    expect(isTruncationError(new Error('fetch failed: ECONNRESET'))).toBe(false);
    expect(isTruncationError(new Error('401 Unauthorized'))).toBe(false);
  });
});

describe('initialBatchSize', () => {
  it('uses the conservative default when no hint is given', () => {
    expect(initialBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
    expect(initialBatchSize(0)).toBe(DEFAULT_BATCH_SIZE);
  });

  it('never sizes below the default, even for a tiny declared ceiling', () => {
    expect(initialBatchSize(500)).toBe(DEFAULT_BATCH_SIZE);
  });

  it('sizes up from a generous declared ceiling', () => {
    expect(initialBatchSize(100_000)).toBeGreaterThan(DEFAULT_BATCH_SIZE);
  });
});

describe('runBatched — sizing', () => {
  it('processes every item when nothing fails', async () => {
    const sizes: number[] = [];
    const items = makeItems(23);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: makeCall(1000, sizes),
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });

    expect(out.skipped).toEqual([]);
    expect(out.results.flatMap((r) => r.ids)).toEqual(items.map((i) => i.id));
    expect(sizes).toEqual([DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE, 3]);
    expect(out.batches).toBe(3);
  });

  it('trims a batch to maxPromptChars independently of output sizing', async () => {
    const sizes: number[] = [];
    const items = makeItems(10);
    // One serialized item is ~30 chars; cap admits about three.
    const cap = buildPrompt(items.slice(0, 3)).systemPrompt.length
      + buildPrompt(items.slice(0, 3)).userPrompt.length;

    await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: makeCall(1000, sizes),
      parse: parseIds,
      maxPromptChars: cap,
    });

    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
  });

  it('sends a single oversized item alone rather than starving it', async () => {
    const sizes: number[] = [];
    const items = [{ id: 'big', text: 'x'.repeat(5000) }];
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: makeCall(1000, sizes),
      parse: parseIds,
      maxPromptChars: 100,
    });

    expect(sizes).toEqual([1]);
    expect(out.results.flatMap((r) => r.ids)).toEqual(['big']);
  });

  it('builds the prompt once per batch when the whole batch fits', async () => {
    const builds: number[] = [];
    const countingBuild = (batch: Item[]) => {
      builds.push(batch.length);
      return buildPrompt(batch);
    };

    await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items: makeItems(20),
      buildPrompt: countingBuild,
      call: makeCall(1000, []),
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });

    // Two full batches, no trimming, no splitting — buildPrompt must not be
    // called speculatively. It is expensive for real callers (heal runs a
    // keyword search and a repository read inside it).
    expect(builds).toEqual([DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE]);
  });

  it('binary-searches the trim instead of dropping one item at a time', async () => {
    // A declared ceiling sizes the first batch up to all 64 items, and the char
    // cap admits only 3 — the widest possible gap for the trim to close.
    const items = makeItems(64);
    const cap = buildPrompt(items.slice(0, 3)).systemPrompt.length
      + buildPrompt(items.slice(0, 3)).userPrompt.length;

    const log: Array<{ kind: 'build' | 'call'; size: number }> = [];
    const countingBuild = (batch: Item[]) => {
      log.push({ kind: 'build', size: batch.length });
      return buildPrompt(batch);
    };
    const sizes: number[] = [];

    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt: countingBuild,
      call: async (prompts) => {
        const sent = JSON.parse(prompts.userPrompt) as Item[];
        log.push({ kind: 'call', size: sent.length });
        return makeCall(1000, sizes)(prompts);
      },
      parse: parseIds,
      maxOutputTokens: 100_000,
      maxPromptChars: cap,
    });

    // Same answer the one-at-a-time walk gave: the longest prefix that fits.
    expect(Math.max(...sizes)).toBe(3);
    expect(out.skipped).toEqual([]);
    expect(out.results.flatMap((r) => r.ids).sort()).toEqual(items.map((i) => i.id).sort());

    // Builds spent trimming the first batch, before anything was sent. Dropping
    // one item at a time would have cost 62 (64 down to 3); log2(64) + 1 is 7.
    const buildsBeforeFirstCall = log.findIndex((e) => e.kind === 'call');
    expect(buildsBeforeFirstCall).toBeLessThanOrEqual(8);
  });
});

describe('runBatched — splitting', () => {
  it('splits down to a working size and loses no items', async () => {
    const sizes: number[] = [];
    const items = makeItems(10);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: makeCall(3, sizes),   // fails above 3
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });

    expect(out.skipped).toEqual([]);
    expect(out.results.flatMap((r) => r.ids).sort()).toEqual(items.map((i) => i.id).sort());
    expect(sizes[0]).toBe(DEFAULT_BATCH_SIZE);
    expect(Math.max(...sizes.filter((_, i) => i > 0))).toBeLessThanOrEqual(5);
  });

  it('treats a parse failure exactly like a truncated call', async () => {
    const items = makeItems(4);
    const call = async (prompts: { systemPrompt: string; userPrompt: string }) => {
      const batch = JSON.parse(prompts.userPrompt) as Item[];
      // Above 2, return JSON that got cut mid-object.
      return batch.length > 2 ? '{"ids": ["i0",' : JSON.stringify({ ids: batch.map((b) => b.id) });
    };
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call,
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });

    expect(out.skipped).toEqual([]);
    expect(out.results.flatMap((r) => r.ids).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('skips a single unsplittable item instead of throwing, and finishes the pass', async () => {
    const items = makeItems(4);
    const onSkip = vi.fn();
    const call = async (prompts: { systemPrompt: string; userPrompt: string }) => {
      const batch = JSON.parse(prompts.userPrompt) as Item[];
      if (batch.some((b) => b.id === 'i2')) {
        throw new Error('Model response truncated at the 8192-token limit');
      }
      return JSON.stringify({ ids: batch.map((b) => b.id) });
    };

    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call,
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
      onSkip,
    });

    expect(out.skipped.map((i) => i.id)).toEqual(['i2']);
    expect(out.results.flatMap((r) => r.ids).sort()).toEqual(['i0', 'i1', 'i3']);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'i2' }),
      expect.any(Error),
    );
  });

  it('propagates a non-truncation call error instead of skipping the corpus', async () => {
    const items = makeItems(10);
    const call = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNRESET'));

    await expect(
      runBatched<Item, { batch: Item[]; ids: string[] }>({
        items,
        buildPrompt,
        call,
        parse: parseIds,
        maxPromptChars: NO_CHAR_CAP,
      }),
    ).rejects.toThrow('ECONNRESET');

    expect(call).toHaveBeenCalledTimes(1);
  });

  it('sticky adaptation does not re-climb within a run', async () => {
    const sizes: number[] = [];
    const items = makeItems(30);
    await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: makeCall(3, sizes),
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });

    // Once the run has discovered that 10 and 5 fail, no later attempt may be
    // made at those sizes again.
    const firstSuccessIndex = sizes.findIndex((s) => s <= 3);
    expect(firstSuccessIndex).toBeGreaterThan(0);
    expect(Math.max(...sizes.slice(firstSuccessIndex))).toBeLessThanOrEqual(3);
  });
});
