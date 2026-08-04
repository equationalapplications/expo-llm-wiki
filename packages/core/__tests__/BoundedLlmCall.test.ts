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
});
