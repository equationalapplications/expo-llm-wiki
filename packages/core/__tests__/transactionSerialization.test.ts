import { describe, it, expect } from 'vitest';
import { extractSqliteCode, isDriverError } from '../src/db/serializedAdapter';
import { WikiTransactionError } from '../src/types';
import { guardReentrancy, withSerializedTransactions } from '../src/db/serializedAdapter';
import type { SQLiteAdapter } from '../src/types';

function fakeAdapter(): SQLiteAdapter {
  return {
    execAsync: async () => {},
    runAsync: async () => ({ changes: 0, lastInsertRowId: 0 }),
    getAllAsync: async () => [],
    getFirstAsync: async () => null,
    withTransactionAsync: async (fn) => fn(fakeAdapter()),
    closeAsync: async () => {},
  };
}

describe('extractSqliteCode', () => {
  it('reads the string SQLITE_ code from better-sqlite3 / node:sqlite errors', () => {
    expect(extractSqliteCode({ code: 'SQLITE_BUSY' })).toBe('SQLITE_BUSY');
  });

  it('parses the numeric code from an expo-sqlite message', () => {
    expect(extractSqliteCode({ message: 'Error code 1: cannot start a transaction within a transaction' }))
      .toBe('SQLITE_1');
  });

  it('returns undefined for a non-driver error', () => {
    expect(extractSqliteCode(new Error('validation failed'))).toBeUndefined();
    expect(extractSqliteCode(null)).toBeUndefined();
    expect(extractSqliteCode('nope')).toBeUndefined();
  });
});

describe('isDriverError', () => {
  it('is true only when a SQLite code can be extracted', () => {
    expect(isDriverError({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isDriverError({ message: 'Error code 5: database is locked' })).toBe(true);
    expect(isDriverError(new Error('validation failed'))).toBe(false);
  });
});

describe('WikiTransactionError', () => {
  it('carries the cause and lifts the SQLite code to the top level', () => {
    const cause = { code: 'SQLITE_BUSY', message: 'db is busy' };
    const err = new WikiTransactionError('Transaction failed', { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WikiTransactionError');
    expect(err.cause).toBe(cause);
    expect(err.sqliteErrorCode).toBe('SQLITE_BUSY');
  });

  it('leaves sqliteErrorCode undefined when the code cannot be parsed', () => {
    const err = new WikiTransactionError('Transaction failed', { cause: new Error('opaque') });
    expect(err.sqliteErrorCode).toBeUndefined();
  });
});

describe('guardReentrancy', () => {
  it('throws synchronously when withTransactionAsync is called on the guarded handle', () => {
    const guarded = guardReentrancy(fakeAdapter());
    expect(() => guarded.withTransactionAsync(async () => 1))
      .toThrow(/Nested withTransactionAsync is not supported/);
  });

  it('leaves non-transactional methods intact', async () => {
    const guarded = guardReentrancy(fakeAdapter());
    await expect(guarded.getAllAsync('SELECT 1')).resolves.toEqual([]);
  });
});

/** Adapter that tracks open-transaction depth and runs callbacks with a real BEGIN counter. */
function instrumentedAdapter() {
  const state = { depth: 0, maxDepth: 0 };
  const adapter: SQLiteAdapter = {
    execAsync: async () => {},
    runAsync: async () => ({ changes: 0, lastInsertRowId: 0 }),
    getAllAsync: async () => [],
    getFirstAsync: async () => null,
    async withTransactionAsync(fn) {
      state.depth += 1;
      state.maxDepth = Math.max(state.maxDepth, state.depth);
      try {
        // Yield so overlapping callers would interleave if not serialized.
        await new Promise((r) => setTimeout(r, 5));
        return await fn(adapter);
      } finally {
        state.depth -= 1;
      }
    },
    closeAsync: async () => {},
  };
  return { adapter, state };
}

describe('withSerializedTransactions', () => {
  it('never opens two transactions concurrently (depth never exceeds 1)', async () => {
    const { adapter, state } = instrumentedAdapter();
    const db = withSerializedTransactions(adapter);
    await Promise.all([
      db.withTransactionAsync(async () => 'a'),
      db.withTransactionAsync(async () => 'b'),
      db.withTransactionAsync(async () => 'c'),
    ]);
    expect(state.maxDepth).toBe(1);
  });

  it('isolates failures: a rejected transaction does not poison the queue', async () => {
    const { adapter } = instrumentedAdapter();
    const db = withSerializedTransactions(adapter);
    const results = await Promise.allSettled([
      db.withTransactionAsync(async () => 'A'),
      db.withTransactionAsync(async () => { throw { code: 'SQLITE_BUSY', message: 'busy' }; }),
      db.withTransactionAsync(async () => 'C'),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'A' });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason.name).toBe('WikiTransactionError');
    expect((results[1] as PromiseRejectedResult).reason.sqliteErrorCode).toBe('SQLITE_BUSY');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'C' });
  });

  it('passes domain (non-driver) errors through unwrapped', async () => {
    const { adapter } = instrumentedAdapter();
    const db = withSerializedTransactions(adapter);
    class DomainError extends Error {}
    await expect(db.withTransactionAsync(async () => { throw new DomainError('nope'); }))
      .rejects.toBeInstanceOf(DomainError);
    // Queue still advances:
    await expect(db.withTransactionAsync(async () => 'after')).resolves.toBe('after');
  });

  it('throws the reentrancy error when the callback opens a nested transaction', async () => {
    const { adapter } = instrumentedAdapter();
    const db = withSerializedTransactions(adapter);
    await expect(db.withTransactionAsync(async (tx) => tx.withTransactionAsync(async () => 1)))
      .rejects.toThrow(/Nested withTransactionAsync is not supported/);
  });
});

describe('WikiMemory concurrent writes (production repro)', () => {
  it('resolves overlapping write / setOntologyManifest / write without SQLite error 1', async () => {
    const { WikiMemory } = await import('../src/WikiMemory');
    const { openTestDatabase } = await import('./helpers/sqliteAdapter');
    const wiki = new WikiMemory(openTestDatabase(), {
      llmProvider: { generateText: async () => '{}' },
    });
    await wiki.setup();

    // Overlapping write paths that each open their own transaction.
    await expect(Promise.all([
      wiki.write('alice', { event_type: 'observation', summary: 'Alice likes tea' }),
      wiki.setOntologyManifest('alice', {
        node_types: [{ type: 'Person', description: 'a person' }],
        edge_types: [],
      }),
      wiki.write('bob', { event_type: 'observation', summary: 'Bob likes coffee' }),
    ])).resolves.toBeDefined();

    // Post-conditions hold.
    const manifest = await wiki.getOntologyManifest('alice');
    expect(manifest?.manifest.node_types.map((n) => n.type)).toContain('Person');
  });
});

describe('rollback guard', () => {
  it('surfaces the BEGIN failure, not "cannot rollback - no transaction is active"', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec('BEGIN'); // leave a transaction already open so the next BEGIN fails

    const adapter: SQLiteAdapter = {
      execAsync: async (sql) => { db.exec(sql); },
      runAsync: async () => ({ changes: 0, lastInsertRowId: 0 }),
      getAllAsync: async () => [],
      getFirstAsync: async () => null,
      async withTransactionAsync(fn) {
        db.exec('BEGIN'); // throws: cannot start a transaction within a transaction
        try {
          const r = await fn(adapter);
          db.exec('COMMIT');
          return r;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch { /* never mask the original */ }
          throw e;
        }
      },
      closeAsync: async () => { db.close(); },
    };

    await expect(adapter.withTransactionAsync(async () => 1))
      .rejects.toThrow(/within a transaction/);
    // The masking error must NOT surface:
    await expect(adapter.withTransactionAsync(async () => 1))
      .rejects.not.toThrow(/cannot rollback/);
  });
});

describe('reads are not serialized', () => {
  it('a getAllAsync outside a transaction resolves before a long-held transaction settles', async () => {
    const order: string[] = [];
    const base: SQLiteAdapter = {
      execAsync: async () => {},
      runAsync: async () => ({ changes: 0, lastInsertRowId: 0 }),
      getAllAsync: async () => { order.push('read'); return []; },
      getFirstAsync: async () => null,
      async withTransactionAsync(fn) { return fn(base); },
      closeAsync: async () => {},
    };
    const db = withSerializedTransactions(base);

    // Long-running transaction gated by a ≥50ms timeout (comfortable margin vs CI jitter).
    const txDone = db.withTransactionAsync(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push('tx');
    });
    // Concurrent read outside any transaction.
    await db.getAllAsync('SELECT 1');

    await txDone;
    expect(order).toEqual(['read', 'tx']);
  });
});
