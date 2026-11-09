import type { WikiConfig } from '../types';

/**
 * The 8.0.0 default changes this config would be affected by, as one message,
 * or null when the host has set both options (specs/upgrade-warning-7-18).
 * Only informs: the 7.x defaults stay 'legacy' and 'auto'.
 */
export function upcomingDefaultsWarning(config: WikiConfig | undefined): string | null {
  const strategyUnset = config?.librarian?.strategy === undefined;
  const maintenanceUnset = config?.maintenance === undefined;
  if (!strategyUnset && !maintenanceUnset) return null;

  const unset: string[] = [];
  const keep: string[] = [];
  if (strategyUnset) {
    unset.push("`librarian.strategy` (default becomes 'ops')");
    keep.push("`librarian: { strategy: 'legacy' }`");
  }
  if (maintenanceUnset) {
    unset.push("`maintenance` (default becomes 'deferred')");
    keep.push("`maintenance: 'auto'`");
  }

  const deferredNote = maintenanceUnset
    ? " Under 'deferred', the auto-run thresholds stop applying and nothing runs until the host calls runPendingMaintenance()."
    : '';
  return `[core-llm-wiki] 8.0.0 changes engine defaults, and this config does not set ${unset.join(' or ')}.`
    + `${deferredNote} To keep today's behavior, set ${keep.join(' and ')}.`;
}

const warned = new Set<string>();

/** Logs {@link upcomingDefaultsWarning} at most once per process per distinct message. */
export function warnUpcomingDefaultsOnce(config: WikiConfig | undefined): void {
  const message = upcomingDefaultsWarning(config);
  if (message === null || warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}
