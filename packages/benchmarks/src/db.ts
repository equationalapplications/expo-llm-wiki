import Database from 'better-sqlite3';
import type { SQLiteAdapter } from '@equationalapplications/core-llm-wiki';

export interface OpenDbResult {
  adapter: SQLiteAdapter;
  close(): void;
}

// IN (?,?,…) lists make the SQL text vary with list length, so the cache is
// bounded; the cap leaves room for many list lengths before eviction starts.
const STATEMENT_CACHE_SIZE = 512;

/** LRU cache of prepared statements keyed by SQL text. */
function statementCache(db: Database.Database): (sql: string) => Database.Statement {
  // Map iterates in insertion order: re-inserting on a hit keeps the
  // least-recently-used key first, so eviction drops one cold entry rather
  // than the whole hot set.
  const stmts = new Map<string, Database.Statement>();
  return (sql) => {
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
}

/**
 * Open a SQLite database for benchmarks.
 * - No argument (or undefined): in-memory database.
 * - With a file path: file-backed database with WAL journal mode.
 *
 * Same adapter shape as `packages/integration/helpers/db.ts`, plus file-mode
 * sets `journal_mode = WAL` for better concurrent-read performance during
 * LongMemEval runs. Both cache prepared statements by SQL text: preparing per
 * call leaves native statement memory that V8's GC does not see, so RSS grew
 * ~3.5x the database size in fts5-memory runs (#257) and the benchmark
 * measured the adapter instead of the engine.
 */
export function openDb(file?: string): OpenDbResult {
  const db = new Database(file ?? ':memory:');
  if (file) {
    db.pragma('journal_mode = WAL');
  }

  const prepare = statementCache(db);

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