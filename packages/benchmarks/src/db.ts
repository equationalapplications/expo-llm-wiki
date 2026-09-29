import Database from 'better-sqlite3';
import type { SQLiteAdapter } from '@equationalapplications/core-llm-wiki';

export interface OpenDbResult {
  adapter: SQLiteAdapter;
  close(): void;
}

/**
 * Open a SQLite database for benchmarks.
 * - No argument (or undefined): in-memory database.
 * - With a file path: file-backed database with WAL journal mode.
 *
 * Body copied verbatim from `packages/integration/helpers/db.ts` so the
 * benchmarks share the integration package's adapter shape; only file-mode
 * adds `journal_mode = WAL` for better concurrent-read performance during
 * LongMemEval runs.
 */
export function openDb(file?: string): OpenDbResult {
  const db = new Database(file ?? ':memory:');
  if (file) {
    db.pragma('journal_mode = WAL');
  }

  const adapter: SQLiteAdapter = {
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
    async withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
      db.exec('BEGIN');
      try {
        const result = await fn(adapter);
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

  return {
    adapter,
    close(): void {
      if (db.open) db.close();
    },
  };
}