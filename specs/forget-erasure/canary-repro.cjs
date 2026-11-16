#!/usr/bin/env node
/**
 * Canary forensic repro — #401 investigation (specs/forget-erasure).
 * Run from the repo root: node specs/forget-erasure/canary-repro.cjs
 * Requires better-sqlite3 (devDependency of packages/core, hoisted to the root).
 *
 * Harness rules (Fable r2 B1/M1/M2 + Fable r3 BLOCKER rework):
 *   - Each labeled scenario runs in a FRESH database file.
 *   - Scenarios labelled "option off" assert the FTS5 config table holds no
 *     'secure-delete' row before the delete.
 *   - The canary is a SINGLE lowercase alphanumeric token (zxq7f3a9k): it is
 *     byte-identical under the unicode61 AND the porter unicode61 tokenizer,
 *     so a byte scan sees every surface it can live on. Two harness assertions
 *     pin this per scenario: fts5vocab holds the exact token, and MATCH finds
 *     exactly the TARGET row by the token, BEFORE the delete.
 *   - Every scenario scans the db file AND the -wal sidecar for the token,
 *     AND separately scans every %_data block (the postings/segment surface)
 *     so row-content erasure and term-bytes erasure are reported as distinct
 *     columns. MATCH on the deleted row's unique probe term is reported as
 *     "deleted-term" but is NOT evidence of byte erasure (FTS5 hides deleted
 *     rowids by design); the %_data column is the postings verdict.
 *   - segpages counts %_data rows that are segment pages (structure = id 1,
 *     config = id 10); >1 proves the index is not a single-segment artifact.
 *   - Every scenario ends with 'integrity-check' + probes.
 *   - Bulk inserts (300 rows) before the delete push the index into a
 *     multi-segment layout (default automerge).
 *
 * Scenarios (all fresh db unless noted):
 *   A   baseline: insert + checkpoint (unicode61)
 *   B   plain DELETE + checkpoint                        (option off)
 *   B'  plain DELETE + VACUUM                            (pragma off, option off)
 *   C1  FTS5 'secure-delete' option only: delete + checkpoint
 *   C2  scenario C1 continued with VACUUM
 *   D   PRAGMA secure_delete=ON + FTS5 option: delete + checkpoint
 *   E   D's config: delete + VACUUM (fresh db, same config as D)
 *   F   pragma ON, option OFF: delete + 'optimize' + ckpt   (unicode61)
 *   G   pragma ON, option OFF: delete + 'rebuild' + ckpt    (unicode61)
 *   H   pragma OFF, option OFF: delete + 'rebuild' + ckpt   (unicode61)
 *   F2  pragma ON, option OFF: delete + 'optimize' + ckpt   (porter unicode61 — engine tokenizer)
 *   G2  pragma ON, option OFF: delete + 'rebuild' + ckpt    (porter unicode61)
 *   H2  pragma OFF, option OFF: delete + 'rebuild' + ckpt   (porter unicode61)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));

// Single lowercase alphanumeric token: identical under unicode61 and porter
// unicode61 (no separators to split on, no case to fold, not a stemmable word).
const CANARY = 'zxq7f3a9k';
const pad = ' common filler words repeated across every row to build real segment pressure ';
let seq = 0;

function freshDb({ pragmaSecureDelete = false, ftsOption = false, porter = false } = {}) {
  const file = path.join(os.tmpdir(), `canary-${process.pid}-${++seq}-${Date.now()}.db`);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  if (pragmaSecureDelete) db.pragma('secure_delete = ON');
  const tok = porter ? `, tokenize = 'porter unicode61'` : '';
  db.exec(`CREATE VIRTUAL TABLE ft USING fts5(id UNINDEXED, body${tok})`);
  db.exec(`CREATE VIRTUAL TABLE ftv USING fts5vocab(ft, 'row')`);
  if (ftsOption) db.exec("INSERT INTO ft(ft, rank) VALUES('secure-delete', 1)");
  // Harness assertion: the config table must match the requested option state.
  const cfg = db.prepare("SELECT * FROM ft_config WHERE k = 'secure-delete'").all();
  const on = cfg.length > 0 && Number(cfg[0].v) === 1;
  if (on !== ftsOption) throw new Error(`harness broken: secure-delete option is ${on}, expected ${ftsOption}`);
  return { db, file };
}

function bulkAndTarget(db, probeTerm) {
  const ins = db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)');
  for (let i = 0; i < 300; i++) ins.run(`f${i}`, `innocuous row ${i} fillertext${i}${pad}`);
  ins.run('TARGET', CANARY + ` probe${probeTerm} unique tokens for the deleted row ${probeTerm}`);
  // Harness assertion 1: the canary is a real, tokenizer-stable term.
  const vocab = db.prepare('SELECT rowid FROM ftv WHERE term = ?').all(CANARY);
  if (vocab.length !== 1) throw new Error(`harness broken: canary not a single stable term in fts5vocab: ${JSON.stringify(vocab)}`);
  // Harness assertion 2: MATCH by the canary finds exactly the TARGET row (pre-delete).
  const hit = db.prepare('SELECT id FROM ft WHERE ft MATCH ?').all(CANARY).map((r) => r.id);
  if (hit.length !== 1 || hit[0] !== 'TARGET') throw new Error(`harness broken: pre-delete MATCH on canary returned ${JSON.stringify(hit)}`);
}

function verdict({ db, file }, label, probeTerm, { close = true } = {}) {
  const dbHas = fs.readFileSync(file).includes(CANARY);
  const walHas = fs.existsSync(file + '-wal') && fs.readFileSync(file + '-wal').includes(CANARY);
  // Postings surface: scan every %_data block for the token's bytes.
  let postings = 'clean';
  for (const row of db.prepare('SELECT block FROM ft_data').iterate()) {
    if (Buffer.from(row.block).includes(CANARY)) { postings = 'CANARY PRESENT'; break; }
  }
  // Segment-page count (structure record = id 1, config = id 10): >1 proves a
  // non-trivial, multi-page index layout.
  const segPages = db.prepare('SELECT count(*) c FROM ft_data WHERE id <> 1 AND id <> 10').get().c;
  let integ = 'ok';
  try { db.exec("INSERT INTO ft(ft) VALUES('integrity-check')"); } catch (e) { integ = 'FAIL: ' + e.message; }
  const deleted = db.prepare('SELECT id FROM ft WHERE ft MATCH ?').all(`probe${probeTerm}`).map(r => r.id);
  const live = db.prepare("SELECT count(*) c FROM ft WHERE ft MATCH 'innocuous'").get().c;
  console.log(
    `${label.padEnd(58)} db:${dbHas ? 'CANARY PRESENT' : 'clean'}  postings:${postings}  wal:${walHas ? 'PRESENT' : 'clean'}  integ:${integ}  segpages:${segPages}  deleted-term:${JSON.stringify(deleted)}  live-rows:${live}`
  );
  if (close) db.close();
}

// A — baseline (unicode61)
{
  const s = freshDb();
  bulkAndTarget(s.db, 'base');
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, 'A  insert + checkpoint (baseline, unicode61)', 'base');
}

// B — plain delete + checkpoint, option off
{
  const s = freshDb();
  bulkAndTarget(s.db, 'plain');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, 'B  plain DELETE + checkpoint (option off)', 'plain');
}

// B' — plain delete + VACUUM, option off, pragma off
{
  const s = freshDb();
  bulkAndTarget(s.db, 'vaconly');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec('VACUUM');
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "B' plain DELETE + VACUUM (pragma off, option off)", 'vaconly');
}

// C1/C2 — FTS5 option only
{
  const s = freshDb({ ftsOption: true });
  bulkAndTarget(s.db, 'optonly');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, 'C1 FTS5 option only: delete + checkpoint', 'optonly', { close: false });
  s.db.exec('VACUUM');
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, 'C2 FTS5 option only + VACUUM', 'optonly');
}

// D — pragma ON + option ON, delete + checkpoint
{
  const s = freshDb({ pragmaSecureDelete: true, ftsOption: true });
  bulkAndTarget(s.db, 'both');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, 'D  pragma ON + option ON: delete + checkpoint', 'both');
}

// E — D's config, delete + VACUUM (fresh db per harness rule)
{
  const s = freshDb({ pragmaSecureDelete: true, ftsOption: true });
  bulkAndTarget(s.db, 'vac');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  s.db.exec('VACUUM');
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "E  pragma ON + option ON: delete + VACUUM (D's config)", 'vac');
}

// F — pragma ON, option OFF: delete + 'optimize' (unicode61)
{
  const s = freshDb({ pragmaSecureDelete: true });
  bulkAndTarget(s.db, 'optcmd');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('optimize')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "F  pragma ON, option OFF: delete + 'optimize' (u61)", 'optcmd');
}

// G — pragma ON, option OFF: delete + 'rebuild' (unicode61)
{
  const s = freshDb({ pragmaSecureDelete: true });
  bulkAndTarget(s.db, 'rebcmd');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('rebuild')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "G  pragma ON, option OFF: delete + 'rebuild' (u61)", 'rebcmd');
}

// H — pragma OFF, option OFF: delete + 'rebuild' (unicode61; what survives without zeroing)
{
  const s = freshDb();
  bulkAndTarget(s.db, 'rebnozero');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('rebuild')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "H  pragma OFF, option OFF: delete + 'rebuild' (u61)", 'rebnozero');
}

// F2 — porter unicode61 (the engine tokenizer): pragma ON, option OFF, 'optimize'
{
  const s = freshDb({ pragmaSecureDelete: true, porter: true });
  bulkAndTarget(s.db, 'poptcmd');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('optimize')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "F2 pragma ON, option OFF: delete + 'optimize' (porter)", 'poptcmd');
}

// G2 — porter unicode61: pragma ON, option OFF, 'rebuild'
{
  const s = freshDb({ pragmaSecureDelete: true, porter: true });
  bulkAndTarget(s.db, 'prebcmd');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('rebuild')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "G2 pragma ON, option OFF: delete + 'rebuild' (porter)", 'prebcmd');
}

// H2 — porter unicode61: pragma OFF, option OFF, 'rebuild'
{
  const s = freshDb({ porter: true });
  bulkAndTarget(s.db, 'prebnozero');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('rebuild')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "H2 pragma OFF, option OFF: delete + 'rebuild' (porter)", 'prebnozero');
}

{
  const d = new Database(':memory:');
  const sv = d.prepare('SELECT sqlite_version() AS v').get().v;
  let bv = 'unknown';
  try { bv = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3', 'package.json')).version; } catch {}
  console.log(`sqlite ${sv} via better-sqlite3 ${bv} (reported by SELECT sqlite_version(), not hard-coded)`);
  d.close();
}
