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
 * Uses prototype delegation (`Object.create`) rather than object-spread so the
 * override sits on a thin child object and every other method — own OR inherited
 * from a class prototype — still resolves through the chain to the original adapter.
 */
export function guardReentrancy(tx: SQLiteAdapter): SQLiteAdapter {
  const guarded = Object.create(tx) as SQLiteAdapter;
  guarded.withTransactionAsync = function () {
    throw new Error(
      'Nested withTransactionAsync is not supported: you are already ' +
      'inside a transaction. Pass the current `tx` down instead of ' +
      'opening a new transaction.'
    );
  };
  return guarded;
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
  // Prototype delegation keeps every non-overridden method (own or inherited from a
  // class prototype) resolving through to the original adapter — object-spread would
  // silently drop a class-instance adapter's prototype methods.
  const wrapped = Object.create(db) as SQLiteAdapter;
  wrapped.withTransactionAsync = function <T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
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
          // Some adapters invoke the callback with no tx handle; fall back to the
          // outer db (same connection). The guard still blocks nested transactions.
          return db.withTransactionAsync((tx) => fn(guardReentrancy(tx ?? db)));
        })
        .catch((e) => {
          // Wrap only driver errors; domain errors reach the caller with instanceof intact.
          throw isDriverError(e)
            ? new WikiTransactionError('Transaction failed', { cause: e })
            : e;
        });

      queue = run; // advance the tail; next caller's leading .catch() absorbs this rejection
      return run as Promise<T>;
  };
  return wrapped;
}
