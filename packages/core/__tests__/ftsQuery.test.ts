// packages/core/__tests__/ftsQuery.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { buildFtsMatchQuery } from '../src/services/search/ftsQuery';

describe('buildFtsMatchQuery', () => {
  it('quotes each token, adds prefix star, ORs them', () => {
    expect(buildFtsMatchQuery('Cedar trees')).toBe('"cedar"* OR "trees"*');
  });

  it('dedupes tokens and keeps first-seen order', () => {
    expect(buildFtsMatchQuery('b a B')).toBe('"b"* OR "a"*');
  });

  it('returns null when no letter/number tokens remain', () => {
    for (const q of ['', '   ', '"', '-', '()', '***', ':']) {
      expect(buildFtsMatchQuery(q)).toBeNull();
    }
  });

  it('keeps unicode letters and digits', () => {
    expect(buildFtsMatchQuery('café 42')).toBe('"café"* OR "42"*');
  });

  it('never produces a MATCH syntax error for hostile input', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'porter unicode61')`);
    db.exec(`INSERT INTO t VALUES ('he runs fast'), ('near and or not')`);
    const hostile = ['"', 'a -b', 'col:x', 'NEAR(', 'AND', 'OR NOT', 'x*"y', '😀 run', "it's", '^a', '{a b}'];
    for (const q of hostile) {
      const m = buildFtsMatchQuery(q);
      if (m === null) continue;
      expect(() => db.prepare('SELECT x FROM t WHERE t MATCH ?').all(m)).not.toThrow();
    }
  });

  it('porter stemming applies to prefix queries (verified 2026-10-06)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'porter unicode61')`);
    db.exec(`INSERT INTO t VALUES ('he runs fast')`);
    const rows = db.prepare('SELECT x FROM t WHERE t MATCH ?').all(buildFtsMatchQuery('running')!);
    expect(rows).toHaveLength(1);
  });
});
