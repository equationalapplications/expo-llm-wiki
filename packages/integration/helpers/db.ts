import Database from 'better-sqlite3';
import type { SQLiteAdapter } from '@equationalapplications/core-llm-wiki';

export function openTestDatabase(): SQLiteAdapter {
  const db = new Database(':memory:');

  return {
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
    async closeAsync(): Promise<void> {
      db.close();
    },
  };
}
