import type { SQLiteAdapter } from '../types';
import { WikiTransactionError } from '../types';

/**
 * SQLite primary result codes → symbolic name (https://sqlite.org/rescode.html),
 * so a numeric expo-sqlite code normalizes to the same shape as the string codes
 * better-sqlite3 / node:sqlite already report (e.g. both become 'SQLITE_BUSY').
 */
const SQLITE_RESULT_CODE_NAMES: Record<number, string> = {
  1: 'SQLITE_ERROR', 2: 'SQLITE_INTERNAL', 3: 'SQLITE_PERM', 4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 7: 'SQLITE_NOMEM', 8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN', 15: 'SQLITE_PROTOCOL', 16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA', 18: 'SQLITE_TOOBIG', 19: 'SQLITE_CONSTRAINT', 20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE', 22: 'SQLITE_NOLFS', 23: 'SQLITE_AUTH', 24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE', 26: 'SQLITE_NOTADB', 27: 'SQLITE_NOTICE', 28: 'SQLITE_WARNING',
  100: 'SQLITE_ROW', 101: 'SQLITE_DONE',
};

/** Falls back to `SQLITE_<n>` for a result code outside the known table. */
function nameForSqliteResultCode(n: number): string {
  return SQLITE_RESULT_CODE_NAMES[n] ?? `SQLITE_${n}`;
}

/**
 * Best-effort SQLite code extraction. Driver-specific:
 *   better-sqlite3 / node:sqlite: err.code === 'SQLITE_BUSY' (string, SQLITE_-prefixed)
 *   expo-sqlite:                  err.message starts with 'Error code N: …' (numeric,
 *                                  normalized here to the same symbolic name)
 */
export function extractSqliteCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
  if (typeof message === 'string') {
    const m = /^Error code (\d+):/.exec(message);
    if (m) return nameForSqliteResultCode(Number(m[1]));
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
