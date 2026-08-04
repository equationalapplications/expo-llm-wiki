/**
 * Bounded LLM calls.
 *
 * Maintenance passes build prompts whose *response* size grows with corpus
 * size. Past a threshold the call fails permanently: every retry re-sends the
 * same oversized request, so there is no partial progress and no self-recovery.
 * Raising the host's token budget only postpones this — providers enforce a
 * hard output ceiling, and core cannot see it (`LLMProvider.generateText`
 * returns a bare string).
 *
 * `runBatched` owns batch sizing, failure detection, halve-and-retry splitting
 * and the skip decision. It knows nothing about facts, heal, or ontology — the
 * caller supplies the domain callbacks — so it is testable against a fake
 * `call` with no LLM and no database.
 */

/**
 * Batch size when the provider declares no ceiling.
 *
 * Deliberately below ONTOLOGY_BACKFILL_BATCH_SIZE (25), a size already
 * observed to fail at a 9999-token ceiling. The absence of a hint must never
 * size *up*: starting large would make the split path do all the work, burning
 * API time and tokens on first attempts guaranteed to fail.
 */
export const DEFAULT_BATCH_SIZE = 10;

/** Crude per-item output estimate. Its only job is to make the common case one
 * call rather than three; it is never trusted — the split path is always armed. */
const ESTIMATED_OUTPUT_TOKENS_PER_ITEM = 150;

/** Headroom against the declared ceiling for preamble, JSON syntax, and the
 * estimate simply being wrong. */
const OUTPUT_BUDGET_FRACTION = 0.8;

const TRUNCATION_PATTERNS: RegExp[] = [
  /truncat/i,
  /token limit/i,
  /max(imum)?[ _-]?tokens?/i,
  /output limit/i,
  /length limit/i,
  /finish[_ ]?reason/i,
];

/**
 * Whether a thrown error looks like the provider cut the response short.
 *
 * Core only sees a string or an Error, so this is string matching by
 * necessity. A false positive costs one wasted split; a false negative
 * propagates the error, which is the right outcome for a network or auth
 * failure that must not be silently absorbed into a pile of skipped items.
 */
export function isTruncationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return TRUNCATION_PATTERNS.some((pattern) => pattern.test(message));
}

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface RunBatchedArgs<TItem, TResult> {
  items: TItem[];
  /** May be async: heal selects anchors per batch via a search + repository read. */
  buildPrompt: (batch: TItem[]) => BuiltPrompt | Promise<BuiltPrompt>;
  call: (prompts: BuiltPrompt) => Promise<string>;
  /** Receives the batch so the caller can pair a response with the exact items
   * that produced it without this module knowing any domain shape. Throwing is
   * the signal that the response was unusable. */
  parse: (responseText: string, batch: TItem[]) => TResult;
  /** Provider output ceiling, when the host declares one. Sizing hint only. */
  maxOutputTokens?: number;
  /** Input bound, applied independently of output sizing. */
  maxPromptChars: number;
  /** Called once per skipped item, for operator-legible logging. */
  onSkip?: (item: TItem, err: unknown) => void;
}

export interface RunBatchedOutcome<TItem, TResult> {
  results: TResult[];
  /** Items that failed even alone. Returned, never thrown. */
  skipped: TItem[];
  /** Number of `call` attempts made, including failed ones. */
  batches: number;
}

export function initialBatchSize(maxOutputTokens?: number): number {
  if (!maxOutputTokens || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return DEFAULT_BATCH_SIZE;
  }
  const estimate = Math.floor(
    (maxOutputTokens * OUTPUT_BUDGET_FRACTION) / ESTIMATED_OUTPUT_TOKENS_PER_ITEM,
  );
  // Only ever sizes up. Sizing down from a declared ceiling is left to the
  // split path, which measures reality instead of guessing.
  return Math.max(DEFAULT_BATCH_SIZE, estimate);
}

const promptLength = (prompts: BuiltPrompt): number =>
  prompts.systemPrompt.length + prompts.userPrompt.length;

export async function runBatched<TItem, TResult>(
  args: RunBatchedArgs<TItem, TResult>,
): Promise<RunBatchedOutcome<TItem, TResult>> {
  const { items, buildPrompt, call, parse, maxPromptChars, maxOutputTokens, onSkip } = args;

  const results: TResult[] = [];
  const skipped: TItem[] = [];
  let batches = 0;

  /**
   * Sticky downward adaptation. Ratchets down on failure and never climbs back
   * up within a run: without it, a 1177-fact backlog rediscovers the same
   * ceiling on every batch. Deliberately *not* touched by maxPromptChars
   * trimming — one dense batch should not shrink every later batch.
   */
  let batchSize = initialBatchSize(maxOutputTokens);

  /** Drop trailing items until the built prompt fits. A single item that
   * exceeds the cap alone is still sent: deferring it would starve it forever. */
  const trim = async (candidate: TItem[]): Promise<{ batch: TItem[]; prompts: BuiltPrompt }> => {
    let batch = candidate;
    let prompts = await buildPrompt(batch);
    while (batch.length > 1 && promptLength(prompts) > maxPromptChars) {
      batch = batch.slice(0, batch.length - 1);
      prompts = await buildPrompt(batch);
    }
    return { batch, prompts };
  };

  const onFailure = async (batch: TItem[], err: unknown): Promise<void> => {
    if (batch.length <= 1) {
      if (batch.length === 1) {
        skipped.push(batch[0]);
        onSkip?.(batch[0], err);
      }
      return;
    }
    const mid = Math.ceil(batch.length / 2);
    if (mid < batchSize) batchSize = mid;
    // Re-reads batchSize on every chunk rather than fixing it once: a nested
    // failure inside the first chunk can shrink batchSize further, and a later
    // chunk of this same batch must honor that smaller size too, not the size
    // this batch was split at before the shrink was discovered.
    let i = 0;
    while (i < batch.length) {
      const size = Math.min(batchSize, batch.length - i);
      await attempt(batch.slice(i, i + size));
      i += size;
    }
  };

  const attempt = async (batch: TItem[], prebuilt?: BuiltPrompt): Promise<void> => {
    if (batch.length === 0) return;
    const prompts = prebuilt ?? (await buildPrompt(batch));

    batches++;
    let responseText: string;
    try {
      responseText = await call(prompts);
    } catch (err) {
      // Only truncation-shaped failures are retryable by splitting. Anything
      // else (network, auth) is a real error and must surface.
      if (!isTruncationError(err)) throw err;
      await onFailure(batch, err);
      return;
    }

    let result: TResult;
    try {
      result = parse(responseText, batch);
    } catch (err) {
      // A response truncated mid-JSON surfaces here rather than as a thrown
      // call error, depending on where the cut landed in the grammar.
      await onFailure(batch, err);
      return;
    }

    results.push(result);
  };

  let index = 0;
  while (index < items.length) {
    const { batch, prompts } = await trim(items.slice(index, index + batchSize));
    index += batch.length;
    await attempt(batch, prompts);
  }

  return { results, skipped, batches };
}
