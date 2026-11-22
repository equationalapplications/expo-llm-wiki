import type { WikiConfig } from '../types';
import { resolveContextBudget } from '../config/context';
import type { ContextBudget } from './contextBudget';
import type { SystemOneConfig } from '../config/systemOne';

/**
 * The one place the 8.0.0 engine defaults are defined (specs/release-8-0-0).
 * Read sites resolve through these so a host that sets nothing gets the same
 * answer everywhere.
 */
export const DEFAULT_LIBRARIAN_STRATEGY = 'ops' as const;
export const DEFAULT_MAINTENANCE_MODE = 'deferred' as const;

export function resolveLibrarianStrategy(config: WikiConfig | undefined): 'legacy' | 'ops' {
  return config?.librarian?.strategy ?? DEFAULT_LIBRARIAN_STRATEGY;
}

export function resolveMaintenanceMode(config: WikiConfig | undefined): 'auto' | 'deferred' {
  return config?.maintenance ?? DEFAULT_MAINTENANCE_MODE;
}

/**
 * Fail-fast context-budget resolution (specs/context-budget T4): called in the
 * WikiMemory construction path so an invalid `config.context` section throws
 * at construction, never mid-pass. Never falls back to legacy on a bad value.
 */
export function resolveContextBudgetOrThrow(config: WikiConfig | undefined): ContextBudget {
  return resolveContextBudget(config);
}

/**
 * Settings a 7.x host could have set that the 8.0.0 defaults silently ignore:
 * the auto-run thresholds do nothing under `deferred`, and a whole-prompt
 * librarian override key that 9.0.0 removed is now ignored. Names each
 * mismatch so an upgrade doesn't quietly lose maintenance or a custom prompt.
 */
export function changedDefaultWarnings(config: WikiConfig | undefined): string[] {
  const warnings: string[] = [];
  const hasThreshold = config?.autoLibrarianThreshold !== undefined
    || config?.autoHealThreshold !== undefined
    || config?.autoLibrarianTokenThreshold !== undefined;
  if (hasThreshold && config?.maintenance === undefined) {
    warnings.push(
      "[core-llm-wiki] auto-run thresholds are set, but `maintenance` now defaults to 'deferred', so write() will not "
      + "start the librarian or heal. Set `maintenance: 'auto'` or call runPendingMaintenance().",
    );
  }
  // Deliberately untyped read: the key left the type surface, so TS hosts get the
  // intended compile error; only untyped JS hosts can reach this notice.
  if ((config?.prompts as Record<string, unknown> | undefined)?.librarianSystemPrompt !== undefined) {
    warnings.push(
      "[core-llm-wiki] `prompts.librarianSystemPrompt` was removed in 9.0.0 and its value is ignored. "
      + "Move the domain part of it to `prompts.guidance`, which works under both librarian strategies.",
    );
  }
  if (config?.librarian?.strategy === 'legacy' && config?.maintenance === undefined && !hasThreshold) {
    warnings.push(
      "[core-llm-wiki] `librarian.strategy` is pinned to 'legacy', but `maintenance` now defaults to 'deferred', "
      + "so write() will not start the librarian or heal, and a deferred backlog run keeps only the newest 50 "
      + "events. Set `maintenance: 'auto'` to keep 7.x auto-run behavior.",
    );
  }
  return warnings;
}

const warnedDefaults = new Set<string>();

/**
 * Logs each distinct {@link changedDefaultWarnings} message at most once per
 * process (specs/upgrade-warning-7-18 §2.3: hosts build one WikiMemory per
 * entity, per request, or per test, and must not spam stderr per construction).
 */
export function warnChangedDefaultsOnce(config: WikiConfig | undefined): void {
  for (const message of changedDefaultWarnings(config)) {
    if (warnedDefaults.has(message)) continue;
    warnedDefaults.add(message);
    console.warn(message);
  }
}

/**
 * Logs each distinct message at most once per process, sharing the
 * {@link warnedDefaults} set with `warnChangedDefaultsOnce`. System-One
 * resolvers use this for invalid config values (treated as unset) and
 * both-keys-disagree notices (specs/system-one-config §2-§3). Messages carry
 * a distinct `[core-llm-wiki] systemOne:` prefix, so a malformed message can
 * never suppress a defaults-changed warning (plan Risks).
 */
export function warnOnce(message: string): void {
  if (warnedDefaults.has(message)) return;
  warnedDefaults.add(message);
  console.warn(message);
}

/**
 * Formats an invalid config value for a warning message without throwing.
 * A raw `JSON.stringify` throws on `bigint` (e.g. `systemOne.typing: 1n`)
 * and on circular references — config arriving from an unvalidated host
 * store can hold either, and a config warning must never become an
 * exception. Falls back to a type-named placeholder.
 */
export function formatConfigValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return `[unserializable: ${typeof value}]`;
  }
}

const isTypingMode = (v: unknown): v is 'auto' | 'llm' => v === 'auto' || v === 'llm';
const isConfidenceFloor = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Typing-mode resolution chain (specs/system-one-config §2):
 * call option `classifier` → `systemOne.typing` →
 * `ontology.backfillClassifier` → `'llm'`. The caller validates the call
 * option (a TypeError at the pass boundary); config values validate here.
 * `??` throughout — falsy config values never participate by accident.
 */
export function resolveSystemOneTyping(
  config: WikiConfig | undefined,
  classifierCallOption?: 'auto' | 'llm',
): 'auto' | 'llm' {
  const systemOne: SystemOneConfig | undefined = config?.systemOne;
  const legacy = config?.ontology?.backfillClassifier;
  const systemOneValid = isTypingMode(systemOne?.typing);
  const legacyValid = isTypingMode(legacy);
  if (systemOne?.typing !== undefined && !systemOneValid) {
    warnOnce(
      `[core-llm-wiki] systemOne: \`systemOne.typing\` is ${formatConfigValue(systemOne.typing)}, which is not `
      + "'auto' or 'llm'. The key is treated as unset; the default ('llm') applies.",
    );
  }
  if (legacy !== undefined && !legacyValid) {
    warnOnce(
      `[core-llm-wiki] systemOne: \`ontology.backfillClassifier\` is ${formatConfigValue(legacy)}, which is not `
      + "'auto' or 'llm'. The key is treated as unset; the default ('llm') applies.",
    );
  }
  if (systemOneValid && legacyValid && systemOne!.typing !== legacy) {
    warnOnce(
      `[core-llm-wiki] systemOne: \`systemOne.typing\` (${systemOne!.typing}) and \`ontology.backfillClassifier\` `
      + `(${legacy}) disagree; \`systemOne.typing\` wins. Remove the legacy key to silence this warning.`,
    );
  }
  return classifierCallOption
    ?? (systemOneValid ? systemOne!.typing : undefined)
    ?? (legacyValid ? legacy : undefined)
    ?? 'llm';
}

/** Engine default for the backfill shortlist size (`ontology.shortlistK`). */
export const DEFAULT_SHORTLIST_K = 10 as const;

/**
 * Fail-fast `ontology.shortlistK` resolution (specs/backfill-shortlist-wiring §3):
 * missing → 10; a present value must be a finite integer >= 1, otherwise this
 * throws. Never falls back silently on a bad value.
 */
export function resolveShortlistK(config: WikiConfig | undefined): number {
  const k = config?.ontology?.shortlistK;
  if (k === undefined) return DEFAULT_SHORTLIST_K;
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) {
    throw new Error(
      `[core-llm-wiki] \`ontology.shortlistK\` is ${formatConfigValue(k)}, which is not a finite integer >= 1.`,
    );
  }
  return k;
}

/** Engine default confidence floor for classifier typing. */
export const DEFAULT_TYPING_MIN_CONFIDENCE = 0.5 as const;

/**
 * Confidence-floor chain (specs/system-one-config §3):
 * `systemOne.minConfidence.typing` → `ontology.classifyMinConfidence` →
 * `0.5`. `??` throughout, so a configured `0` stays `0`. Only the classifier
 * typing path reads this; call it there, never on the generative path.
 */
export function resolveTypingMinConfidence(config: WikiConfig | undefined): number {
  const systemOneFloor = config?.systemOne?.minConfidence?.typing;
  const legacyFloor = config?.ontology?.classifyMinConfidence;
  const systemOneValid = isConfidenceFloor(systemOneFloor);
  const legacyValid = isConfidenceFloor(legacyFloor);
  if (systemOneFloor !== undefined && !systemOneValid) {
    warnOnce(
      `[core-llm-wiki] systemOne: \`systemOne.minConfidence.typing\` is ${formatConfigValue(systemOneFloor)}, which `
      + 'is not a finite number in [0, 1]. The key is treated as unset and the chain continues.',
    );
  }
  if (legacyFloor !== undefined && !legacyValid) {
    warnOnce(
      `[core-llm-wiki] systemOne: \`ontology.classifyMinConfidence\` is ${formatConfigValue(legacyFloor)}, which `
      + 'is not a finite number in [0, 1]. The key is treated as unset and the chain continues.',
    );
  }
  return (systemOneValid ? systemOneFloor : undefined)
    ?? (legacyValid ? legacyFloor : undefined)
    ?? DEFAULT_TYPING_MIN_CONFIDENCE;
}
