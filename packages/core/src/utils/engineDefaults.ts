import type { WikiConfig } from '../types';

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
