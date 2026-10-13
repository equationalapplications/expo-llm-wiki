import type { SQLiteAdapter, MigrationPolicy, PendingMigrationWork } from '../types';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import { probePendingWork } from './sourceRefNormalize';
import { setupDatabase } from './schema';
import { WikiMigrationRequiredError } from '../types';

const MIGRATION_POLICIES: readonly MigrationPolicy[] = ['allow', 'refuse', 'auto'];

/**
 * Runs the read-only migration gate, then setupDatabase's every-open DDL.
 * - 'allow': no gate.
 * - 'refuse': any pending work throws before any mutation.
 * - 'auto': a pending schema migration throws; a pending source_ref normalize
 *   is let through and run by setup() after the DDL and migrations loop.
 */
export async function setupDatabaseWithGate(
  db: SQLiteAdapter,
  prefix: string,
  meta: MetadataRepository,
  migrations: MigrationPolicy = 'allow',
): Promise<void> {
  // Fail closed: an unrecognized value (e.g. 'Refuse' from env/JSON config) must not
  // silently skip the refusal and run a migration inside a time-critical open.
  if (!MIGRATION_POLICIES.includes(migrations)) {
    throw new TypeError(`Invalid migrations policy ${JSON.stringify(migrations)}; expected 'allow', 'refuse' or 'auto'.`);
  }
  if (migrations !== 'allow') {
    const pending = await probePendingWork(db, meta, prefix);
    if (pending && (migrations === 'refuse' || pending.type === 'schema_migration')) {
      throw new WikiMigrationRequiredError(describePending(pending, migrations), pending);
    }
  }
  return setupDatabase(db, prefix);
}

function describePending(pending: PendingMigrationWork, policy: MigrationPolicy): string {
  const what = pending.type === 'schema_migration'
    ? `schema migration v${pending.fromVersion} -> v${pending.toVersion} is pending`
    : pending.entriesWatermark === 0 && pending.sourceRefIndexWatermark === 0
      ? 'source_ref normalize has not run on this store (normalize stamp missing or outdated; may complete with zero rewrites)'
      : 'source_ref normalize was interrupted and will resume from its watermark';
  return `Migration refused (migrations: '${policy}'): ${what}. ` +
    `Open once with setup({ migrations: 'allow' }) outside any time-critical path to complete it.`;
}
