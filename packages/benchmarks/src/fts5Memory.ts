// packages/benchmarks/src/fts5Memory.ts
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import { openDb } from './db';

const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]));
const strategy = (args.get('strategy') ?? 'fts5') as 'fts5' | 'minisearch';
const targetMiB = Number(args.get('target-mib') ?? 500);
const out = args.get('out');
const NODES = 200, BODY_WORDS = 400;
const VOCAB = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}x`);

// Per-batch sourceHash: a constant hash mapped to multiple sourceRefs trips
// upsertGraph's WikiSourceRefHashCollision contract (HANDOFF ruling #4 — same
// defect Task 7 hit in fts5Integration.test.ts and adapted identically).
const hashFor = (b: number) => 'b'.repeat(56) + b.toString(16).padStart(8, '0');

let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
const timer = setInterval(sample, 100);
const mib = (b: number) => Math.round(b / 1048576);
// WAL mode keeps recent writes in the -wal sidecar until checkpoint, so the main file alone under-reports size.
// A single non-throwing stat: a checkpoint can remove the sidecar at any moment.
const dbBytes = (f: string) => statSync(f).size + (statSync(`${f}-wal`, { throwIfNoEntry: false })?.size ?? 0);

// searchKeyword is reached through __testAccess, which warns outside NODE_ENV=test.
// Forced (not defaulted): this standalone script has no other NODE_ENV reader.
process.env.NODE_ENV = 'test';

let seed = 257;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const text = (n: number) => Array.from({ length: n }, () => VOCAB[Math.floor(rand() * VOCAB.length)]).join(' ');

async function main() {
  const file = join(mkdtempSync(join(tmpdir(), 'fts5mem-')), 'bench.db');
  const llm = { llmProvider: { generateText: async () => '{}' } };
  let { adapter, close } = openDb(file);
  let wiki = new WikiMemory(adapter, { ...llm, config: { indexStrategy: strategy } });
  await wiki.setup();

  const drainMs: number[] = [];
  let batch = 0;
  while (dbBytes(file) / 1048576 < targetMiB) {
    const nodes = Array.from({ length: NODES }, (_, i) => ({ id: `n${batch}_${i}`, type: '', title: text(6), body: text(BODY_WORDS) }));
    await adapter.withTransactionAsync((tx) => wiki.upsertGraph('e1', { sourceRef: `s${batch}.ts`, sourceHash: hashFor(batch), nodes, edges: [] }, tx));
    const t0 = performance.now();
    await wiki.syncSearchIndex('e1');
    drainMs.push(performance.now() - t0);
    batch++;
    sample();
    if (batch % 50 === 0) console.error(`batch ${batch} db=${mib(dbBytes(file))}MiB rss=${mib(process.memoryUsage().rss)}MiB`);
  }
  const buildPeak = peak;
  // Capture WAL-inclusive size before close: SQLite checkpoints and removes
  // the -wal sidecar when the last connection closes, so a later statSync
  // would under-report the size the build loop counted toward the target.
  const dbMiB = mib(dbBytes(file));
  close();

  peak = 0;
  ({ adapter, close } = openDb(file));
  wiki = new WikiMemory(adapter, { ...llm, config: { indexStrategy: strategy } });
  await wiki.setup();
  // Microtask-only adapters never yield a macrotask turn during setup, so the
  // 100 ms setInterval can miss the reopen phase. Sample explicitly.
  sample();
  const reopenPeak = peak;

  peak = 0;
  for (let i = 0; i < 1000; i++) {
    await wiki.__testAccess.searchService.searchKeyword(text(2), ['e1'], 10);
    if (i % 20 === 0) sample();
  }
  sample();
  const queryPeak = peak;
  close();
  clearInterval(timer);

  const decile = Math.max(1, Math.floor(drainMs.length / 10));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const first = mean(drainMs.slice(0, decile)), last = mean(drainMs.slice(-decile));
  const result = {
    strategy, targetMiB, dbMiB, batches: batch,
    buildPeakRssMiB: mib(buildPeak), reopenPeakRssMiB: mib(reopenPeak), queryPeakRssMiB: mib(queryPeak),
    drainMsFirstDecile: Math.round(first), drainMsLastDecile: Math.round(last),
    pass: Math.max(buildPeak, reopenPeak, queryPeak) < 512 * 1048576 && last <= 2 * first,
  };
  console.log(JSON.stringify(result, null, 2));
  if (out) writeFileSync(resolve(out), JSON.stringify(result, null, 2) + '\n');
  process.exit(result.pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });