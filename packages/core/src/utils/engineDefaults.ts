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
 * the auto-run thresholds do nothing under `deferred`, and the ops librarian
 * doesn't read `prompts.librarianSystemPrompt`. Names each mismatch so an
 * upgrade doesn't quietly lose maintenance or a custom prompt.
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
  if (config?.prompts?.librarianSystemPrompt !== undefined && config?.librarian?.strategy === undefined) {
    warnings.push(
      "[core-llm-wiki] `prompts.librarianSystemPrompt` is set, but `librarian.strategy` now defaults to 'ops', "
      + "which does not use it. Set `librarian: { strategy: 'legacy' }` to keep the override.",
    );
  }
  return warnings;
}
