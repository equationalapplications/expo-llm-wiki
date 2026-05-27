import type { SQLiteAdapter } from '@equationalapplications/react-llm-wiki'
import initSqlJs, { type Database } from 'sql.js'

/**
 * Wraps a sql.js in-memory Database to implement the SQLiteAdapter
 * interface required by @equationalapplications/core-llm-wiki.
 */
class SqlJsAdapter implements SQLiteAdapter {
  private db: Database
  private inTransaction = false

  constructor(db: Database) {
    this.db = db
  }

  async execAsync(sql: string): Promise<void> {
    this.db.run(sql)
  }

  async runAsync(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db.run(sql, params as any)
    return {
      changes: this.db.getRowsModified(),
      lastInsertRowId: Number(this.db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0),
    }
  }

  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stmt.bind(params as any)
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
    const rows = await this.getAllAsync<T>(sql, params)
    return rows[0] ?? null
  }

  async withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      // Nested: reuse same db
      return fn(this)
    }
    this.db.run('BEGIN')
    this.inTransaction = true
    try {
      const result = await fn(this)
      this.db.run('COMMIT')
      return result
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    } finally {
      this.inTransaction = false
    }
  }

  async closeAsync(): Promise<void> {
    this.db.close()
  }
}

let _adapter: SqlJsAdapter | null = null

export async function createSqlJsAdapter(): Promise<SQLiteAdapter> {
  if (_adapter) return _adapter
  const SQL = await initSqlJs({ locateFile: (file) => `${import.meta.env.BASE_URL}${file}` })
  const db = new SQL.Database()
  _adapter = new SqlJsAdapter(db)
  return _adapter
}
