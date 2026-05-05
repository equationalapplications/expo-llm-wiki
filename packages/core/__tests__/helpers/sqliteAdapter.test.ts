import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './sqliteAdapter';
import { parseEmbedding } from '../../src/utils/embedding';

describe('sqliteAdapter', () => {
  it('runs basic SQL and returns rows', async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    await db.runAsync(`INSERT INTO t (name) VALUES (?)`, ['alice']);
    await db.runAsync(`INSERT INTO t (name) VALUES (?)`, ['bob']);
    const rows = await db.getAllAsync<{ id: number; name: string }>(`SELECT * FROM t ORDER BY id`);
    expect(rows).toEqual([{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }]);
    const first = await db.getFirstAsync<{ name: string }>(`SELECT name FROM t WHERE id = ?`, [1]);
    expect(first?.name).toBe('alice');
  });

  it('supports FTS5 with porter tokenizer', async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='porter unicode61')`);
    await db.runAsync(`INSERT INTO fts(body) VALUES (?)`, ['User runs every morning']);
    const rows = await db.getAllAsync<{ body: string }>(`SELECT * FROM fts WHERE fts MATCH ?`, ['running']);
    expect(rows.length).toBe(1);
  });

  it('rolls back failed transactions', async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    await expect(
      db.withTransactionAsync(async () => {
        await db.runAsync(`INSERT INTO t (id) VALUES (?)`, [1]);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const rows = await db.getAllAsync<{ id: number }>(`SELECT * FROM t`);
    expect(rows.length).toBe(0);
  });

  it('round-trips a Uint8Array BLOB bind parameter (embedFact adapter contract)', async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)`);

    // Write a Float32Array as Uint8Array — same as embedFact does
    const vec = new Float32Array([1.0, -0.5, 0.25]);
    const blob = new Uint8Array(vec.buffer);
    await db.runAsync(`INSERT INTO t (data) VALUES (?)`, [blob]);

    // Read it back; the driver must return a Uint8Array (or Buffer, which IS a Uint8Array)
    const row = await db.getFirstAsync<{ data: Uint8Array | null }>(`SELECT data FROM t WHERE id = 1`);
    expect(row?.data).not.toBeNull();
    expect(row!.data).toBeInstanceOf(Uint8Array);
    expect(row!.data!.byteLength).toBe(12); // 3 × 4 bytes

    // parseEmbedding must recover the original float values from the adapter output
    const parsed = parseEmbedding(row!.data, null);
    expect(parsed).not.toBeNull();
    expect(Array.from(parsed!)).toEqual([1.0, -0.5, 0.25]);
  });
});
