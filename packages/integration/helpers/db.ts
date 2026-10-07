import Database from 'better-sqlite3';
import type { SQLiteAdapter } from '@equationalapplications/core-llm-wiki';

// IN (?,?,…) lists make the SQL text vary with list length, so the cache is
// bounded. Mirrors `statementCache` in packages/benchmarks/src/db.ts.
const STATEMENT_CACHE_SIZE = 512;

/**
 * Prepared statements are cached by SQL text (LRU). Preparing per call leaves
 * native statement memory that V8's GC does not see, which inflates RSS on the
 * long corpus suites (#257).
 */
export function openTestDatabase(): SQLiteAdapter {
  const db = new Database(':memory:');

  const stmts = new Map<string, Database.Statement>();
  const prepare = (sql: string): Database.Statement => {
    let stmt = stmts.get(sql);
    if (stmt) {
      stmts.delete(sql);
    } else {
      if (stmts.size >= STATEMENT_CACHE_SIZE) stmts.delete(stmts.keys().next().value!);
      stmt = db.prepare(sql);
    }
    stmts.set(sql, stmt);
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

  return adapter;
}
