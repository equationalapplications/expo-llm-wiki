import { describe, it, expect, vi } from 'vitest';
import { createExpoAdapter } from '../src/adapter';

/** Minimal mock of expo-sqlite's SQLiteDatabase interface */
function makeDb() {
  return {
    execAsync: vi.fn().mockResolvedValue(undefined),
    runAsync: vi.fn().mockResolvedValue({ changes: 1, lastInsertRowId: 42 }),
    getAllAsync: vi.fn().mockResolvedValue([{ id: 1 }]),
    getFirstAsync: vi.fn().mockResolvedValue({ id: 1 }),
    withTransactionAsync: vi.fn().mockImplementation(async (fn: () => Promise<void>) => { await fn(); }),
    closeAsync: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createExpoAdapter', () => {
  it('forwards execAsync', async () => {
    const db = makeDb();
    const adapter = createExpoAdapter(db as any);
    await adapter.execAsync('CREATE TABLE t (id INTEGER)');
    expect(db.execAsync).toHaveBeenCalledWith('CREATE TABLE t (id INTEGER)');
  });

  it('forwards getAllAsync with params', async () => {
    const db = makeDb();
    const adapter = createExpoAdapter(db as any);
    await adapter.getAllAsync('SELECT * FROM t WHERE id = ?', [1]);
    expect(db.getAllAsync).toHaveBeenCalledWith('SELECT * FROM t WHERE id = ?', [1]);
  });

  it('forwards getAllAsync with no params', async () => {
    const db = makeDb();
    const adapter = createExpoAdapter(db as any);
    await adapter.getAllAsync('SELECT * FROM t');
    expect(db.getAllAsync).toHaveBeenCalledWith('SELECT * FROM t', []);
  });

  it('forwards getFirstAsync with params', async () => {
    const db = makeDb();
    const adapter = createExpoAdapter(db as any);
    const result = await adapter.getFirstAsync('SELECT * FROM t WHERE id = ?', [1]);
    expect(db.getFirstAsync).toHaveBeenCalledWith('SELECT * FROM t WHERE id = ?', [1]);
    expect(result).toEqual({ id: 1 });
  });

  it('forwards getFirstAsync with no params', async () => {
    const db = makeDb();
    const adapter = createExpoAdapter(db as any);
    await adapter.getFirstAsync('SELECT * FROM t');
    expect(db.getFirstAsync).toHaveBeenCalledWith('SELECT * FROM t', []);
  });

  it('transforms runAsync result to { changes, lastInsertRowId }', async () => {
    const db = makeDb();
    db.runAsync.mockResolvedValue({ changes: 3, lastInsertRowId: 99 });
    const adapter = createExpoAdapter(db as any);
    const result = await adapter.runAsync('INSERT INTO t VALUES (?)', ['x']);
    expect(result).toEqual({ changes: 3, lastInsertRowId: 99 });
    expect(db.runAsync).toHaveBeenCalledWith('INSERT INTO t VALUES (?)', ['x']);
  });

  it('runAsync uses empty array when no params supplied', async () => {
    const db = makeDb();
    const adapter = createExpoAdapter(db as any);
    await adapter.runAsync('DELETE FROM t');
    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM t', []);
  });

  it('withTransactionAsync captures and returns the inner value', async () => {
    const db = makeDb();
    // expo-sqlite's withTransactionAsync only accepts () => Promise<void>, so
    // createExpoAdapter must capture the result and return it.
    db.withTransactionAsync.mockImplementation(async (fn: () => Promise<void>) => {
      await fn(); // return value discarded (expo-sqlite ignores it)
    });
    const adapter = createExpoAdapter(db as any);
    const result = await adapter.withTransactionAsync(async () => 'captured-result');
    expect(result).toBe('captured-result');
  });

  it('withTransactionAsync propagates errors thrown inside fn', async () => {
    const db = makeDb();
    db.withTransactionAsync.mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    });
    const adapter = createExpoAdapter(db as any);
    await expect(
      adapter.withTransactionAsync(async () => { throw new Error('tx-error'); })
    ).rejects.toThrow('tx-error');
  });

  it('forwards closeAsync', async () => {
    const db = makeDb();
    const adapter = createExpoAdapter(db as any);
    await adapter.closeAsync();
    expect(db.closeAsync).toHaveBeenCalledOnce();
  });
});
