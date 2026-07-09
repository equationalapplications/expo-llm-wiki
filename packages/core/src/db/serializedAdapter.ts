import type { SQLiteAdapter } from '../types';
import { WikiTransactionError } from '../types';

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

const DEADLOCK_WARN_MS = 10_000;

/**
 * Wraps `withTransactionAsync` in a promise-chain mutex so transactions on the
 * single shared connection run one at a time. Non-transactional reads/writes are
 * untouched. Applied once in the WikiMemory constructor before the adapter reaches
 * any repository or service.
 */
export function withSerializedTransactions(db: SQLiteAdapter): SQLiteAdapter {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    ...db,
    withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
      // Warns if a call waits >10s for the lock — the signature of the closure-capture
      // deadlock (calling the outer `db` instead of `tx` inside a callback). Cleared the
      // instant the lock is acquired, so it measures queue wait only.
      const warn = setTimeout(() => {
        console.warn(
          '[core-llm-wiki] Transaction queued >10s — possible deadlock. ' +
          'Inside a transaction callback, use the `tx` parameter, never the ' +
          'outer database handle.'
        );
      }, DEADLOCK_WARN_MS);

      const run = queue
        .catch(() => undefined) // proceed from a settled state; swallow prior outcome
        .then(() => {
          clearTimeout(warn);
          // Re-wrap the tx so a nested withTransactionAsync throws synchronously.
          return db.withTransactionAsync((tx) => fn(guardReentrancy(tx)));
        })
        .catch((e) => {
          // Wrap only driver errors; domain errors reach the caller with instanceof intact.
          throw isDriverError(e)
            ? new WikiTransactionError('Transaction failed', { cause: e })
            : e;
        });

      queue = run; // advance the tail; next caller's leading .catch() absorbs this rejection
      return run as Promise<T>;
    },
  };
}
