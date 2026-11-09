// bench/issue280/profileSetup.ts
//
// Times setup() legs against a COPY of a store built by makeStore.ts, so legs
// never contaminate each other. No LLM calls: the provider is a stub.
// Usage: node bench/issue280/profileSetup.ts --store <path> --leg <leg> [--budget ms] [--out dir]
// Legs: warm | crash | normalize | gate | migration | window | reclaim
import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import Database from 'better-sqlite3';
import { WikiMemory } from '../../packages/core/dist/index.mjs';
import { assertBenchPath, openBenchDb, type BenchDb, type TxRecord } from './adapter.ts';

const P = 'llm_wiki_';
const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const leg = arg('leg')!;
const store = arg('store')!;
const budget = Number(arg('budget', '1500'));
const maxMinutes = Number(arg('max-minutes', '360'));
const outDir = arg('out', join(here, 'results'))!;
assertBenchPath(store);

function open(path: string, setupBudgetMs = budget): { db: BenchDb; wiki: any } {
  const db = openBenchDb(path);
  const wiki = new WikiMemory(db.adapter, {
    llmProvider: { generateText: async () => '{}' },
    config: { indexStrategy: 'fts5', setupBudgetMs },
  });
  return { db, wiki };
}

function workCopy(name: string): string {
  const copy = `${store.replace(/\.db$/, '')}-${name}.db`;
  assertBenchPath(copy);
  for (const s of ['', '-wal', '-shm']) rmSync(`${copy}${s}`, { force: true });
  copyFileSync(store, copy);
  return copy;
}

function removeCopy(copy: string): void {
  for (const s of ['', '-wal', '-shm']) rmSync(`${copy}${s}`, { force: true });
}

function stats(values: number[]): { count: number; medianMs: number; p95Ms: number; maxMs: number; totalMs: number } {
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number): number => (v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0);
  const round = (n: number): number => Math.round(n * 10) / 10;
  return { count: v.length, medianMs: round(at(0.5)), p95Ms: round(at(0.95)), maxMs: round(v[v.length - 1] ?? 0), totalMs: round(v.reduce((a, b) => a + b, 0)) };
}

function byKind(records: TxRecord[]): Record<string, ReturnType<typeof stats>> {
  const groups: Record<string, number[]> = {};
  for (const r of records) (groups[r.kind] ??= []).push(r.ms);
  return Object.fromEntries(Object.entries(groups).map(([k, ms]) => [k, stats(ms)]));
}

function machine(): Record<string, unknown> {
  let disk = 'unknown';
  try {
    disk = execSync(`diskutil info / | grep -E 'Solid State|Protocol|File System Personality'`).toString().replace(/\s+/g, ' ').trim();
  } catch { /* not macOS */ }
  return {
    cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()} ${os.arch()}`, disk, node: process.version, loadAverageAtEnd: os.loadavg(),
    betterSqlite3: new Database(':memory:').prepare('SELECT sqlite_version() AS v').get(),
  };
}

function report(body: Record<string, unknown>): void {
  mkdirSync(outDir, { recursive: true });
  const entries = basename(store).match(/issue280-(\d+)/)?.[1] ?? 'unknown';
  const file = join(outDir, `${leg}-${entries}.json`);
  const result = { leg, store: basename(store), storeBytes: statSync(store).size, budgetMs: budget, at: new Date().toISOString(), machine: machine(), ...body };
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ file, ...body }).slice(0, 2000));
}

const meta = (db: BenchDb, key: string): string | null =>
  (db.raw.prepare(`SELECT value FROM ${P}meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;

async function timedOpen(path: string): Promise<{ ms: number; records: TxRecord[] }> {
  const { db, wiki } = open(path);
  const t0 = performance.now();
  await wiki.setup();
  const ms = performance.now() - t0;
  db.close();
  return { ms, records: db.records };
}

/** Acceptance 1 / 4: opens of a live, stamped store. */
async function warmLeg(): Promise<void> {
  const copy = workCopy('warm');
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) runs.push((await timedOpen(copy)).ms);
  let cold: unknown = 'not measured: dropping the page cache needs sudo (purge), unavailable to this run';
  if (spawnSync('sudo', ['-n', 'purge']).status === 0) {
    const coldRuns: number[] = [];
    for (let i = 0; i < 5; i++) {
      spawnSync('sudo', ['-n', 'purge']);
      coldRuns.push((await timedOpen(copy)).ms);
    }
    cold = stats(coldRuns);
  }
  removeCopy(copy);
  report({ runsMs: runs.map((r) => Math.round(r)), warm: stats(runs), cold, targets: { warmMs: 1000, coldMs: 3000, fenceMs: 15000 } });
}

/** Acceptance 4's post-crash-resume case: SIGKILL with committed WAL frames and ledger rows outstanding. */
async function crashLeg(): Promise<void> {
  const copy = workCopy('crash');
  const rows = Number(arg('crash-rows', '5000'));
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--leg', 'crash-child', '--store', copy, '--crash-rows', String(rows)], { stdio: 'inherit' });
  if (child.signal !== 'SIGKILL') {
    removeCopy(copy);
    throw new Error(`crash-child did not die by SIGKILL (status ${child.status}, signal ${child.signal})`);
  }
  const { ms, records } = await timedOpen(copy);
  const raw = new Database(copy, { readonly: true });
  const left = (raw.prepare(`SELECT count(*) AS n FROM ${P}fts_pending`).get() as { n: number }).n;
  raw.close();
  removeCopy(copy);
  report({ childSignal: child.signal, crashRows: rows, openMs: Math.round(ms), ledgerRowsLeftAfterOpen: left, tx: byKind(records), targetFenceMs: 15000 });
}

function crashChild(): void {
  const raw = new Database(store);
  raw.pragma('journal_mode = WAL');
  raw.pragma('wal_autocheckpoint = 0');
  const rows = Number(arg('crash-rows', '5000'));
  const insert = raw.prepare(`UPDATE ${P}entries SET title = title || ' x' WHERE rowid = ?`);
  raw.transaction(() => { for (let i = 1; i <= rows; i++) insert.run(i); })();
  process.kill(process.pid, 'SIGKILL');
}

/** A8: the normalize rate. */
async function normalizeLeg(): Promise<void> {
  const copy = workCopy('normalize');
  const raw = new Database(copy);
  raw.prepare(`DELETE FROM ${P}meta WHERE key = 'source_ref_normalize_stamp'`).run();
  const entries = (raw.prepare(`SELECT count(*) AS n FROM ${P}entries`).get() as { n: number }).n;
  const sri = (raw.prepare(`SELECT count(*) AS n FROM ${P}source_ref_index`).get() as { n: number }).n;
  raw.close();
  const { ms, records } = await timedOpen(copy);
  removeCopy(copy);
  report({ normalizeOpenMs: Math.round(ms), rowsScanned: entries + sri, rowsPerSecond: Math.round((entries + sri) / (ms / 1000)), tx: byKind(records) });
}

/** Rev 11: the in-lease open that trips the gate is read-only. */
async function gateLeg(): Promise<void> {
  const copy = workCopy('gate');
  const raw = new Database(copy);
  raw.prepare(`DELETE FROM ${P}meta WHERE key = 'source_ref_normalize_stamp'`).run();
  raw.close();
  const { db, wiki } = open(copy);
  const t0 = performance.now();
  let error = 'did not throw';
  try { await wiki.setup({ migrations: 'refuse' }); } catch (e) { error = (e as Error).name; }
  const ms = performance.now() - t0;
  const stampAfter = meta(db, 'source_ref_normalize_stamp');
  db.close();
  removeCopy(copy);
  report({ gateTripMs: Math.round(ms * 10) / 10, error, stampAfter, tx: byKind(db.records) });
}

/** Acceptance 6: a first open by this engine of a store last written by an older one. */
async function migrationLeg(): Promise<void> {
  const copy = workCopy('migration');
  const raw = new Database(copy);
  raw.exec(`DROP INDEX IF EXISTS ${P}entries_legacy_source_type_idx; DROP INDEX IF EXISTS ${P}fts_pending_id; DROP INDEX IF EXISTS ${P}fts_pending_entity;`);
  raw.prepare(`DELETE FROM ${P}meta WHERE key = 'source_ref_normalize_stamp'`).run();
  raw.prepare(`UPDATE ${P}meta SET value = '13' WHERE key = 'schema_version'`).run();
  raw.pragma('wal_checkpoint(TRUNCATE)');
  raw.close();
  const { ms, records } = await timedOpen(copy);
  removeCopy(copy);
  report({ migrationOpenMs: Math.round(ms), tx: byKind(records), targetMs: 240000 });
}

/** B8 + F8: marker loss, keep-map rebuild, driven by scheduled no-arg syncSearchIndex(). */
async function windowLeg(): Promise<void> {
  const copy = workCopy('window');
  const raw = new Database(copy);
  raw.prepare(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`).run();
  raw.close();
  const { db, wiki } = open(copy);
  const t0 = performance.now();
  await wiki.setup();
  const firstOpenMs = performance.now() - t0;
  const walls: number[] = [];
  const stop = performance.now() + maxMinutes * 60_000;
  let quanta = 0;
  while (meta(db, 'fts5_index_state') !== 'live' && performance.now() < stop) {
    const q0 = performance.now();
    await wiki.syncSearchIndex();
    walls.push(performance.now() - q0);
    quanta++;
    if (quanta % 200 === 0) console.log(`quantum ${quanta} wm ${meta(db, 'fts5_rebuild_wm')} sweep ${meta(db, 'fts5_orphan_sweep_cursor')}`);
  }
  const state = meta(db, 'fts5_index_state');
  const totalS = (performance.now() - t0) / 1000;
  const entries = (db.raw.prepare(`SELECT count(*) AS n FROM ${P}entries`).get() as { n: number }).n;
  db.close();
  const tx = byKind(db.records);
  removeCopy(copy);
  report({
    converged: state === 'live', state, firstOpenMs: Math.round(firstOpenMs), quantaToLive: quanta,
    quantum: stats(walls), totalSeconds: Math.round(totalS), windowsPerQuantum: (tx.window?.count ?? 0) / Math.max(1, quanta),
    rowsPerSecond: Math.round(entries / totalS), tx, targets: { convergedOpenMs: 3500 },
  });
}

/** B8: rename-retire then reclamation of a full-size retired table. */
async function reclaimLeg(): Promise<void> {
  const copy = workCopy('reclaim');
  const raw = new Database(copy);
  raw.pragma('journal_mode = WAL');
  const d0 = performance.now();
  raw.exec(`DROP TABLE ${P}entries_fts;`);
  const baselineDropMs = performance.now() - d0;
  const s0 = performance.now();
  raw.exec(`BEGIN; DELETE FROM ${P}fts_map;
    CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tags, tokenize = 'unicode61');
    INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags) SELECT rowid, id, entity_id, title, body, '' FROM ${P}entries; COMMIT;`);
  const swapMs = performance.now() - s0;
  raw.pragma('wal_checkpoint(TRUNCATE)');
  const fullRows = (raw.prepare(`SELECT count(*) AS n FROM ${P}entries_fts`).get() as { n: number }).n;
  const fullIndexBytes = (raw.prepare(`SELECT sum(length(block)) AS n FROM ${P}entries_fts_data`).get() as { n: number }).n;
  raw.close();
  console.log(`baseline full DROP ${Math.round(baselineDropMs)} ms; swap ${Math.round(swapMs)} ms`);

  const { db, wiki } = open(copy);
  const t0 = performance.now();
  await wiki.setup();
  const firstOpenMs = performance.now() - t0;
  const retired = (): string[] => JSON.parse(meta(db, 'fts5_retired_tables') ?? '[]') as string[];
  const walls: number[] = [];
  const stop = performance.now() + maxMinutes * 60_000;
  let quanta = 0;
  while ((meta(db, 'fts5_index_state') !== 'live' || retired().length > 0) && performance.now() < stop) {
    const q0 = performance.now();
    await wiki.syncSearchIndex();
    walls.push(performance.now() - q0);
    quanta++;
    if (quanta % 50 === 0) {
      const left = db.records.filter((r) => r.kind === 'delete').length;
      console.log(`quantum ${quanta} state ${meta(db, 'fts5_index_state')} deleteSteps ${left} merges ${db.records.filter((r) => r.kind === 'merge').length}`);
    }
  }
  const finished = retired().length === 0 && meta(db, 'fts5_index_state') === 'live';
  const totalS = (performance.now() - t0) / 1000;
  const peakDrop = db.records.filter((r) => r.kind === 'drop');
  db.close();
  removeCopy(copy);
  report({
    finished, fullRows, fullIndexBytes, baselineFullDropMs: Math.round(baselineDropMs), swapMs: Math.round(swapMs),
    firstOpenMs: Math.round(firstOpenMs), quanta, quantum: stats(walls), totalSeconds: Math.round(totalS),
    finalDropMs: peakDrop.map((r) => Math.round(r.ms * 10) / 10), tx: byKind(db.records),
    spec: { originalFullDropFloorMs: 22300, ruleBounded: 'final DROP is much less than the floor and the same order as one chunk' },
  });
}

const legs: Record<string, () => unknown> = {
  warm: warmLeg, crash: crashLeg, 'crash-child': crashChild, normalize: normalizeLeg,
  gate: gateLeg, migration: migrationLeg, window: windowLeg, reclaim: reclaimLeg,
};
if (!legs[leg]) throw new Error(`Unknown leg ${leg}`);
await legs[leg]();
