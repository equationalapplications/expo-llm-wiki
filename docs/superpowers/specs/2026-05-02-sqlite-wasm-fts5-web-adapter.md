# Spec: @sqlite.org/sqlite-wasm Adapter for FTS5 on Web

**Date:** 2026-05-02
**Status:** Draft

---

## Problem

`@equationalapplications/expo-llm-wiki` is broken on web (react-native-web). The `expo-sqlite` package uses `wa-sqlite` as its web runtime, and the `wa-sqlite` WASM build is compiled without `-DSQLITE_ENABLE_FTS5`. When `WikiMemory.setup()` runs on web, `CREATE VIRTUAL TABLE ... USING fts5(...)` throws at runtime. Every subsequent `read()` call with a non-empty query also fails because it relies on `MATCH` against the FTS5 table.

Alternatives evaluated and rejected:

- **`sql.js` (v1.14.1)** — Latest version. Makefile only enables `SQLITE_ENABLE_FTS3`. FTS5 is permanently absent. Not fixable without forking.
- **`sql.js-fts5`** — Abandoned fork from 2021 (v1.4.0). No updates in 5 years. Cannot be relied on.

---

## Goals

- Web users of `@equationalapplications/expo-llm-wiki` can use full FTS5 search with the `porter unicode61` tokenizer.
- The fix ships as an optional adapter helper. Users who do not target web are not affected — no new required dependencies.
- The adapter lives in `@equationalapplications/react-llm-wiki` (the web-facing package) under a new `./adapters` export subpath.
- The implementation does not change `@equationalapplications/core-llm-wiki` at all.
- An integration test confirms that `@sqlite.org/sqlite-wasm` + the adapter + `WikiMemory` work end-to-end with FTS5 in Node.

## Non-Goals

- Persistence to OPFS or localStorage (in scope for a future spec — OPFS adapter would be a separate subclass of this adapter).
- Automatic detection of the web environment and transparent adapter swapping.
- Polyfilling missing FTS5 features in adapters that lack it (e.g. graceful degradation to `LIKE`). The correct fix is a correct SQLite build.
- Changes to `expo` package or the native adapter.

---

## Design

### Package: `@sqlite.org/sqlite-wasm`

The official SQLite WASM package from the SQLite team. Full SQLite, compiled with FTS5 (including the `porter` and `unicode61` tokenizers). Available on npm as `@sqlite.org/sqlite-wasm`.

The API to use is the **OO1 API** (`sqlite3.oo1.DB`). As of 2026-04-15 the Worker1 and Promiser APIs are deprecated; use direct module loading.

Initialization pattern:

```typescript
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const sqlite3 = await sqlite3InitModule({ print: console.log, printErr: console.error });
const db = new sqlite3.oo1.DB(':memory:', 'c');
```

The OO1 API is **synchronous** (methods return values, not promises). All adapter methods must wrap calls in `Promise.resolve()` / `Promise.reject()`.

### New file: `packages/react/src/adapters/sqliteWasm.ts`

Exports a single factory function:

```typescript
export function createSqliteWasmAdapter(db: SqliteWasmDB): SQLiteAdapter
```

Where `SqliteWasmDB` is the `sqlite3.oo1.DB` instance, already constructed and open. The caller is responsible for calling `sqlite3InitModule()`, constructing the `DB`, and eventually calling `db.close()`. The adapter does not own the lifecycle of the DB.

The adapter type parameter `SqliteWasmDB` should be typed as the minimal interface used by the adapter (or `unknown` with internal casts if typing the sqlite-wasm module is too noisy — prefer using the runtime package's own types if they are exported).

#### Method implementations

**`execAsync(sql)`**

```typescript
execAsync(sql: string): Promise<void> {
  try {
    db.exec(sql);
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
}
```

`db.exec()` accepts multi-statement SQL, which is required because `schema.ts` sends the full DDL (tables, indexes, triggers, FTS5 virtual table) as one string to `execAsync`.

**`runAsync(sql, params?)`**

Uses `db.prepare()` + `bind()` + `stepFinalize()` to run a single DML statement. Returns `{ changes, lastInsertRowId }` via `db.changes()` and `sqlite3.capi.sqlite3_last_insert_rowid(db)` (or the OO1 `changes()` method).

```typescript
runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }> {
  try {
    const stmt = db.prepare(sql);
    try {
      if (params?.length) stmt.bind(params);
      stmt.stepFinalize();
    } finally {
      stmt.finalize();
    }
    return Promise.resolve({
      changes: db.changes(),
      lastInsertRowId: db.selectValue('SELECT last_insert_rowid()') as number ?? 0,
    });
  } catch (e) {
    return Promise.reject(e);
  }
}
```

Note: `db.changes()` (no argument) maps to `sqlite3_changes()`. `last_insert_rowid()` via `selectValue` is simpler than the C API pointer approach.

**`getAllAsync<T>(sql, params?)`**

Uses `db.exec()` with `rowMode: 'object'` and `resultRows` accumulator:

```typescript
getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]> {
  try {
    const rows: T[] = [];
    db.exec({ sql, bind: params ?? [], resultRows: rows, rowMode: 'object' });
    return Promise.resolve(rows);
  } catch (e) {
    return Promise.reject(e);
  }
}
```

**`getFirstAsync<T>(sql, params?)`**

Calls `getAllAsync` and returns `rows[0] ?? null`:

```typescript
async getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await this.getAllAsync<T>(sql, params);
  return rows[0] ?? null;
}
```

**`withTransactionAsync<T>(fn)`**

Uses `db.transaction()`, which starts `BEGIN`, calls the callback, then `COMMIT` or `ROLLBACK` on throw. Because `db.transaction()` is synchronous and `fn` is async, we cannot use it directly. Use explicit `BEGIN` / `COMMIT` / `ROLLBACK` via `execAsync`:

```typescript
async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
  await this.execAsync('BEGIN');
  try {
    const result = await fn();
    await this.execAsync('COMMIT');
    return result;
  } catch (e) {
    try { await this.execAsync('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}
```

`db.transaction(fn)` cannot be used here because it requires a synchronous callback, but `WikiMemory`'s transaction callbacks (`fn`) are async (they make LLM calls inside transactions). Manual `BEGIN`/`COMMIT`/`ROLLBACK` is the correct approach.

**`closeAsync()`**

No-op: the caller owns the DB lifecycle:

```typescript
closeAsync(): Promise<void> {
  return Promise.resolve();
}
```

### Export subpath: `@equationalapplications/react-llm-wiki/adapters`

Add `./adapters` to `packages/react/package.json` exports:

```json
"./adapters": {
  "types": "./dist/adapters.d.ts",
  "import": "./dist/adapters.mjs",
  "require": "./dist/adapters.js"
}
```

Add `src/adapters/sqliteWasm.ts` as an entry point in `packages/react/tsup.config.ts`:

```typescript
entry: ['src/index.ts', 'src/js.ts', 'src/adapters/sqliteWasm.ts'],
```

The `@sqlite.org/sqlite-wasm` import in `src/adapters/sqliteWasm.ts` must be listed as an external in tsup (to avoid bundling the WASM binary):

```typescript
external: ['react', '@equationalapplications/core-llm-wiki', '@sqlite.org/sqlite-wasm'],
```

### Peer dependency

Add to `packages/react/package.json` `peerDependencies`:

```json
"@sqlite.org/sqlite-wasm": ">=3.46.0"
```

And in `peerDependenciesMeta`:

```json
"@sqlite.org/sqlite-wasm": { "optional": true }
```

This follows the same pattern used by many React libraries for optional peer deps. Users who only target native do not need to install it.

### Integration test: `packages/core/__tests__/helpers/sqliteWasmAdapter.ts` + `packages/core/__tests__/sqliteWasmAdapter.test.ts`

**Why in `packages/core`?** The `@sqlite.org/sqlite-wasm` npm package works in Node.js as well as browsers, so the test can run in the existing Node vitest environment. The test validates that the full `WikiMemory` stack (setup → ingest → read with FTS5 MATCH) works end-to-end with this adapter.

`sqliteWasmAdapter.ts` (test helper, mirrors `helpers/sqliteAdapter.ts`):

```typescript
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';

export async function createTestSqliteWasmAdapter() {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  return createSqliteWasmAdapter(db);
}
```

`sqliteWasmAdapter.test.ts` — smoke test of FTS5:

1. Create adapter via `createTestSqliteWasmAdapter()`.
2. Create a `WikiMemory` with that adapter.
3. Call `setup()`.
4. Write a fact entry with known body text.
5. Call `read()` with a term that should match via FTS5 porter stemming.
6. Assert the entry is returned.
7. `closeAsync()` is a no-op, but `db.close()` must be called in `afterEach`.

Add `@sqlite.org/sqlite-wasm` to `devDependencies` in `packages/core/package.json`. It is a test-only dependency for core; for users it is a peer dep of `react`.

### README updates

The `packages/react/README.md` web setup section should:

1. Note that `expo-sqlite` on web (react-native-web) does not support FTS5.
2. Show the recommended setup using `@sqlite.org/sqlite-wasm` + `createSqliteWasmAdapter`.
3. Replace or annotate any existing `sql.js` example (if present) to note that `sql.js` does not include FTS5.

Minimal example to include:

```typescript
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';
import { createWiki } from '@equationalapplications/react-llm-wiki/js';

const sqlite3 = await sqlite3InitModule();
const rawDb = new sqlite3.oo1.DB(':memory:', 'c');
const adapter = createSqliteWasmAdapter(rawDb);
const wiki = createWiki(adapter, { llm: myProvider });
await wiki.setup();
```

---

## File Checklist

| File | Action |
|------|--------|
| `packages/react/src/adapters/sqliteWasm.ts` | Create |
| `packages/react/package.json` | Add `./adapters` export, `@sqlite.org/sqlite-wasm` optional peer dep |
| `packages/react/tsup.config.ts` | Add `src/adapters/sqliteWasm.ts` entry, add external |
| `packages/core/package.json` | Add `@sqlite.org/sqlite-wasm` to `devDependencies` |
| `packages/core/__tests__/helpers/sqliteWasmAdapter.ts` | Create |
| `packages/core/__tests__/sqliteWasmAdapter.test.ts` | Create |
| `packages/react/README.md` | Update web setup section |

---

## Open Questions

1. **Type imports from `@sqlite.org/sqlite-wasm`** — The package ships types. Determine whether `SqliteWasmDB` should be typed as `import('@sqlite.org/sqlite-wasm').Database` or a local minimal interface. Using the package's own exported type is preferred if available; fall back to a structural interface to avoid adding `@sqlite.org/sqlite-wasm` to `dependencies` (not just `peerDependencies`) of the react package.

2. **`lastInsertRowId` precision** — SQLite rowids are 64-bit integers. `db.selectValue('SELECT last_insert_rowid()')` returns a JS `number`. For the row counts used in `WikiMemory` this is safe (well within `Number.MAX_SAFE_INTEGER`), but worth noting.

3. **OPFS persistence** — Out of scope for this spec. A future `createOpfsSqliteWasmAdapter` could subclass or wrap this one, substituting `new sqlite3.oo1.OpfsDb(filename, 'c')` for the `:memory:` DB. The adapter implementation would be identical.
