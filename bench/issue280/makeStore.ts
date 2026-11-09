// bench/issue280/makeStore.ts
//
// Builds a synthetic store through the real engine: rows go in through the
// triggers and the keyword index is built by the engine's own drain.
// Usage: node bench/issue280/makeStore.ts --entries 1000000 [--out <path>]
import { statSync, rmSync, mkdirSync } from 'node:fs';
import { WikiMemory } from '../../packages/core/dist/index.mjs';
import { assertBenchPath, openBenchDb, storeDir } from './adapter.ts';

const P = 'llm_wiki_';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const entries = Number(arg('entries', '1000000'));
const out = arg('out', `${storeDir()}/issue280-${entries}.db`)!;
mkdirSync(storeDir(), { recursive: true });
assertBenchPath(out);
for (const suffix of ['', '-wal', '-shm']) rmSync(`${out}${suffix}`, { force: true });

const rand = mulberry32(280);
const syllables = ['ka', 'ro', 'mi', 'te', 'lu', 'sa', 'vin', 'dor', 'el', 'qua', 'zen', 'pho', 'tri', 'ber', 'ash', 'nul'];
const vocab = Array.from({ length: 5000 }, () => {
  const n = 2 + Math.floor(rand() * 3);
  let w = '';
  for (let i = 0; i < n; i++) w += syllables[Math.floor(rand() * syllables.length)];
  return w;
});
const text = (minChars: number): string => {
  let s = '';
  while (s.length < minChars) s += `${vocab[Math.floor(rand() * vocab.length)]} `;
  return s.trimEnd();
};

const started = performance.now();
const db = openBenchDb(out);
const wiki = new WikiMemory(db.adapter, {
  llmProvider: { generateText: async () => '{}' },
  config: { indexStrategy: 'fts5', setupBudgetMs: 3_600_000 },
});
await wiki.setup();

const cols = db.raw.prepare(`PRAGMA table_info(${P}entries)`).all() as Array<{
  name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
}>;
const known = new Set(['id', 'entity_id', 'title', 'body', 'tags', 'source_ref', 'created_at', 'updated_at']);
const extra = cols.filter((c) => !known.has(c.name) && c.notnull === 1 && c.dflt_value === null && c.pk === 0);
const names = [...known, ...extra.map((c) => c.name)];
const insert = db.raw.prepare(
  `INSERT INTO ${P}entries (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
const extras = extra.map((c) => (/INT|REAL/i.test(c.type) ? 0 : ''));
const now = Date.now();

const BATCH = 10_000;
const addEntries = db.raw.transaction((from: number, to: number) => {
  for (let i = from; i < to; i++) {
    const ref = i % 2 === 0 ? `dir/${i}.md` : `${i}.md`;
    insert.run(`f${i}`, `e${i % 100}`, text(40).slice(0, 40), text(1000), '[]', ref, now, now, ...extras);
  }
});
for (let i = 0; i < entries; i += BATCH) {
  addEntries(i, Math.min(i + BATCH, entries));
  if (i % 200_000 === 0) console.log(`entries ${i}/${entries} ${((performance.now() - started) / 1000).toFixed(0)}s`);
}

const sri = db.raw.prepare(
  `INSERT INTO ${P}source_ref_index (id, entity_id, source_hash, source_ref, created_at) VALUES (?, ?, ?, ?, ?)`);
const addSri = db.raw.transaction((from: number, to: number) => {
  for (let i = from; i < to; i++) sri.run(`s${i}`, `e${i % 100}`, `h${i}`, i % 2 === 0 ? `dir/${i}.md` : `${i}.md`, now);
});
const sriRows = Math.floor(entries / 10);
for (let i = 0; i < sriRows; i += BATCH) addSri(i, Math.min(i + BATCH, sriRows));
console.log(`inserted ${((performance.now() - started) / 1000).toFixed(0)}s; draining ledger`);

const pending = (): number => (db.raw.prepare(`SELECT count(*) AS n FROM ${P}fts_pending`).get() as { n: number }).n;
await wiki.setup();
while (pending() > 0) await wiki.syncSearchIndex();
db.raw.pragma('wal_checkpoint(TRUNCATE)');
const state = db.raw.prepare(`SELECT value FROM ${P}meta WHERE key = 'fts5_index_state'`).get() as { value: string };
const stored = (db.raw.prepare(`SELECT count(*) AS n FROM ${P}entries`).get() as { n: number }).n;
db.close();
console.log(JSON.stringify({
  out, entries: stored, sourceRefIndexRows: sriRows, state: state.value,
  bytes: statSync(out).size, buildSeconds: Math.round((performance.now() - started) / 1000),
}));
