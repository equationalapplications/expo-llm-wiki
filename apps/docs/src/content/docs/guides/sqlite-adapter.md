---
title: Write a SQLite adapter
description: The six-method SQLiteAdapter contract, ready-made adapters for better-sqlite3 and sql.js, and the concurrency rules.
sidebar:
  order: 2
---

`core-llm-wiki` works with any SQLite driver through this interface:

```ts
export interface SQLiteAdapter {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}
```

:::tip
On Expo you can skip this page. `@equationalapplications/expo-llm-wiki` ships an `expo-sqlite`
adapter: pass the database straight to `createWiki(db, …)`.
:::

## better-sqlite3 (Node.js)

```ts
import Database from 'better-sqlite3';
import type { SQLiteAdapter } from '@equationalapplications/core-llm-wiki';

const db = new Database('wiki.db');

export const adapter: SQLiteAdapter = {
  async execAsync(sql) { db.exec(sql); },
  async runAsync(sql, params = []) {
    const info = db.prepare(sql).run(...(params as any[]));
    return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
  },
  async getAllAsync<T>(sql, params = []) { return db.prepare(sql).all(...(params as any[])) as T[]; },
  async getFirstAsync<T>(sql, params = []) { return (db.prepare(sql).get(...(params as any[])) ?? null) as T | null; },
  async withTransactionAsync(fn) {
    db.exec('BEGIN');
    try { const r = await fn(adapter); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  async closeAsync() { db.close(); },
};
```

## sql.js (browser)

See the full adapter in the [React quickstart](/expo-llm-wiki/start/quickstart-react/).
sql.js doesn't expose a last-insert row ID cheaply. Returning `0` is fine because the engine
generates its own IDs.

## The contract, precisely

| Requirement | Why it matters |
|---|---|
| `runAsync().changes` must be accurate. A conflict-suppressed write reports `0`, and a value-identical update that was allowed still counts its row. | Ownership checks, edge counts, and compare-and-set metadata depend on it. |
| `withTransactionAsync` passes a transaction handle `tx` to the callback. | The engine runs every in-transaction statement through `tx`. |
| `getFirstAsync` returns `null` (not `undefined`) when there are no rows. | Engine code tests for `null`. |
| Parameters are positional `?` bindings. | All engine SQL is parameterized. |

## Concurrency rules

- **One connection per database file per process.** The engine serializes its own transactions
  on that connection, so you never need to throttle callers.
- Reads outside a transaction aren't serialized, so read latency is unaffected by writes.
- **Inside a transaction callback, use only `tx`.** Using the outer handle deadlocks, and opening
  a nested transaction throws.
- Cross-process locking is your job. Make sure there's a single writer per file.

When a driver error escapes a transaction (a nested `BEGIN`, `SQLITE_BUSY`, a constraint
violation), the engine throws `WikiTransactionError`, with `cause` set to the original error and
`sqliteErrorCode` set to a best-effort code such as `'SQLITE_BUSY'`. Group alerts on that code.

## Random IDs on React Native

Record IDs need a cryptographically secure random source. The engine tries
`crypto.randomUUID()`, then `crypto.getRandomValues()`, then an injected source. Hermes has
neither, so if you use **core directly** on React Native, call this once at startup:

```ts
import { configureRandomSource } from '@equationalapplications/core-llm-wiki';
import { getRandomValues } from 'expo-crypto';

configureRandomSource(getRandomValues);
```

The Expo package does this for you.
