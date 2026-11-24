/**
 * Token accounting for BYOI providers (spec 2026-09-29 §6.3). Core ships no
 * tokenizer: every estimate is chars/4. Hosts wanting headroom pass a smaller
 * budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  /** True when either figure came from estimateTokens rather than the provider. */
  estimated: boolean;
}

/** Opaque handle for tokens held by one in-flight metered call. */
export interface UsageReservation {
  readonly _brand: 'UsageReservation';
}

interface OpenReservation extends UsageReservation {
  hold: number;
  open: boolean;
}

/**
 * One budget shared by every LLM call in a maintenance run (generateText and
 * classify). A call is admitted on its input estimate (`reserve`), holds
 * tokens against the budget while in flight so parallel calls cannot all
 * claim the same headroom, then `settle`s the real usage or `release`s on
 * failure (specs/meter-reservation). The budget stays an admission check on
 * the input estimate, not a hard ceiling on provider output.
 */
export class UsageMeter {
  readonly budget: number | undefined;
  used = 0;
  estimated = false;
  private heldTokens = 0;

  constructor(budget?: number) {
    if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0)) {
      throw new TypeError('tokenBudget must be a finite number >= 0');
    }
    this.budget = budget;
  }

  /** Tokens held by in-flight reservations. */
  get reserved(): number {
    return this.heldTokens;
  }

  /** budget - used - reserved, clamped at 0; Infinity when unbounded. */
  get remaining(): number {
    return this.budget === undefined ? Infinity : Math.max(0, this.budget - this.used - this.heldTokens);
  }

  fits(estimate: number): boolean {
    return estimate <= this.remaining;
  }

  record(r: UsageRecord): void {
    this.used += r.inputTokens + r.outputTokens;
    if (r.estimated) this.estimated = true;
  }

  /**
   * Admit a call on `estimate` (throws WikiBudgetExhausted when it does not
   * fit the unreserved remainder) and hold `max(estimate, hold)` tokens until
   * settle/release.
   */
  reserve(estimate: number, hold?: number): UsageReservation {
    if (!this.fits(estimate)) throw new WikiBudgetExhausted(estimate, this.remaining);
    const handle: OpenReservation = { _brand: 'UsageReservation', hold: Math.max(estimate, hold ?? estimate), open: true };
    this.heldTokens += handle.hold;
    return handle;
  }

  /** Free the hold, then charge the real usage. A closed handle is a no-op. */
  settle(handle: UsageReservation, actual: UsageRecord): void {
    if (!this.close(handle)) return;
    this.record(actual);
  }

  /** Free the hold and charge nothing. A closed handle is a no-op. */
  release(handle: UsageReservation): void {
    this.close(handle);
  }

  private close(handle: UsageReservation): boolean {
    const h = handle as OpenReservation;
    if (!h.open) return false;
    h.open = false;
    this.heldTokens -= h.hold;
    return true;
  }
}

/**
 * Thrown by UsageMeter.reserve (via callLlm/callClassify) before calling the
 * provider when the input estimate exceeds the unreserved remainder. Internal control flow: runBatched and the librarian
 * strategies catch it; it never reaches a host.
 */
export class WikiBudgetExhausted extends Error {
  readonly requiredEstimate: number;
  readonly remaining: number;

  constructor(requiredEstimate: number, remaining: number) {
    super(`LLM call needs ~${requiredEstimate} input tokens; ${remaining} remain in the budget.`);
    this.name = 'WikiBudgetExhausted';
    this.requiredEstimate = requiredEstimate;
    this.remaining = remaining;
    Object.setPrototypeOf(this, WikiBudgetExhausted.prototype);
  }
}
