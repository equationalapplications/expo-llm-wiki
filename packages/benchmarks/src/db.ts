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
 * Same adapter shape as `packages/integration/helpers/db.ts`, with two
 * additions: file-mode sets `journal_mode = WAL` for better concurrent-read
 * performance during LongMemEval runs, and prepared statements are cached by
 * SQL text. Preparing per call leaves native statement memory that V8's GC
 * does not see, so RSS grew ~3.5x the database size in fts5-memory runs
 * (#257) and the benchmark measured the adapter instead of the engine.
 */
export function openDb(file?: string): OpenDbResult {
  const db = new Database(file ?? ':memory:');
  if (file) {
    db.pragma('journal_mode = WAL');
  }

  // Bounded: IN (?,?,…) lists make the SQL text vary with list length.
  const stmts = new Map<string, Database.Statement>();
  const prepare = (sql: string): Database.Statement => {
    let stmt = stmts.get(sql);
    if (!stmt) {
      if (stmts.size >= 512) stmts.clear();
      stmt = db.prepare(sql);
      stmts.set(sql, stmt);
    }
    return stmt;
  };

  const adapter: SQLiteAdapter = {
    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },
    async runAsync(sql: string, args: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const stmt = prepare(sql);
      const info = stmt.run(...(args as any[]));
      return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      const stmt = prepare(sql);
      return stmt.all(...(args as any[])) as T[];
    },
    async getFirstAsync<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      const stmt = prepare(sql);
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