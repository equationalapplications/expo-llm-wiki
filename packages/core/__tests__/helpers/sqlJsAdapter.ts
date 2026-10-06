// packages/core/__tests__/helpers/sqlJsAdapter.ts
import initSqlJs from 'sql.js';
import type { SQLiteAdapter } from '../../src/types';

/** sql.js 1.14.2 ships without FTS5 but with json1: the real no-FTS5 fallback case. */
export async function openSqlJsDatabase(bytes?: Uint8Array): Promise<SQLiteAdapter> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes);
  const all = <T>(sql: string, params: unknown[] = []): T[] => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params as any[]);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      return out;
    } finally { stmt.free(); }
  };
  const adapter: SQLiteAdapter = {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, params = []) {
      db.run(sql, params as any[]);
      const rowid = all<{ r: number }>('SELECT last_insert_rowid() AS r')[0].r;
      return { changes: db.getRowsModified(), lastInsertRowId: rowid };
    },
    async getAllAsync<T>(sql: string, params: unknown[] = []) { return all<T>(sql, params); },
    async getFirstAsync<T>(sql: string, params: unknown[] = []) { return all<T>(sql, params)[0] ?? null; },
    async withTransactionAsync(fn) {
      db.exec('BEGIN');
      try { const r = await fn(adapter); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* none active */ } throw e; }
    },
    async closeAsync() { db.close(); },
  };
  return adapter;
}
