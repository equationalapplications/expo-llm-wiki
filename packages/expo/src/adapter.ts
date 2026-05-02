import type * as SQLite from 'expo-sqlite';
import type { SQLiteAdapter } from '@eq/wiki-core';

export function createExpoAdapter(db: SQLite.SQLiteDatabase): SQLiteAdapter {
  return {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: async (sql, params = []) => {
      const result = await db.runAsync(sql, params as any[]);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    getAllAsync: (sql, params = []) => db.getAllAsync(sql, params as any[]),
    getFirstAsync: (sql, params = []) => db.getFirstAsync(sql, params as any[]),
    withTransactionAsync: (fn) => db.withTransactionAsync(fn as () => Promise<void>) as Promise<any>,
    closeAsync: () => db.closeAsync(),
  };
}
