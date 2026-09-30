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

/** One budget shared by every LLM call in a maintenance run. */
export class UsageMeter {
  readonly budget: number | undefined;
  used = 0;
  estimated = false;

  constructor(budget?: number) {
    if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0)) {
      throw new TypeError('tokenBudget must be a finite number >= 0');
    }
    this.budget = budget;
  }

  get remaining(): number {
    return this.budget === undefined ? Infinity : Math.max(0, this.budget - this.used);
  }

  fits(estimate: number): boolean {
    return estimate <= this.remaining;
  }

  record(r: UsageRecord): void {
    this.used += r.inputTokens + r.outputTokens;
    if (r.estimated) this.estimated = true;
  }
}

/**
 * Thrown by callLlm before calling the provider when the prompt estimate
 * exceeds the meter. Internal control flow: runBatched and the librarian
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
