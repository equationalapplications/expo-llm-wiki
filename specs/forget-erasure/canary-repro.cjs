#!/usr/bin/env node
/**
 * Canary forensic repro — #401 investigation (specs/forget-erasure).
 * Run from the repo root: node specs/forget-erasure/canary-repro.cjs
 * Requires better-sqlite3 (devDependency of packages/core, hoisted to the root).
 *
 * Scenarios (each byte-scans the db file and the -wal sidecar):
 *   A  insert + checkpoint (baseline)
 *   B  plain DELETE + checkpoint                 (≈ current engine behavior)
 *   C1 FTS5 'secure-delete' option only, delete + checkpoint (no VACUUM)
 *   C2 scenario C1 continued with VACUUM
 *   B' plain DELETE + VACUUM (no pragma, no option) — single-segment index caveat, see investigation §2
 *   D  PRAGMA secure_delete=ON + FTS5 option, delete + checkpoint (no VACUUM)
 *   E  scenario D continued with VACUUM
 *   F  PRAGMA secure_delete=ON + plain delete + FTS 'optimize' + checkpoint
 *   G  PRAGMA secure_delete=ON + plain delete + FTS 'rebuild' + checkpoint
 * F/G end with 'integrity-check' and MATCH probes (deleted term, live term).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));

const CANARY = 'XCANARYx7f3a-DO-NOT-LEAK';
const file = path.join(os.tmpdir(), `canary-${process.pid}-${Date.now()}.db`);
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.exec('CREATE VIRTUAL TABLE ft USING fts5(id UNINDEXED, body)');

const scan = (label) => {
  const dbHas = fs.readFileSync(file).includes(CANARY);
  const walHas = fs.existsSync(file + '-wal') && fs.readFileSync(file + '-wal').includes(CANARY);
  console.log(`${label.padEnd(52)} db:${dbHas ? 'CANARY PRESENT' : 'clean'}  wal:${walHas ? 'CANARY PRESENT' : 'clean'}`);
};
const integ = () => {
  try { db.exec("INSERT INTO ft(ft) VALUES('integrity-check')"); return 'ok'; }
  catch (e) { return 'FAIL: ' + e.message; }
};

// A — baseline
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e1', CANARY + ' padding words to make the row realistic in size for the experiment');
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e2', 'innocuous second row so the index stays functional');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('A  insert + checkpoint');

// B — plain delete (current engine behavior class)
db.prepare('DELETE FROM ft WHERE id = ?').run('e1');
db.pragma('wal_checkpoint(TRUNCATE)');
scan("B  plain DELETE + checkpoint");
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e1', CANARY + ' reinserted for the secure-delete scenarios');
db.pragma('wal_checkpoint(TRUNCATE)');

// C1 — FTS5 option only, no VACUUM
db.exec("INSERT INTO ft(ft, rank) VALUES('secure-delete', 1)");
db.prepare('DELETE FROM ft WHERE id = ?').run('e1');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('C1 FTS5 option only, delete + checkpoint');
// C2 — same state + VACUUM
db.exec('VACUUM');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('C2 FTS5 option only + VACUUM');

// B' — plain delete + VACUUM, no pragma, no option (single-segment index)
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e3', CANARY + ' reinserted for the vacuum-only scenario');
db.prepare('DELETE FROM ft WHERE id = ?').run('e3');
db.exec('VACUUM');
db.pragma('wal_checkpoint(TRUNCATE)');
scan("B' plain DELETE + VACUUM (no pragma/option)");

// D — both mechanisms, no VACUUM
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e4', CANARY + ' reinserted under both mechanisms');
db.pragma('secure_delete = ON');
db.prepare('DELETE FROM ft WHERE id = ?').run('e4');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('D  pragma ON + FTS5 option, delete + ckpt');

// E — both mechanisms + VACUUM
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e5', CANARY + ' reinserted for the vacuum scenario');
db.prepare('DELETE FROM ft WHERE id = ?').run('e5');
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('E  pragma ON + FTS5 option + VACUUM');

// F — compact-time mechanism with 'optimize'
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e6', CANARY + ' reinserted for the optimize scenario');
db.prepare('DELETE FROM ft WHERE id = ?').run('e6');
db.exec("INSERT INTO ft(ft) VALUES('optimize')");
db.pragma('wal_checkpoint(TRUNCATE)');
scan("F  pragma ON + delete + 'optimize'");
console.log('   integrity:', integ(),
  '| MATCH deleted-term:', JSON.stringify(db.prepare("select id from ft where ft match 'padding'").all()),
  '| MATCH live-term:', JSON.stringify(db.prepare("select id from ft where ft match 'innocuous'").all()));

// G — compact-time mechanism with 'rebuild'
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e7', CANARY + ' reinserted for the rebuild scenario');
db.prepare('DELETE FROM ft WHERE id = ?').run('e7');
db.exec("INSERT INTO ft(ft) VALUES('rebuild')");
db.pragma('wal_checkpoint(TRUNCATE)');
scan("G  pragma ON + delete + 'rebuild'");
console.log('   integrity:', integ(),
  '| MATCH deleted-term:', JSON.stringify(db.prepare("select id from ft where ft match 'padding'").all()),
  '| MATCH live-term:', JSON.stringify(db.prepare("select id from ft where ft match 'innocuous'").all()));

console.log('sqlite', db.prepare('select sqlite_version() v').get().v);
db.close();
