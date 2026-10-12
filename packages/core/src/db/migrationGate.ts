import type { SQLiteAdapter } from '../types';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import { probePendingWork } from './sourceRefNormalize';
import { WikiMigrationRequiredError } from '../types';

export interface MigrationGateOptions {
  prefix: string;
  meta: MetadataRepository;
  migrations: 'allow' | 'refuse' | 'auto';
}

export async function setupDatabaseWithGate(
  db: SQLiteAdapter,
  prefix: string,
  meta: MetadataRepository,
  migrations: 'allow' | 'refuse' | 'auto' = 'auto'
): Promise<void> {
  if (migrations === 'allow') {
    // Allow all migrations - proceed normally
    const { setupDatabase } = await import('./schema');
    return setupDatabase(db, prefix);
  }

  // Check for pending work
  const pending = await probePendingWork(meta, prefix);

  if (pending) {
    if (migrations === 'auto') {
      // Auto-run the specific pending work
      if (pending.type === 'source_ref_normalize') {
        const { runSourceRefNormalize } = await import('./sourceRefNormalize');
        await runSourceRefNormalize(db, prefix, meta);
      } else {
        throw new WikiMigrationRequiredError(
          `Full migration required: ${pending.type}`,
          pending
        );
      }
    } else {
      // Refuse migration and throw error
      throw new WikiMigrationRequiredError(
        `Migration refused: ${pending.type}`,
        pending
      );
    }
  }

  // No pending work, proceed normally
  const { setupDatabase } = await import('./schema');
  return setupDatabase(db, prefix);
}