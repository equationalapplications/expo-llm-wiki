// packages/core/src/services/search/createIndexStrategy.ts
import type { SQLiteAdapter } from '../../types';
import type { MetadataRepository } from '../../repositories/MetadataRepository';
import type { IndexStrategy } from './IndexStrategy';
import { Fts5IndexStrategy } from './Fts5IndexStrategy';
import { MiniSearchIndexStrategy } from './MiniSearchIndexStrategy';
import { FTS5_STATE_KEY, fts5LedgerDropSql } from './fts5Sql';

export type IndexStrategyPreference = 'fts5' | 'minisearch' | 'auto';

/**
 * True when this SQLite build has FTS5 and json1 (the drain needs both). The
 * probe table lives in `temp`, so the database file is never touched.
 * `sqlite_compileoption_used` is not consulted: FTS5 can be loaded as an
 * extension or built into a custom WASM without the flag.
 */
export async function probeFts5(db: SQLiteAdapter, prefix: string): Promise<boolean> {
  const name = `temp.${prefix}fts5_probe`;
  try {
    await db.execAsync(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(x)`);
    const row = await db.getFirstAsync<{ ok: number }>(`SELECT json_valid('[]') AS ok`);
    return row?.ok === 1;
  } catch {
    return false;
  } finally {
    try { await db.execAsync(`DROP TABLE IF EXISTS ${name}`); } catch { /* module absent */ }
  }
}

/**
 * Stop maintaining the FTS5 ledger: drop the triggers and ordinary ledger
 * tables and mark the database detached, so a later FTS5 open rebuilds.
 * The virtual table is dropped best-effort; without the fts5 module it
 * cannot be, and the next FTS5 init recreates it anyway.
 */
export async function detachFts5(db: SQLiteAdapter, prefix: string, metadataRepo: MetadataRepository): Promise<void> {
  const hasLedger = await metadataRepo.tableExists(`${prefix}fts_pending`);
  const state = await metadataRepo.getMeta(FTS5_STATE_KEY);
  if (!hasLedger && state !== 'live') return;
  await db.withTransactionAsync(async (tx) => {
    await tx.execAsync(fts5LedgerDropSql(prefix));
    await metadataRepo.setMeta(FTS5_STATE_KEY, 'detached', tx);
  });
  try { await db.execAsync(`DROP TABLE IF EXISTS ${prefix}entries_fts`); } catch { /* no fts5 module */ }
}

/** Resolve the keyword-index strategy for this database. Spec 2026-10-05 §PR-2 revision. */
export async function createIndexStrategy(
  db: SQLiteAdapter,
  prefix: string,
  metadataRepo: MetadataRepository,
  preferred: IndexStrategyPreference,
): Promise<IndexStrategy> {
  if (preferred !== 'minisearch') {
    if (await probeFts5(db, prefix)) {
      const strategy = new Fts5IndexStrategy(db, prefix, metadataRepo);
      try {
        await strategy.init();
        return strategy;
      } catch (err) {
        // The probe only checks that FTS5/json1 are present; init can still
        // fail (rebuild tx lock, DDL permission, etc.). The 'auto' contract is
        // "FTS5 when usable, else MiniSearch" — log and fall through. Pinned
        // 'fts5' must surface the failure to the caller.
        if (preferred === 'fts5') throw err;
        console.warn('[WikiMemory] FTS5 init failed; falling back to MiniSearch:', err);
      }
    } else if (preferred === 'fts5') {
      throw new Error(`indexStrategy 'fts5' was requested, but this SQLite build lacks FTS5 or json1.`);
    }
  }
  await detachFts5(db, prefix, metadataRepo);
  return new MiniSearchIndexStrategy();
}
