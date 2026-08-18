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

// A "max tokens" match paired with "exceed(s)" is a request-configuration
// error (the caller asked for more than the model allows), not the provider
// cutting a response short. Splitting the batch cannot fix it — the adapter
// keeps requesting the same max tokens — so it must propagate instead of
// being absorbed into a pile of skipped items.
const EXCEEDS_LIMIT_PATTERN = /exceed[a-z]*[^.]{0,40}\b(model|context)?[ _-]?limit/i;

/**
 * Whether a thrown error looks like the provider cut the response short.
 *
 * Core only sees a string or an Error, so this is string matching by
 * necessity. A false positive costs one wasted split; a false negative
 * propagates the error, which is the right outcome for a network or auth
 * failure that must not be silently absorbed into a pile of skipped items.
 *
 * The contract is explicit: this function must never throw. The
 * `err instanceof Error` check below invokes the `getPrototypeOf` trap on
 * `err`. A hostile Proxy whose trap rejects would otherwise throw out of
 * `runBatched` — and any throw inside `runBatched` is the silent-batch-
 * failure mode this whole helper exists to prevent. On a hostile trap, we
 * fall back to `false` (treat as not a truncation error): the consequence
 * is at most one wasted batch split, which is the correct trade-off.
 */
export function isTruncationError(err: unknown): boolean {
  let message: string;
  try {
    message = err instanceof Error ? err.message : String(err ?? '');
  } catch {
    // hostile Proxy whose getPrototypeOf trap rejects — fall back to false
    return false;
  }
  if (EXCEEDS_LIMIT_PATTERN.test(message)) return false;
  return TRUNCATION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Whether a thrown error looks like a model-config error — the caller
 * requested more output than the model allows, and re-running it in the
 * next pass produces the same failure. Distinguished from transient
 * provider failures (`ECONNRESET`, auth blip, 5xx) so the cooldown-stamp
 * filter in `doRunHeal` / `doRunOntologyBackfill` does not exclude these
 * facts from eligibility: a model-config bug is the host's problem to
 * fix, and a fact that errored this way can recover only when the host
 * does, so the cooldown stamp is the right behavior.
 *
 * Same Proxy-safety contract as `isTruncationError`: hostile
 * `getPrototypeOf` trap must not propagate out of this function.
 */
export function isConfigError(err: unknown): boolean {
  let message: string;
  try {
    message = err instanceof Error ? err.message : String(err ?? '');
  } catch {
    return false;
  }
  return EXCEEDS_LIMIT_PATTERN.test(message);
}

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface RunBatchedArgs<TItem, TResult> {
  items: TItem[];
  /**
   * May be async: heal selects anchors per batch via a search + repository read.
   *
   * `attemptLevel` is the escalation level at which this build is being asked
   * to produce a prompt. trim()'s speculatives always pass `0` (they only
   * measure length). Real attempts pass the current escalation level: `0`
   * (normal), `1` (less shared context), `2` (less again), or `3` (last
   * resort — caller is expected to shrink or truncate the prompt itself).
   * Defaults to `0` so callers that don't care about the level are unchanged.
   */
  buildPrompt: (
    batch: TItem[],
    attemptLevel?: 0 | 1 | 2 | 3,
  ) => BuiltPrompt | Promise<BuiltPrompt>;
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
  /**
   * Items that could not converge after the helper's full escalation path.
   * The discriminator separates genuine non-convergence (`'non_convergent'`
   * — terminal give-up at L3, parse error, or a model-config error) from
   * transient provider failures (`'call_error'` — non-truncation error
   * originating in `call()` at `batch.length === 1`). Callers that stamp a
   * cooldown on skipped facts (e.g. `doRunHeal`) must filter out the
   * `'call_error'` ids so a momentary 5xx doesn't lock the fact out for a
   * week.
   */
  skipped: Array<{ item: TItem; reason: 'non_convergent' | 'call_error' }>;
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
  const skipped: Array<{ item: TItem; reason: 'non_convergent' | 'call_error' }> = [];
  let batches = 0;

  /**
   * Sticky downward adaptation. Ratchets down on failure and never climbs back
   * up within a run: without it, a 1177-fact backlog rediscovers the same
   * ceiling on every batch. Deliberately *not* touched by maxPromptChars
   * trimming — one dense batch should not shrink every later batch.
   */
  let batchSize = initialBatchSize(maxOutputTokens);

  /**
   * Longest prefix of `candidate` whose built prompt fits `maxPromptChars`. A
   * single item that exceeds the cap alone is still sent: deferring it would
   * starve it forever.
   *
   * `buildPrompt` is not assumed cheap — heal runs a keyword search and a
   * repository read on every call — so the overflow path binary-searches the
   * prefix length instead of dropping one item at a time. The whole batch is
   * tried first, which keeps the common case (it fits) at exactly one call and
   * bounds the overflow case at ~log2(n) + 1 instead of n.
   *
   * Prompt length is treated as non-decreasing in prefix length. That is the
   * same assumption the one-at-a-time walk made by stopping at the first fit;
   * if it is ever violated the result is a slightly different batch size, never
   * a lost item, and the split path stays armed either way.
   */
  const trim = async (candidate: TItem[]): Promise<{ batch: TItem[]; prompts: BuiltPrompt }> => {
    const whole = await buildPrompt(candidate);
    if (candidate.length <= 1 || promptLength(whole) <= maxPromptChars) {
      return { batch: candidate, prompts: whole };
    }

    let low = 2;
    let high = candidate.length - 1; // the full length is known not to fit
    let best: TItem[] | undefined;
    let bestPrompts: BuiltPrompt | undefined;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const batch = candidate.slice(0, mid);
      const prompts = await buildPrompt(batch);
      if (promptLength(prompts) <= maxPromptChars) {
        best = batch;
        bestPrompts = prompts;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (best && bestPrompts) return { batch: best, prompts: bestPrompts };

    const single = candidate.slice(0, 1);
    return { batch: single, prompts: await buildPrompt(single) };
  };

  const onFailure = async (
    batch: TItem[],
    err: unknown,
    attemptLevel: 0 | 1 | 2 | 3,
    fromCall: boolean,
  ): Promise<void> => {
    if (batch.length === 1) {
      // Gate: escalation only on a truncation-shaped error at the lowest batch
      // size, and only while the ladder has levels left. Anything else at this
      // point — parse error, exceeds-limit config error, or a non-truncation
      // call error — is a terminal give-up. A parse error is not retryable by
      // context-shedding (the JSON desync shape is the same at L1, L2, and L3);
      // escalating would burn three calls before reaching skip. The gate
      // prevents that.
      if (fromCall && isTruncationError(err) && attemptLevel < 3) {
        // Bypass trim: its prebuilt prompt is the L0 form, invalid at the new
        // level. attempt() will call buildPrompt(batch, attemptLevel + 1) to
        // produce the level-appropriate prompt.
        await attempt(batch, undefined, (attemptLevel + 1) as 0 | 1 | 2 | 3);
      } else {
        // Subreason: a non-truncation error originating in `call()` is a
        // transient provider failure (5xx, network reset, auth blip), not a
        // model capability failure or a model-config bug. Distinguishing it
        // lets orchestration callers (doRunHeal, doRunOntologyBackfill)
        // refuse to apply a recheck cooldown stamp to facts whose skip is
        // operationally reversible. EXCEEDS_LIMIT-shaped errors are
        // model-config bugs that retry identically every pass, so they stay
        // `'non_convergent'` and receive the cooldown stamp. See
        // docs/superpowers/specs/2026-08-17-...-design.md §"Revision 1 —
        // call_error subreason".
        const reason: 'non_convergent' | 'call_error' =
          fromCall && !isTruncationError(err) && !isConfigError(err) ? 'call_error' : 'non_convergent';
        skipped.push({ item: batch[0], reason });
        onSkip?.(batch[0], err);
      }
      return;
    }
    // Non-truncation call errors at batch.length > 1 are real errors (network,
    // auth) and must propagate rather than silently split/skip the corpus.
    // Parse errors always split — the JSON may parse after shedding context.
    if (fromCall && !isTruncationError(err)) throw err;
    // batch.length > 1: split path, unchanged. Sticky-down batchSize
    // adaptation and the inner trim/attempt loop at level 0 are preserved.
    const mid = Math.ceil(batch.length / 2);
    if (mid < batchSize) batchSize = mid;
    // Re-reads batchSize on every chunk rather than fixing it once: a nested
    // failure inside the first chunk can shrink batchSize further, and a later
    // chunk of this same batch must honor that smaller size too, not the size
    // this batch was split at before the shrink was discovered.
    //
    // Chunks go through `trim` rather than straight to `attempt`: a subset of a
    // trimmed batch is not automatically under maxPromptChars, because
    // buildPrompt is not required to be monotonic in batch size. Heal's is not
    // — it re-selects up to HEAL_MAX_ANCHORS anchors per batch, so a sub-batch
    // can match anchors the parent did not. Without this, the input bound held
    // only on first attempts.
    let i = 0;
    while (i < batch.length) {
      const size = Math.min(batchSize, batch.length - i);
      const trimmed = await trim(batch.slice(i, i + size));
      await attempt(trimmed.batch, trimmed.prompts);
      // trim always returns at least one item, so this advances.
      i += trimmed.batch.length;
    }
  };

  const attempt = async (
    batch: TItem[],
    prebuilt?: BuiltPrompt,
    attemptLevel: 0 | 1 | 2 | 3 = 0,
  ): Promise<void> => {
    if (batch.length === 0) return;
    // prebuilt is the L0 form from trim(); only valid at attemptLevel === 0.
    // The level-advance path in onFailure passes `undefined` to force a rebuild.
    const prompts =
      prebuilt && attemptLevel === 0
        ? prebuilt
        : (await buildPrompt(batch, attemptLevel));

    batches++;
    let responseText: string;
    try {
      responseText = await call(prompts);
    } catch (err) {
      // Non-truncation call errors: hand to onFailure (skips at batch.length===1,
      // throws at batch.length>1). Truncation errors also go to onFailure for
      // potential ladder escalation.
      await onFailure(batch, err, attemptLevel, true);
      return;
    }

    let result: TResult;
    try {
      result = parse(responseText, batch);
    } catch (err) {
      // A response truncated mid-JSON surfaces here rather than as a thrown
      // call error, depending on where the cut landed in the grammar.
      // Parse errors always split, never throw — the JSON may parse after
      // shedding context. The gate inside onFailure handles ladder escalation.
      await onFailure(batch, err, attemptLevel, false);
      return;
    }

    results.push(result);
  };

  let index = 0;
  while (index < items.length) {
    const { batch, prompts } = await trim(items.slice(index, index + batchSize));
    index += batch.length;
    await attempt(batch, prompts, 0);
  }

  return { results, skipped, batches };
}
