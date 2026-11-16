#!/usr/bin/env node
/**
 * Canary forensic repro — #401 investigation (specs/forget-erasure).
 * Run from the repo root: node specs/forget-erasure/canary-repro.cjs
 * Requires better-sqlite3 (devDependency of packages/core).
 *
 * Scenarios:
 *   A  insert + checkpoint (baseline)
 *   B  plain DELETE + checkpoint            (≈ current engine behavior)
 *   C1 FTS5 'secure-delete' option only, delete + checkpoint (no VACUUM)
 *   C2 scenario C1 continued with VACUUM
 *   D  PRAGMA secure_delete=ON + FTS5 option, delete + checkpoint (no VACUUM)
 *   E  scenario D continued with VACUUM
 * Byte-scans the database file and the -wal sidecar after every step.
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
  console.log(`${label.padEnd(46)} db:${dbHas ? 'CANARY PRESENT' : 'clean'}  wal:${walHas ? 'CANARY PRESENT' : 'clean'}`);
};

// A — baseline
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e1', CANARY + ' padding words to make the row realistic in size for the experiment');
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e2', 'innocuous second row so the index stays functional');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('A  insert + checkpoint');

// B — plain delete (current engine behavior class)
db.prepare('DELETE FROM ft WHERE id = ?').run('e1');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('B  plain DELETE + checkpoint');
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e1', CANARY + ' reinserted for the secure-delete scenarios');
db.pragma('wal_checkpoint(TRUNCATE)');

// C1 — FTS5 option only, no VACUUM
db.exec("INSERT INTO ft(ft, rank) VALUES('secure-delete', 1)");
db.prepare('DELETE FROM ft WHERE id = ?').run('e1');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('C1 FTS5 option only, delete + checkpoint');
scan('C2 (same state) + VACUUM');
db.exec('VACUUM');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('C2 FTS5 option only + VACUUM');

// D — both mechanisms, no VACUUM
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e3', CANARY + ' reinserted under both mechanisms');
db.pragma('secure_delete = ON');
db.prepare('DELETE FROM ft WHERE id = ?').run('e3');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('D  pragma ON + FTS5 option, delete + ckpt');

// E — both mechanisms + VACUUM
db.prepare('INSERT INTO ft(id, body) VALUES(?, ?)').run('e4', CANARY + ' reinserted for the vacuum scenario');
db.prepare('DELETE FROM ft WHERE id = ?').run('e4');
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.pragma('wal_checkpoint(TRUNCATE)');
scan('E  pragma ON + FTS5 option + VACUUM');

console.log('sqlite', db.prepare('select sqlite_version() v').get().v);
console.log('MATCH still functional:', JSON.stringify(db.prepare("select id from ft where ft match 'innocuous'").all()));
db.close();
