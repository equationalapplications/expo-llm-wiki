import type { WikiConfig } from '../types';
import type { ContextBudget } from '../utils/contextBudget';
import {
  OPS_RESOLVE_MAX_PROMPT_CHARS,
  HEAL_MAX_PROMPT_CHARS,
  OPS_MAX_EXTRACT_CHARS,
} from '../utils/contextCaps';
import { DEFAULT_MAX_CHUNK_LENGTH } from '../utils/chunkingDefaults';

/**
 * Context-budget resolver (specs/context-budget Proposed change 1, 4; owner
 * rulings R1–R3). Pure function of `WikiConfig`: resolves how the host's
 * declared context window maps onto the per-op prompt caps. Legacy hosts
 * (no `context` section, or `context.budget: 'legacy'`) keep today's caps
 * byte-identical — the T1 pins guard that.
 */

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_SAFETY_FRACTION = 0.9;
const DEFAULT_OUTPUT_RESERVE_TOKENS = 4000;

/** Today's caps as one-batch minimums, so a derived value never lands at zero or negative. */
const OP_FLOOR = {
  resolve: OPS_RESOLVE_MAX_PROMPT_CHARS,
  heal: HEAL_MAX_PROMPT_CHARS,
  extract: OPS_MAX_EXTRACT_CHARS,
} as const;

export type ContextBudgetOp = 'resolve' | 'heal' | 'extract';

function bad(key: string, value: unknown, why: string): Error {
  return new Error(`[core-llm-wiki] config.context.${key} must be ${why}; received ${JSON.stringify(value)}`);
}

export function resolveContextBudget(config: WikiConfig | undefined): ContextBudget {
  const context = config?.context;
  if (!context || context.budget === undefined) {
    return { mode: 'legacy', charsPerToken: DEFAULT_CHARS_PER_TOKEN, safetyFraction: DEFAULT_SAFETY_FRACTION, outputReserveTokens: DEFAULT_OUTPUT_RESERVE_TOKENS };
  }
  if (context.budget !== 'legacy' && context.budget !== 'declared') {
    throw bad('budget', context.budget, "'legacy' or 'declared'");
  }
  if (context.budget === 'legacy') {
    return { mode: 'legacy', charsPerToken: DEFAULT_CHARS_PER_TOKEN, safetyFraction: DEFAULT_SAFETY_FRACTION, outputReserveTokens: DEFAULT_OUTPUT_RESERVE_TOKENS };
  }

  // 'declared': validation first; a bad value throws, never falls back to legacy.
  const window = context.contextWindowTokens;
  if (window === undefined || typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    throw bad('contextWindowTokens', window, 'a finite number > 0 under budget: declared');
  }
  const charsPerToken = context.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  if (typeof charsPerToken !== 'number' || !Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw bad('charsPerToken', context.charsPerToken, 'a finite number > 0');
  }
  const safetyFraction = context.safetyFraction ?? DEFAULT_SAFETY_FRACTION;
  if (typeof safetyFraction !== 'number' || !Number.isFinite(safetyFraction) || safetyFraction <= 0 || safetyFraction > 1) {
    throw bad('safetyFraction', context.safetyFraction, 'a finite number in (0, 1]');
  }
  // Validate the *effective* reserve: a small window with no reserve would
  // otherwise derive a negative prompt cap behind the floor.
  const outputReserveTokens = context.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  if (
    typeof outputReserveTokens !== 'number' ||
    !Number.isFinite(outputReserveTokens) ||
    outputReserveTokens < 0 ||
    outputReserveTokens >= window
  ) {
    throw bad('outputReserveTokens', context.outputReserveTokens, `a finite number >= 0 and < contextWindowTokens (${window})`);
  }

  return { mode: 'declared', contextWindowTokens: window, charsPerToken, safetyFraction, outputReserveTokens };
}

/**
 * Declared-mode derived prompt cap for resolve and heal:
 * `floor((window - reserve) * safetyFraction * charsPerToken)`, floored at
 * today's cap. Extract scales by today's 24/40 ratio (controller decree,
 * 2026-11-21) so the event-summary batch cannot consume the whole window.
 */
function declaredPromptCap(budget: ContextBudget, op: Exclude<ContextBudgetOp, 'extract'>): number {
  const derived = Math.floor(
    ((budget.contextWindowTokens as number) - budget.outputReserveTokens) *
      budget.safetyFraction *
      budget.charsPerToken,
  );
  if (op === 'resolve') return Math.max(OP_FLOOR.resolve, derived);
  return Math.max(OP_FLOOR.heal, derived);
}

export function resolveMaxPromptChars(budget: ContextBudget, op: ContextBudgetOp): number {
  if (budget.mode !== 'declared') {
    return op === 'resolve' ? OP_FLOOR.resolve : op === 'heal' ? OP_FLOOR.heal : OP_FLOOR.extract;
  }
  if (op === 'extract') {
    const resolveDerived = declaredPromptCap(budget, 'resolve');
    const extractDerived = Math.floor((resolveDerived * OPS_MAX_EXTRACT_CHARS) / OPS_RESOLVE_MAX_PROMPT_CHARS);
    return Math.max(OP_FLOOR.extract, extractDerived);
  }
  return declaredPromptCap(budget, op);
}

/** The ingest chunk default stays 12000 in both modes (ruling R2). */
export function resolveDefaultChunkLength(budget: ContextBudget): number {
  void budget;
  return DEFAULT_MAX_CHUNK_LENGTH;
}
