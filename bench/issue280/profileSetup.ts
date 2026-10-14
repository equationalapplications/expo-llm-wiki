// bench/issue280/profileSetup.ts
//
// issue280-B8 measurement driver (plan B8 Step 1, `--leg window|reclaim`).
// Walks the shipped B-track open path against a generated store:
//
//   init: Fts5IndexStrategy.init()          (fast path for a live store)
//   window: resetAndRearm -> full quanta    (500-row windows + 1 sweep tx)
//   reclaim: a retired FTS table drains via bounded reclaim steps
//
// Every transaction is the engine's own, via the serialized adapter. The
// driver prints per-phase timing and JSON for the report.
//
// Usage:
//   tsx bench/issue280/profileSetup.ts --store <path.db> [--budget 1500]
//       [--leg all|open|window|reclaim] [--phase-log] [--json <out>]
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { monotonicNow } from '../../packages/core/src/utils/monotonicNow';
import { withSerializedTransactions } from '../../packages/core/src/db/serializedAdapter';
import { setupDatabase } from '../../packages/core/src/db/schema';
import { MetadataRepository } from '../../packages/core/src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../../packages/core/src/services/search/Fts5IndexStrategy';
import {
  FTS5_STATE_KEY, FTS5_RETIRED_TABLES_KEY, FTS5_REBUILD_WM_KEY,
} from '../../packages/core/src/services/search/fts5Sql';
import type { SQLiteAdapter } from '../../packages/core/src/types';

const P = 'llm_wiki_';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const storePath = arg('store');
if (!storePath) throw new Error('--store <path.db> required');
const budgetMs = Number(arg('budget') ?? 1500);
const leg = arg('leg') ?? 'all';
const phaseLog = process.argv.includes('--phase-log');
const jsonOut = arg('json');

if (process.env.ISSUE280_STORE_DIR) {
  console.log(`store dir: ${process.env.ISSUE280_STORE_DIR} (never /tmp)`);
}

type Phase = { phase: string; ms: number; extra?: Record<string, unknown> };
const phases: Phase[] = [];
const log = (phase: string, t0: number, extra?: Record<string, unknown>) => {
  const ms = monotonicNow() - t0;
  phases.push({ phase, ms, extra });
  console.log(`  ${phase.padEnd(28)} ${ms.toFixed(1).padStart(10)} ms${extra ? '  ' + JSON.stringify(extra) : ''}`);
};

// Raw better-sqlite3 handle, adapted to the engine's SQLiteAdapter surface
// (the same shape as packages/core/__tests__/helpers/sqliteAdapter.ts, but
// file-backed) and then wrapped in the serialized-transaction mutex exactly
// like the engine constructor does.
function betterSqliteAdapter(instance: Database.Database): SQLiteAdapter {
  const adapter: SQLiteAdapter = {
    async execAsync(sql: string): Promise<void> {
      instance.exec(sql);
    },
    async runAsync(sql: string, args: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const info = instance.prepare(sql).run(...(args as never[]));
      return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      return instance.prepare(sql).all(...(args as never[])) as T[];
    },
    async getFirstAsync<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      return (instance.prepare(sql).get(...(args as never[])) ?? null) as T | null;
    },
    async withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
      instance.exec('BEGIN');
      try {
        const result = await fn(adapter);
        instance.exec('COMMIT');
        return result;
      } catch (e) {
        try { instance.exec('ROLLBACK'); } catch { /* may not be in a tx */ }
        throw e;
      }
    },
    async closeAsync(): Promise<void> {
      instance.close();
    },
  };
  return adapter;
}

const raw = new Database(storePath);
raw.pragma('journal_mode = WAL');
const rawAsAdapter = betterSqliteAdapter(raw);
const db: SQLiteAdapter = withSerializedTransactions(rawAsAdapter);

async function counts(): Promise<Record<string, number>> {
  const one = async (sql: string) =>
    (await rawAsAdapter.getFirstAsync<{ n: number }>(sql))?.n ?? -1;
  return {
    entries: await one(`SELECT count(*) AS n FROM ${P}entries`),
    fts: await one(`SELECT count(*) AS n FROM ${P}entries_fts`),
    map: await one(`SELECT count(*) AS n FROM ${P}fts_map`),
    ledger: await one(`SELECT count(*) AS n FROM ${P}fts_pending`),
  };
}

function state(): string | null {
  return (raw.prepare(`SELECT value FROM ${P}meta WHERE key = ?`).get(FTS5_STATE_KEY) as { value: string } | undefined)?.value ?? null;
}
function retiredList(): string[] {
  const rawV = (raw.prepare(`SELECT value FROM ${P}meta WHERE key = ?`).get(FTS5_RETIRED_TABLES_KEY) as { value: string } | undefined)?.value;
  try { return rawV ? (JSON.parse(rawV) as string[]) : []; } catch { return []; }
}

// Tokenizer-mismatch reset, the B4 recipe scaled up: swap entries_fts to the
// plain unicode61 tokenizer behind the engine's back. init() sees the wrong
// DDL, renames the table (rename-retire), rebuilds from 0, reclaims later.
function swapTokenizer(): void {
  const n = (raw.prepare(`SELECT count(*) AS n FROM ${P}entries_fts`).get() as { n: number }).n;
  const t0 = monotonicNow();
  raw.exec(`
DROP TABLE ${P}entries_fts;
CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(
  id UNINDEXED, entity_id UNINDEXED, title, body, tags,
  tokenize = 'unicode61'
);
INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags)
  SELECT rowid, id, entity_id, title, body, '' FROM ${P}entries;
`);
  console.log(`swapTokenizer: ${n} fts rows moved to the wrong tokenizer in ${(monotonicNow() - t0).toFixed(0)} ms (harness setup, not measured)`);
}

async function main(): Promise<void> {
  const storeMb =
    ((raw.prepare('PRAGMA page_count').get() as { page_count: number }).page_count *
      (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size) / (1024 * 1024);
  console.log(`store: ${storePath} (${storeMb.toFixed(1)} MB), budget ${budgetMs} ms, leg ${leg}`);
  console.log(`before: ${JSON.stringify(await counts())} state=${state()}`);

  // init on the store as generated (live fast path).
  await setupDatabase(db, P);
  const meta = new MetadataRepository(db, P);
  let t0 = monotonicNow();
  const live = new Fts5IndexStrategy(db, P, meta, budgetMs);
  await live.init();
  log('init-live', t0, { state: state() });

  if (leg === 'open' || leg === 'all') {
    // Second open of a converged store: the steady-state fence budget.
    t0 = monotonicNow();
    const again = new Fts5IndexStrategy(db, P, meta, budgetMs);
    await again.init();
    log('init-live-second-open', t0);
  }

  if (leg === 'window' || leg === 'all') {
    // Window leg: force the reset path, then drive quanta to convergence.
    swapTokenizer();
    t0 = monotonicNow();
    const s = new Fts5IndexStrategy(db, P, meta, budgetMs);
    await s.init(); // rename-retire + re-arm (one tx; includes the RENAME of the big FTS table)
    log('init-reset-rearm', t0, { retired: retiredList() });

    let quanta = 0;
    const windowTxsSeen: number[] = [];
    const quantumMs: number[] = [];
    const wmStart = JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY)) ?? '{"rowid":0}') as { rowid: number };
    t0 = monotonicNow();
    const legStart = t0;
    while (state() !== 'live') {
      const q0 = monotonicNow();
      await s.drain({ mode: 'full', deadline: monotonicNow() + budgetMs }); // absolute monotonic deadline, per DrainOptions
      quantumMs.push(monotonicNow() - q0);
      quanta++;
      const wmNow = JSON.parse(((await meta.getMeta(FTS5_REBUILD_WM_KEY)) ?? '{}')) as { rowid?: number };
      if (wmNow.rowid !== undefined) windowTxsSeen.push(wmNow.rowid);
      if (quanta % 25 === 0) console.log(`    window quanta=${quanta} wm=${wmNow.rowid ?? '?'} state=${state()}`);
      if (quanta > 10000) throw new Error('no convergence after 10000 quanta');
    }
    const drainMs = monotonicNow() - t0;
    log('window-drain-to-live', drainMs, {
      quanta,
      finalWmRowid: windowTxsSeen[windowTxsSeen.length - 1] ?? wmStart.rowid,
      avgQuantumMs: quanta ? +(drainMs / quanta).toFixed(1) : 0,
      maxQuantumMs: quantumMs.length ? +Math.max(...quantumMs).toFixed(1) : 0,
    });
    log('window-total-incl-init', monotonicNow() - legStart);
  }

  if (leg === 'reclaim' || leg === 'all') {
    // Reclaim leg: retire a converged FTS table without dropping it (the
    // engine's own rename-retire), then drain until the retired list empties.
    // Note: window legs above already converge; for a clean reclaim
    // measurement use a store copy where we retire via a targeted reset.
    swapTokenizer();
    t0 = monotonicNow();
    const s = new Fts5IndexStrategy(db, P, meta, budgetMs);
    await s.init();
    log('init-reset-rearm', t0, { retired: retiredList() });
    let reclaimQuanta = 0;
    t0 = monotonicNow();
    const legStart = t0;
    while (state() !== 'live' || retiredList().length > 0) {
      await s.drain({ mode: 'full', deadline: monotonicNow() + budgetMs });
      reclaimQuanta++;
      if (reclaimQuanta % 25 === 0) console.log(`    reclaim quanta=${reclaimQuanta} state=${state()} retired=${retiredList().length}`);
      if (reclaimQuanta > 10000) throw new Error('no convergence after 10000 quanta');
    }
    log('reclaim-drain-to-empty', monotonicNow() - t0, {
      quanta: reclaimQuanta,
      avgQuantumMs: +((monotonicNow() - t0) / reclaimQuanta).toFixed(1),
      note: 'windows+reclaim interleave inside full quanta; reclaim steps are bounded per tx by contract',
    });
    log('reclaim-total-incl-init', monotonicNow() - legStart);
  }

  console.log(`after: ${JSON.stringify(await counts())} state=${state()} retired=${JSON.stringify(retiredList())}`);
  const dbPages = raw.prepare('PRAGMA page_count').get() as { page_count: number };
  const dbBytes = dbPages.page_count * (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  console.log(`final db size: ${(dbBytes / (1024 * 1024)).toFixed(1)} MB`);
  raw.close();

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ store: storePath, storeMb, budgetMs, leg, phases }, null, 2) + '\n');
    console.log(`json: ${jsonOut}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
