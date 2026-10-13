// packages/core/src/services/search/createIndexStrategy.ts
import type { SQLiteAdapter } from '../../types';
import type { MetadataRepository } from '../../repositories/MetadataRepository';
import type { IndexStrategy } from './IndexStrategy';
import { Fts5IndexStrategy } from './Fts5IndexStrategy';
import { MiniSearchIndexStrategy } from './MiniSearchIndexStrategy';
import { UnavailableIndexStrategy } from './UnavailableIndexStrategy';
import { FTS5_STATE_KEY, fts5LedgerDropSql } from './fts5Sql';

export type IndexStrategyPreference = 'fts5' | 'minisearch' | 'auto';

export const FTS5_INIT_RETRY_MS = 250;

/** True only for errors meaning the module is genuinely absent (permanent). Proxy-safe. */
function isModuleAbsentError(err: unknown): boolean {
  // Walk a short cause chain: some adapters wrap the SQLite message.
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur != null; depth++) {
    let msg = '';
    try { msg = String((cur as { message?: unknown }).message ?? cur); } catch { return false; }
    if (/no such module: fts5/i.test(msg) || /no such function: json_valid/i.test(msg)) return true;
    try { cur = (cur as { cause?: unknown }).cause; } catch { return false; }
  }
  return false;
}

/**
 * Whether this SQLite build has FTS5 and json1 (the drain needs both). The
 * probe table lives in `temp`, so the database file is never touched.
 * Returns false ONLY when the module is genuinely absent; any other error
 * (SQLITE_IOERR, NOMEM, INTERRUPT, ...) is rethrown so the caller treats it
 * as a transient init failure instead of detaching a healthy store
 * (spec #280 Change 4).
 */
export async function probeFts5(db: SQLiteAdapter, prefix: string): Promise<boolean> {
  const name = `temp.${prefix}fts5_probe`;
  try {
    await db.execAsync(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(x)`);
    const row = await db.getFirstAsync<{ ok: number }>(`SELECT json_valid('[]') AS ok`);
    return row?.ok === 1;
  } catch (err) {
    if (isModuleAbsentError(err)) return false;
    throw err;
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

/** Resolve the keyword-index strategy for this database. Failure ordering per spec #280 Change 4. */
export async function createIndexStrategy(
  db: SQLiteAdapter,
  prefix: string,
  metadataRepo: MetadataRepository,
  preferred: IndexStrategyPreference,
  opts: { setupBudgetMs?: number } = {},
): Promise<IndexStrategy> {
  if (preferred === 'minisearch') {
    await detachFts5(db, prefix, metadataRepo); // operator's explicit choice
    return new MiniSearchIndexStrategy();
  }
  const attempt = async (): Promise<IndexStrategy | 'absent'> => {
    if (!(await probeFts5(db, prefix))) return 'absent';
    const strategy = new Fts5IndexStrategy(db, prefix, metadataRepo, opts.setupBudgetMs);
    await strategy.init();
    return strategy;
  };
  const absent = async (): Promise<IndexStrategy> => {
    if (preferred === 'fts5') {
      throw new Error(`indexStrategy 'fts5' was requested, but this SQLite build lacks FTS5 or json1.`);
    }
    await detachFts5(db, prefix, metadataRepo); // module genuinely absent: permanent
    return new MiniSearchIndexStrategy();
  };

  for (let tries = 1; ; tries++) {
    try {
      const s = await attempt();
      return s === 'absent' ? await absent() : s;
    } catch (err) {
      if (preferred === 'fts5') throw err; // pinned: surface the raw failure
      if (tries === 2) {
        // Never detachFts5 here: a transient failure must not drop the ledger and
        // route a large store into MiniSearch's full sync (measured OOM).
        console.warn('[WikiMemory] FTS5 init failed after retry; keyword search unavailable until a later open or syncSearchIndex():', err);
        return new UnavailableIndexStrategy(err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, FTS5_INIT_RETRY_MS));
  }
}
