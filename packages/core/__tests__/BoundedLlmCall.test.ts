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

  it('does not match a requested max-tokens config error, which splitting cannot fix', () => {
    expect(
      isTruncationError(new Error('The maximum tokens you requested exceeds the model limit of 4096')),
    ).toBe(false);
    expect(isTruncationError(new Error('Requested max_tokens exceeds the model context limit'))).toBe(false);
  });

  // Regression: issue #96. The internal classifier's `err instanceof
  // Error` check invokes the getPrototypeOf trap on err. A hostile trap
  // would throw out of runBatched. On a hostile trap, isTruncationError
  // falls back to `false` — at most one wasted batch split, which is the
  // correct trade-off.
  it('returns false on a Proxy whose getPrototypeOf trap rejects', () => {
    const hostileProxy = new Proxy({}, {
      getPrototypeOf() { throw new Error('proxy rejects prototype access'); },
    });
    expect(() => isTruncationError(hostileProxy)).not.toThrow();
    expect(isTruncationError(hostileProxy)).toBe(false);
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

  it('applies maxPromptChars to split sub-batches too, not just the first attempt', async () => {
    // Heal's buildPrompt is not monotonic in batch size: it re-selects up to
    // HEAL_MAX_ANCHORS contradiction anchors per batch, so a sub-batch can
    // match anchors the parent batch did not and produce a *longer* prompt from
    // fewer items. Modelled here by an anchor block that grows as the batch
    // shrinks. A subset of a trimmed batch is therefore not automatically
    // within the cap, and the split path has to trim as well.
    const anchorsFor = (batch: Item[]) => 'A'.repeat(Math.max(0, 12 - batch.length) * 40);
    const expandingBuild = (batch: Item[]) => ({
      systemPrompt: 'SYS' + anchorsFor(batch),
      userPrompt: JSON.stringify(batch),
    });

    const cap = 400;
    const sent: Array<{ size: number; chars: number }> = [];
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items: makeItems(10),
      buildPrompt: expandingBuild,
      // Always truncation-fails above 2, forcing the split path to run.
      call: async (prompts) => {
        const batch = JSON.parse(prompts.userPrompt) as Item[];
        sent.push({
          size: batch.length,
          chars: prompts.systemPrompt.length + prompts.userPrompt.length,
        });
        return makeCall(2, [])(prompts);
      },
      parse: parseIds,
      maxPromptChars: cap,
    });

    // The invariant the module documents: nothing over the cap is ever sent,
    // except a single item that exceeds it alone. Under this non-monotonic
    // buildPrompt the 1-item prompts are the *longest*, so they are the
    // exception and multi-item batches are what the bound has to catch.
    expect(sent.some((s) => s.size > 1)).toBe(true);
    expect(sent.filter((s) => s.size > 1 && s.chars > cap)).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.results.flatMap((r) => r.ids).sort()).toEqual(makeItems(10).map((i) => i.id).sort());
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

    expect(out.skipped.map(({ item }) => item.id)).toEqual(['i2']);
    expect(out.skipped.every((s) => s.reason === 'non_convergent')).toBe(true);
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

// ---------------------------------------------------------------------------
// attemptLevel ladder (issue #101).
//
// Each case builds its own `buildPrompt` and `call` so the failure schedule
// stays adjacent to the assertion that locks it in. A shared helper that
// recorded the level centrally looked attractive while the ladder was being
// shaped; once the cases diverged (some test L0 prompts, some test L1,
// etc.) the helper stopped carrying its weight, and `runBatched` invokes
// `call(prompts)` with a single argument, so any helper that claimed to
// read a "level" parameter would silently never see one. Keeping helpers
// next to their consumer avoids that future-author trap.
// ---------------------------------------------------------------------------

describe('attempt level ladder', () => {
  it('L0 success: no escalation', async () => {
    const items = makeItems(3);
    const trace: Array<{ level: number; batchSize: number }> = [];
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt: (batch, level = 0) => {
        trace.push({ level, batchSize: batch.length });
        return buildPrompt(batch);
      },
      call: async (prompts) => {
        const batch = JSON.parse(prompts.userPrompt) as Item[];
        trace.push({ level: 0, batchSize: batch.length });
        return JSON.stringify({ ids: batch.map((b) => b.id) });
      },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([]);
    expect(out.batches).toBe(1);
    expect(trace.filter((t) => t.level === 0)).toHaveLength(2);
  });

  it('L0 truncates, L1 success: 2 calls, fresh L1 build', async () => {
    const items = makeItems(1); // batch.length === 1 from the start
    const trace: Array<{ level: number; batchSize: number }> = [];
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt: (batch, level = 0) => {
        trace.push({ level, batchSize: batch.length });
        return { systemPrompt: 'SYS', userPrompt: JSON.stringify(batch) };
      },
      call: async (prompts) => {
        const batch = JSON.parse(prompts.userPrompt) as Item[];
        const last = trace[trace.length - 1];
        if (last.level === 0) throw new Error('Model response truncated at the 8192-token limit');
        return JSON.stringify({ ids: batch.map((b) => b.id) });
      },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([]);
    expect(out.batches).toBe(2);
    expect(trace.find((t) => t.level === 1)).toBeTruthy();
  });

  it('L0 truncates, L1 truncates, L2 success: 3 calls', async () => {
    const items = makeItems(1);
    const trace: Array<{ level: number; batchSize: number }> = [];
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt: (batch, level = 0) => {
        trace.push({ level, batchSize: batch.length });
        return { systemPrompt: 'SYS', userPrompt: JSON.stringify(batch) };
      },
      call: async (prompts) => {
        const last = trace[trace.length - 1];
        if (last.level < 2) throw new Error('Model response truncated at the 8192-token limit');
        return JSON.stringify({ ids: JSON.parse(prompts.userPrompt).map((b: Item) => b.id) });
      },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([]);
    expect(out.batches).toBe(3);
  });

  it('L0–L2 truncate, L3 success: 4 calls, L3 attempt bypasses trim', async () => {
    const items = makeItems(1);
    const trace: Array<{ level: number; batchSize: number }> = [];
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt: (batch, level = 0) => {
        trace.push({ level, batchSize: batch.length });
        return { systemPrompt: 'SYS', userPrompt: JSON.stringify(batch) };
      },
      call: async (prompts) => {
        const last = trace[trace.length - 1];
        if (last.level < 3) throw new Error('Model response truncated at the 8192-token limit');
        return JSON.stringify({ ids: JSON.parse(prompts.userPrompt).map((b: Item) => b.id) });
      },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([]);
    expect(out.batches).toBe(4);
    expect(trace.filter((t) => t.level === 3)).toHaveLength(1);
  });

  it('L0–L3 all truncate: skipped with reason non_convergent, no further escalation', async () => {
    const items = makeItems(1);
    const trace: Array<{ level: number; batchSize: number }> = [];
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt: (batch, level = 0) => {
        trace.push({ level, batchSize: batch.length });
        return { systemPrompt: 'SYS', userPrompt: JSON.stringify(batch) };
      },
      call: async () => {
        throw new Error('Model response truncated at the 8192-token limit');
      },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([{ item: items[0], reason: 'non_convergent' }]);
    expect(out.batches).toBe(4); // L0, L1, L2, L3 — never a 5th
    expect(trace.filter((t) => t.level === 3)).toHaveLength(1);
  });

  it('parse error at L0, batch.length === 1: skipped, no level advance', async () => {
    const items = makeItems(1);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: async () => '{not valid json', // parse throws
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([{ item: items[0], reason: 'non_convergent' }]);
    expect(out.batches).toBe(1);
  });

  it('EXCEEDS_LIMIT error at L0, batch.length === 1: skipped, no level advance', async () => {
    const items = makeItems(1);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: async () => { throw new Error('The maximum tokens you requested exceeds the model limit of 4096'); },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([{ item: items[0], reason: 'non_convergent' }]);
    expect(out.batches).toBe(1);
  });

  it('network error at L0, batch.length === 1: skipped with reason call_error, no level advance', async () => {
    const items = makeItems(1);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: async () => { throw new Error('fetch failed: ECONNRESET'); },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([{ item: items[0], reason: 'call_error' }]);
    expect(out.batches).toBe(1);
  });

  it('parse error at batch.length > 1: still splits (pre-existing #67 behavior, regression-locked)', async () => {
    const items = makeItems(4);
    const sizes: number[] = [];
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt: (batch) => {
        return { systemPrompt: 'SYS', userPrompt: JSON.stringify(batch) };
      },
      call: async (prompts) => {
        const batch = JSON.parse(prompts.userPrompt) as Item[];
        sizes.push(batch.length);
        return batch.length > 2 ? '{not valid json' : JSON.stringify({ ids: batch.map((b) => b.id) });
      },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    // Call sequence: 4 (parse fails, batch.length>2 → invalid JSON) → split →
    // 2 (parses) + 2 (parses). sizes records [4, 2, 2]; sorted is [2, 2, 4].
    expect(out.skipped).toEqual([]);
    expect(out.results.flatMap((r) => r.ids).sort()).toEqual(['i0', 'i1', 'i2', 'i3']);
    expect(sizes.sort()).toEqual([2, 2, 4]);
  });
});

// ---------------------------------------------------------------------------
// `call_error` subreason (ladder spec Revision 1).
//
// Discriminates transient provider failures at `batch.length === 1` from
// terminal give-up at L3 and from model-config errors. Lets orchestration
// callers (doRunHeal, doRunOntologyBackfill) omit the fact from the cooldown
// stamp so a momentary 5xx / network blip doesn't lock it out for a week.
// ---------------------------------------------------------------------------

describe('call_error subreason', () => {
  it('singleton batch, non-truncation call error: reason "call_error"', async () => {
    const items = makeItems(1);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: async () => { throw new Error('Bedrock request failed: 502 Bad Gateway'); },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([{ item: items[0], reason: 'call_error' }]);
    expect(out.batches).toBe(1);
  });

  it('singleton batch, EXCEEDS_LIMIT (model-config) error: stays "non_convergent"', async () => {
    // Regression lock: model-config errors retry identically every pass, so
    // they must NOT be eligible for the next pass. They keep the cooldown
    // stamp.
    const items = makeItems(1);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: async () => { throw new Error('The maximum tokens you requested exceeds the model limit of 4096'); },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([{ item: items[0], reason: 'non_convergent' }]);
    expect(out.batches).toBe(1);
  });

  it('singleton batch, parse error at L0: "non_convergent", not "call_error"', async () => {
    // Parse errors come from `parse()`, never from `call()` (fromCall=false),
    // so they don't qualify as transient call failures and stay terminal.
    const items = makeItems(1);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: async (prompts) => prompts.userPrompt, // pass through to parse
      parse: () => { throw new Error('JSON desync at offset 42'); },
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([{ item: items[0], reason: 'non_convergent' }]);
    expect(out.batches).toBe(1);
  });

  it('singleton batch, all four levels truncate: "non_convergent" (gave up at L3, not a transient call error)', async () => {
    const items = makeItems(1);
    const out = await runBatched<Item, { batch: Item[]; ids: string[] }>({
      items,
      buildPrompt,
      call: async () => { throw new Error('Model response truncated at the 16384-token limit'); },
      parse: parseIds,
      maxPromptChars: NO_CHAR_CAP,
    });
    expect(out.skipped).toEqual([{ item: items[0], reason: 'non_convergent' }]);
    expect(out.batches).toBe(4);
  });
});
