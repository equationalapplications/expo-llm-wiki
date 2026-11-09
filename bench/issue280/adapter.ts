// bench/issue280/adapter.ts
//
// File-backed better-sqlite3 adapter with per-transaction timing. Same shape as
// packages/core/__tests__/helpers/sqliteAdapter.ts. Timing wraps the COMMIT, and
// each transaction is classified from the statements it ran.
import Database from 'better-sqlite3';

export type TxKind =
  | 'rename' | 'delete' | 'merge' | 'drop' | 'window' | 'sweep' | 'ledger' | 'normalize' | 'reclaim-probe' | 'other';

export interface TxRecord { kind: TxKind; ms: number }

const WM = 'fts5_rebuild_wm';
const SWEEP = 'fts5_orphan_sweep_cursor';
const NORMALIZE = /^normalize_v14_/;

/** Most specific wins; `current` is kept unless the new statement outranks it. */
const RANK: TxKind[] = ['other', 'ledger', 'normalize', 'sweep', 'window', 'delete', 'merge', 'rename', 'drop'];

export function classify(sql: string, args: readonly unknown[], current: TxKind): TxKind {
  let next: TxKind = 'other';
  if (/ALTER TABLE .*RENAME TO .*_retired_/.test(sql)) next = 'rename';
  else if (/DROP TABLE IF EXISTS .*_retired_/.test(sql)) next = 'drop';
  else if (/DELETE FROM .*_retired_/.test(sql)) next = 'delete';
  else if (/VALUES\('merge'/.test(sql)) next = 'merge';
  else if (args.includes(WM) && !/^\s*DELETE/i.test(sql)) next = 'window';
  else if (args.includes(SWEEP) && !/^\s*DELETE/i.test(sql)) next = 'sweep';
  else if (args.some((a) => typeof a === 'string' && NORMALIZE.test(a))) next = 'normalize';
  else if (/DELETE FROM .*fts_pending/.test(sql)) next = 'ledger';
  return RANK.indexOf(next) > RANK.indexOf(current) ? next : current;
}

export interface BenchDb {
  adapter: any;
  raw: Database.Database;
  records: TxRecord[];
  close(): void;
}

export function openBenchDb(path: string): BenchDb {
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  const records: TxRecord[] = [];
  let txKind: TxKind | null = null;

  const note = (sql: string, args: readonly unknown[]): void => {
    if (txKind !== null) txKind = classify(sql, args, txKind);
  };

  const adapter = {
    async execAsync(sql: string): Promise<void> {
      note(sql, []);
      raw.exec(sql);
    },
    async runAsync(sql: string, args: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      note(sql, args);
      const info = raw.prepare(sql).run(...(args as any[]));
      return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
    },
    // Reads pass no args to the classifier: every tx reads the watermark keys, and only a write identifies it.
    async getAllAsync<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      note(sql, []);
      return raw.prepare(sql).all(...(args as any[])) as T[];
    },
    async getFirstAsync<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      note(sql, []);
      if (txKind === null && /^SELECT rowid FROM .*_retired_\d+ LIMIT 1/.test(sql)) {
        const t0 = performance.now();
        const row = raw.prepare(sql).get(...(args as any[]));
        records.push({ kind: 'reclaim-probe', ms: performance.now() - t0 });
        return (row ?? null) as T | null;
      }
      return (raw.prepare(sql).get(...(args as any[])) ?? null) as T | null;
    },
    async withTransactionAsync<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const t0 = performance.now();
      txKind = 'other';
      raw.exec('BEGIN');
      try {
        const result = await fn(adapter);
        raw.exec('COMMIT');
        records.push({ kind: txKind ?? 'other', ms: performance.now() - t0 });
        return result;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* never mask the original error */ }
        throw e;
      } finally {
        txKind = null;
      }
    },
    async closeAsync(): Promise<void> { raw.close(); },
  };

  return { adapter, raw, records, close: () => raw.close() };
}

/** Never touch a real store: every path the harness opens must live under the bench store directory. */
export function storeDir(): string {
  return process.env.ISSUE280_STORE_DIR ?? `${process.env.HOME}/issue280-stores`;
}

export function assertBenchPath(path: string): void {
  const dir = storeDir();
  if (!path.startsWith(`${dir}/`) || !path.includes('/issue280-')) {
    throw new Error(`Refusing to open ${path}: bench stores must be issue280-*.db under ${dir}`);
  }
}
