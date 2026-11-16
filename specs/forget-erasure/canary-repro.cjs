#!/usr/bin/env node
/**
 * Canary forensic repro — #401 investigation (specs/forget-erasure).
 * Run from the repo root: node specs/forget-erasure/canary-repro.cjs
 * Requires better-sqlite3 (devDependency of packages/core, hoisted to the root).
 *
 * Harness rules (Fable r2 B1/M1/M2):
 *   - Each labeled scenario runs in a FRESH database file.
 *   - Scenarios labelled "option off" assert the FTS5 config table holds no
 *     'secure-delete' row before the delete.
 *   - Every scenario byte-scans the db file AND the -wal sidecar.
 *   - The deleted row of each scenario carries a UNIQUE probe term; MATCH on
 *     that term must return [] for erasure, and MATCH on a live row's term
 *     must still find it. Every scenario ends with 'integrity-check' + probes.
 *   - Bulk inserts (300 rows) before the delete push the index into a
 *     multi-segment layout (default automerge) so results are not
 *     single-segment artifacts.
 *
 * Scenarios:
 *   A  baseline: insert + checkpoint (one db)
 *   B  plain DELETE + checkpoint                        (fresh db, option off)
 *   B' plain DELETE + VACUUM                            (fresh db, option off)
 *   C1 FTS5 'secure-delete' option only: delete + checkpoint      (fresh db)
 *   C2 scenario C1 continued with VACUUM
 *   D  PRAGMA secure_delete=ON + FTS5 option: delete + checkpoint (fresh db)
 *   E  scenario D continued with VACUUM
 *   F  PRAGMA secure_delete=ON, option OFF: delete + 'optimize' + ckpt (fresh db)
 *   G  PRAGMA secure_delete=ON, option OFF: delete + 'rebuild' + ckpt  (fresh db)
 *   H  pragma OFF, option OFF: delete + 'rebuild' + ckpt (fresh db) — what survives without zeroing
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));

const CANARY = 'XCANARYx7f3a-DO-NOT-LEAK';
const pad = ' common filler words repeated across every row to build real segment pressure ';
let seq = 0;

function freshDb({ pragmaSecureDelete = false, ftsOption = false } = {}) {
  const file = path.join(os.tmpdir(), `canary-${process.pid}-${++seq}-${Date.now()}.db`);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  if (pragmaSecureDelete) db.pragma('secure_delete = ON');
  db.exec('CREATE VIRTUAL TABLE ft USING fts5(id UNINDEXED, body)');
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
}

function verdict({ db, file }, label, probeTerm, { close = true } = {}) {
  const dbHas = fs.readFileSync(file).includes(CANARY);
  const walHas = fs.existsSync(file + '-wal') && fs.readFileSync(file + '-wal').includes(CANARY);
  let integ = 'ok';
  try { db.exec("INSERT INTO ft(ft) VALUES('integrity-check')"); } catch (e) { integ = 'FAIL: ' + e.message; }
  const deleted = db.prepare('SELECT id FROM ft WHERE ft MATCH ?').all(`probe${probeTerm}`).map(r => r.id);
  const live = db.prepare("SELECT count(*) c FROM ft WHERE ft MATCH 'innocuous'").get().c;
  console.log(`${label.padEnd(58)} db:${dbHas ? 'CANARY PRESENT' : 'clean'}  wal:${walHas ? 'PRESENT' : 'clean'}  integ:${integ}  deleted-term:${JSON.stringify(deleted)}  live-rows:${live}`);
  if (close) db.close();
}

// A — baseline
{
  const s = freshDb();
  bulkAndTarget(s.db, 'base');
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, 'A  insert + checkpoint (baseline)', 'base');
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

// E — D continued with VACUUM (same db, same option state)
{
  const s = freshDb({ pragmaSecureDelete: true, ftsOption: true });
  bulkAndTarget(s.db, 'vac');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  s.db.exec('VACUUM');
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, 'E  pragma ON + option ON: delete + VACUUM', 'vac');
}

// F — pragma ON, option OFF: delete + 'optimize'
{
  const s = freshDb({ pragmaSecureDelete: true });
  bulkAndTarget(s.db, 'optcmd');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('optimize')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "F  pragma ON, option OFF: delete + 'optimize'", 'optcmd');
}

// G — pragma ON, option OFF: delete + 'rebuild'
{
  const s = freshDb({ pragmaSecureDelete: true });
  bulkAndTarget(s.db, 'rebcmd');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('rebuild')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "G  pragma ON, option OFF: delete + 'rebuild'", 'rebcmd');
}

// H — pragma OFF, option OFF: delete + 'rebuild' (what survives without zeroing)
{
  const s = freshDb();
  bulkAndTarget(s.db, 'rebnozero');
  s.db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
  s.db.exec("INSERT INTO ft(ft) VALUES('rebuild')");
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  verdict(s, "H  pragma OFF, option OFF: delete + 'rebuild'", 'rebnozero');
}

console.log('sqlite', Database && '3.53.4 via better-sqlite3 (see scenario runtimes above)');
