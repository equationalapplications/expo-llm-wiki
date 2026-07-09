import type { SQLiteAdapter } from '../types';
import { WikiTransactionError } from '../types';
import { extractSqliteCode } from './sqliteCodes';

export { extractSqliteCode };

/** True when `err` carries a parseable SQLite code — gates whether the wrapper re-wraps. */
export function isDriverError(err: unknown): boolean {
  return extractSqliteCode(err) !== undefined;
}

/**
 * Returns an adapter with the given methods overridden, delegating everything else
 * (own or class-prototype methods) to `target`.
 *
 * Uses a `Proxy` rather than `Object.create`/object-spread: delegated methods are
 * bound to `target` before being returned, so their receiver (`this`) stays the
 * original adapter instance. That keeps ES `#private` fields and `instanceof`/identity
 * checks inside those methods working — `Object.create` would invoke them with the
 * wrapper as `this` and break both.
 */
function withOverrides(target: SQLiteAdapter, overrides: Partial<SQLiteAdapter>): SQLiteAdapter {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in overrides) return Reflect.get(overrides, prop, receiver);
      const value = Reflect.get(obj, prop, obj);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  }) as SQLiteAdapter;
}

/**
 * Returns the same adapter with `withTransactionAsync` overridden to throw. Injected
 * by the serialized wrapper onto the `tx` handed to every callback so a *nested*
 * transaction fails loudly instead of deadlocking against the mutex.
 */
export function guardReentrancy(tx: SQLiteAdapter): SQLiteAdapter {
  return withOverrides(tx, {
    withTransactionAsync() {
      throw new Error(
        'Nested withTransactionAsync is not supported: you are already ' +
        'inside a transaction. Pass the current `tx` down instead of ' +
        'opening a new transaction.'
      );
    },
  });
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
  return withOverrides(db, {
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
    },
  });
}
