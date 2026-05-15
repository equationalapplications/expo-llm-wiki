import type * as SQLite from 'expo-sqlite';
import type { SQLiteAdapter } from '@equationalapplications/core-llm-wiki';

export function createExpoAdapter(db: SQLite.SQLiteDatabase): SQLiteAdapter {
  const adapter: SQLiteAdapter = {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: async (sql, params = []) => {
      const result = await db.runAsync(sql, params as any[]);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    getAllAsync: (sql, params = []) => db.getAllAsync(sql, params as any[]),
    getFirstAsync: (sql, params = []) => db.getFirstAsync(sql, params as any[]),
    withTransactionAsync: (fn) => {
      // expo-sqlite only accepts () => Promise<void>; capture the result to satisfy the generic interface
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let captured: any;
      return db.withTransactionAsync(() => fn(adapter).then(v => { captured = v; })).then(() => captured);
    },
    closeAsync: () => db.closeAsync(),
  };
  return adapter;
}
