import Database from 'better-sqlite3';
import type * as SQLite from 'expo-sqlite';

/**
 * Test-only adapter: exposes a real better-sqlite3 in-memory database behind
 * the subset of the expo-sqlite SQLiteDatabase API used by WikiMemory.
 *
 * Implements: execAsync, runAsync, getAllAsync, getFirstAsync,
 * withTransactionAsync. Does NOT attempt full expo-sqlite parity.
 */
export function openTestDatabase(): SQLite.SQLiteDatabase {
  const db = new Database(':memory:');

  const adapter = {
    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },

    async runAsync(sql: string, args: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...(args as any[]));
      return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
    },

    async getAllAsync<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...(args as any[])) as T[];
    },

    async getFirstAsync<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...(args as any[]));
      return (row ?? null) as T | null;
    },

    async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
      // better-sqlite3's transaction() requires a sync function. WikiMemory
      // uses async lambdas, so we manage BEGIN/COMMIT/ROLLBACK manually.
      db.exec('BEGIN');
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    // expo-sqlite exposes closeAsync; tests may want it.
    async closeAsync(): Promise<void> {
      db.close();
    },
  };

  return adapter as unknown as SQLite.SQLiteDatabase;
}
