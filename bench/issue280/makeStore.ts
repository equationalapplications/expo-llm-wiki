// bench/issue280/makeStore.ts
//
// issue280-B8 store generator (plan A8 Steps 1-2 / B8 Step 1). Builds a raw
// SQLite store shaped like the engine's, so the B-track open path
// (Fts5IndexStrategy.init) sees realistic scale without loading the engine.
//
// Rules (plan, A8): stores go under ISSUE280_STORE_DIR (default
// $HOME/issue280-stores), never /tmp (tmpfs undercounts disk cost 2-3x),
// never committed.
//
// Usage: tsx bench/issue280/makeStore.ts --rows 10000 --out <name>.db
//        [--bulk] (extra entries_fts rows via ' INTO ... SELECT' fan-out, so
//        a big FTS index builds fast) [--wal-checkpoint] (checkpoint+delete
//        the WAL at the end, like a clean last-close)
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

const P = 'llm_wiki_';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const rows = Number(arg('rows') ?? 10000);
const outArg = arg('out');
if (!outArg) throw new Error('--out <name>.db required');
const dir = process.env.ISSUE280_STORE_DIR ?? join(process.env.HOME ?? '.', 'issue280-stores');
const out = isAbsolute(outArg) ? outArg : join(dir, outArg);
mkdirSync(dir, { recursive: true });

const db = new Database(out);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Engine-shaped core: entries + meta, with the entries DDL mirroring
// packages/core/src/db/schema.ts exactly (setupDatabase's CREATE TABLE IF NOT
// EXISTS then skips it, and its column indexes resolve).
db.exec(`
CREATE TABLE ${P}entries (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL DEFAULT 'inferred',
  source_type TEXT NOT NULL DEFAULT 'librarian_inferred',
  source_hash TEXT,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  embedding TEXT,
  embedding_blob BLOB,
  okf_type TEXT,
  ontology_checked_at INTEGER,
  heal_checked_at INTEGER,
  lifecycle_status TEXT NOT NULL DEFAULT 'stable',
  stale_after INTEGER,
  generated_by TEXT,
  last_verified_at INTEGER,
  last_verified_by TEXT,
  okf_sources TEXT,
  okf_verified TEXT,
  okf_usage_window TEXT,
  embedding_failed_at INTEGER,
  embedding_failure_kind TEXT,
  embedding_attempts INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER,
  valid_to INTEGER,
  superseded_by TEXT,
  superseded_at INTEGER
);
CREATE INDEX ${P}entries_entity_idx ON ${P}entries(entity_id);
CREATE INDEX ${P}entries_source_ref_idx ON ${P}entries(entity_id, source_ref);
CREATE INDEX ${P}entries_source_hash_idx ON ${P}entries(entity_id, source_hash) WHERE source_hash IS NOT NULL;
CREATE INDEX ${P}entries_updated_idx ON ${P}entries(updated_at DESC);
CREATE TABLE ${P}meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// FTS tables + ledger exactly as fts5TablesDdl creates them.
db.exec(`
CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(
  id UNINDEXED, entity_id UNINDEXED, title, body, tags,
  tokenize = 'porter unicode61'
);
CREATE TABLE ${P}fts_map (
  fts_rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL
);
CREATE INDEX ${P}fts_map_entity ON ${P}fts_map(entity_id);
CREATE TABLE ${P}fts_pending (
  seq INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL,
  id TEXT NOT NULL
);
CREATE INDEX ${P}fts_pending_id ON ${P}fts_pending(id);
CREATE INDEX ${P}fts_pending_entity ON ${P}fts_pending(entity_id);
`);

// Live store: marker 'live', map covers every live row, ledger empty.
db.prepare(`INSERT INTO ${P}meta (key, value) VALUES ('fts5_index_state', 'live')`).run();

const seed = 1000; // a small seed batch keeps the SQL simple; explicit rowids keep inserts fast
const bulk = process.argv.includes('--bulk');
// Probe once, outside any transaction: not every better-sqlite3 build ships
// the series extension; fall back to the prepared-statement JS loop.
let hasSeries = true;
try {
  db.prepare('SELECT value FROM generate_series(1, 1)').get();
} catch {
  hasSeries = false;
}
const body =
  'Cedar transmission line sag correlates with ambient temperature above the conductor rating threshold.';
const insertEntries = db.prepare(
  `INSERT INTO ${P}entries (rowid, id, entity_id, title, body, tags, created_at, updated_at)
   VALUES (?, ?, 'e1', ?, ?, '[]', 1, 1)`,
);
const insertFts = db.prepare(
  `INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags)
   VALUES (?, ?, 'e1', ?, ?, '')`,
);
const insertMap = db.prepare(`INSERT INTO ${P}fts_map (fts_rowid, id, entity_id) VALUES (?, ?, 'e1')`);

const t0 = Date.now();
const insertRow = db.transaction((i: number) => {
  const id = `r${i}`;
  insertEntries.run(i, id, `cedar ${i}`, body);
  insertFts.run(i, id, `cedar ${i}`, body);
  insertMap.run(i, id);
});
db.transaction(() => {
  for (let i = 1; i <= Math.min(rows, seed); i++) insertRow(i);
  if (bulk && hasSeries) {
    const from = Math.min(rows, seed) + 1;
    db.exec(`
INSERT INTO ${P}entries (rowid, id, entity_id, title, body, tags, created_at, updated_at)
  SELECT rowid, 'r' || rowid, 'e1', 'cedar ' || rowid, '${body}', '[]', 1, 1
  FROM generate_series(${from}, ${rows});
INSERT INTO ${P}fts_map (fts_rowid, id, entity_id)
  SELECT rowid, 'r' || rowid, 'e1' FROM generate_series(${from}, ${rows});
`);
    // FTS fan-out from the map (fts_rowid = entries rowid by construction).
    db.exec(`
INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags)
  SELECT m.fts_rowid, e.id, e.entity_id, e.title, e.body, ''
  FROM ${P}entries e JOIN ${P}fts_map m ON m.id = e.id
  WHERE e.rowid >= ${from};
`);
  }
})();
if (!bulk || !hasSeries) {
  db.transaction(() => {
    for (let i = Math.min(rows, seed) + 1; i <= rows; i++) insertRow(i);
  })();
}
if (bulk && !hasSeries) console.log('note: no generate_series in this build; used the prepared-statement loop');

// Triggers AFTER the data load, exactly like a converged engine store: the
// ledger stays empty (loads never fed it) and init()'s intact-check (FTS
// tables + triggers + tokenizer) passes on the fast path.
db.exec(`
CREATE TRIGGER IF NOT EXISTS ${P}entries_fts_ai AFTER INSERT ON ${P}entries BEGIN
  INSERT INTO ${P}fts_pending (entity_id, id) VALUES (NEW.entity_id, NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS ${P}entries_fts_au
AFTER UPDATE OF id, entity_id, title, body, tags, deleted_at ON ${P}entries BEGIN
  INSERT INTO ${P}fts_pending (entity_id, id) VALUES (OLD.entity_id, OLD.id);
  INSERT INTO ${P}fts_pending (entity_id, id)
    SELECT NEW.entity_id, NEW.id WHERE NEW.id <> OLD.id OR NEW.entity_id <> OLD.entity_id;
END;
CREATE TRIGGER IF NOT EXISTS ${P}entries_fts_ad AFTER DELETE ON ${P}entries BEGIN
  INSERT INTO ${P}fts_pending (entity_id, id) VALUES (OLD.entity_id, OLD.id);
END;`);

if (process.argv.includes('--wal-checkpoint')) {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

const size = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count *
  (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
db.close();
const mb = (size / (1024 * 1024)).toFixed(1);
console.log(`made ${out}: ${rows} rows, ${mb} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
