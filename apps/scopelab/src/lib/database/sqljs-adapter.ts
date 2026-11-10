import initSqlJs from 'sql.js'
import type { Database } from 'sql.js'
import type { SQLiteAdapter } from '@equationalapplications/core-llm-wiki'

// Core's adapter contract, not a local copy: the old copy typed the
// transaction callback without its `tx` argument and drifted from core.
export type { SQLiteAdapter }

export class SqlJsAdapter implements SQLiteAdapter {
  private db: Database

  private constructor(db: Database) {
    this.db = db
  }

  static async create(): Promise<SqlJsAdapter> {
    const base = import.meta.env.BASE_URL ?? '/'
    const wasmUrl = `${base}sql-wasm.wasm`
    const SQL = await initSqlJs({ locateFile: () => wasmUrl })
    const db = new SQL.Database()
    return new SqlJsAdapter(db)
  }

  async execAsync(sql: string): Promise<void> {
    this.db.run(sql)
  }

  async runAsync(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    this.db.run(sql, params as any)
    return {
      changes: this.db.getRowsModified(),
      // Core keys FTS rows on this (Fts5IndexStrategy.insertDocs); a
      // hardcoded 0 pointed every entries_fts row at rowid 0, so keyword
      // search on an FTS5-capable sql.js build found nothing.
      lastInsertRowId: Number(this.db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0),
    }
  }

  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as any[])
      const rows: T[] = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T)
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as any[])
      return stmt.step() ? (stmt.getAsObject() as T) : null
    } finally {
      stmt.free()
    }
  }

  async withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
    this.db.run('BEGIN')
    try {
      // One sql.js connection: the transaction handle is this adapter.
      const result = await fn(this)
      this.db.run('COMMIT')
      return result
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  async closeAsync(): Promise<void> {
    this.db.close()
  }

  export(): Uint8Array {
    return this.db.export()
  }
}
