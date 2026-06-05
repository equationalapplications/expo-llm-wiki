import initSqlJs, { Database, SqlJsStatic } from 'sql.js'

export interface SQLiteAdapter {
  execAsync(sql: string): Promise<void>
  runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>
  getFirstAsync<T>(sql: string, params?: unknown[])
  withTransactionAsync<T>(fn: () => Promise<T>): Promise<T>
  closeAsync(): Promise<void>
}

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
    const stmt = this.db.prepare(sql)
    stmt.bind(params as any[])
    stmt.step()
    stmt.free()
    return { changes: this.db.getRowsModified(), lastInsertRowId: 0 }
  }

  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    stmt.bind(params as any[])
    const rows: T[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T)
    }
    stmt.free()
    return rows
  }

  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql)
    stmt.bind(params as any[])
    const row = stmt.step() ? (stmt.getAsObject() as T) : null
    stmt.free()
    return row
  }

  async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.db.run('BEGIN')
    try {
      const result = await fn()
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
