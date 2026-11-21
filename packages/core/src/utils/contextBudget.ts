/**
 * Context-budget wrapper (specs/context-budget Proposed change 2).
 *
 * Core ships no tokenizer: every estimate is chars/`charsPerToken`. The
 * meter keeps plain `estimateTokens` (chars/4) this PR — metering is out of
 * scope — so `estimateTokensWith` under a legacy budget (`charsPerToken: 4`)
 * is byte-equal to `estimateTokens` for every input, and the wrapper ships
 * unused by metering.
 */
export interface ContextBudget {
  mode: 'legacy' | 'declared';
  /** Set iff mode === 'declared'. */
  contextWindowTokens?: number;
  /** 4 under legacy. */
  charsPerToken: number;
  /** 0.9 under legacy (unused in legacy math). */
  safetyFraction: number;
  /** 4000 under legacy (unused in legacy math). */
  outputReserveTokens: number;
}

export function estimateTokensWith(budget: ContextBudget, text: string): number {
  return Math.ceil(text.length / budget.charsPerToken);
}
