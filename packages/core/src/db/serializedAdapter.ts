import type { SQLiteAdapter } from '../types';

/**
 * Best-effort SQLite code extraction. Driver-specific:
 *   better-sqlite3 / node:sqlite: err.code === 'SQLITE_BUSY' (string, SQLITE_-prefixed)
 *   expo-sqlite:                  err.message starts with 'Error code N: …' (numeric)
 */
export function extractSqliteCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
  if (typeof message === 'string') {
    const m = /^Error code (\d+):/.exec(message);
    if (m) return `SQLITE_${m[1]}`;
  }
  return undefined;
}

/** True when `err` carries a parseable SQLite code — gates whether the wrapper re-wraps. */
export function isDriverError(err: unknown): boolean {
  return extractSqliteCode(err) !== undefined;
}

/**
 * Returns the same adapter with `withTransactionAsync` overridden to throw. Injected
 * by the serialized wrapper onto the `tx` handed to every callback so a *nested*
 * transaction fails loudly instead of deadlocking against the mutex.
 *
 * Object-spread copies own enumerable properties only — adapters MUST be plain
 * object literals (the expo adapter and the core test helper are). A class-instance
 * adapter would lose its prototype methods here.
 */
export function guardReentrancy(tx: SQLiteAdapter): SQLiteAdapter {
  return {
    ...tx,
    withTransactionAsync() {
      throw new Error(
        'Nested withTransactionAsync is not supported: you are already ' +
        'inside a transaction. Pass the current `tx` down instead of ' +
        'opening a new transaction.'
      );
    },
  };
}
