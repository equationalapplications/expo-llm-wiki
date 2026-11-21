import type { OntologyConfig } from '../../types';

/**
 * The one place the ontology-backfill scheduler default is defined
 * (specs/system-one-config §8). Read sites resolve through this so a host
 * that sets nothing gets the same answer everywhere — the same discipline as
 * `engineDefaults.ts` for the 8.0.0 librarian/maintenance defaults.
 */

/** Default batch size for scheduler-driven ontology backfill passes. */
export const DEFAULT_ONTOLOGY_JOB_BATCH_SIZE = 50;

export interface OntologyJobDefaults {
  batchSize: number;
}

/**
 * Resolve the scheduler's ontology-backfill batch size from
 * `WikiConfig.ontology.schedulerBatchSize`. Invalid values (non-finite, < 1)
 * fall back to the default rather than throwing — a bad config value degrades
 * to the default instead of breaking construction or every run.
 */
export function resolveOntologyJobDefaults(ontology: OntologyConfig | undefined): OntologyJobDefaults {
  const raw = ontology?.schedulerBatchSize;
  const batchSize = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_ONTOLOGY_JOB_BATCH_SIZE;
  return { batchSize };
}
