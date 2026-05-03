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
- Web users can opt into OPFS-backed persistent storage by passing an `OpfsSAHPoolDb` (or `OpfsDb`) instance to `createSqliteWasmAdapter` instead of an in-memory `DB`.
- The spec documents Worker setup requirements and a minimal OPFS example.

## Non-Goals

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

The adapter accepts a pre-constructed `sqlite3.oo1.DB` instance. Because the adapter file must not contain a runtime `import` of `@sqlite.org/sqlite-wasm` (the WASM binary must not be bundled into the adapter), `SqliteWasmDB` is typed as a **local structural interface** listing only the methods the adapter calls (`exec`, `prepare`, `changes`, `selectValue`). No external import is needed at runtime. `@sqlite.org/sqlite-wasm` must still be added to `devDependencies` of `packages/react` so that TypeScript can resolve the types used to verify the structural match during build and typecheck.

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
      stmt.step();
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

Note: `step()` in a `try/finally` with `finalize()` is used rather than `stepFinalize()`, because `stepFinalize()` already calls `finalize()` internally and a second `finalize()` call in a wrapping `finally` block would obscure real lifecycle bugs. `db.changes()` (no argument) maps to `sqlite3_changes()`. `last_insert_rowid()` via `selectValue` is simpler than the C API pointer approach.

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

`db.transaction(fn)` cannot be used here because it requires a synchronous callback. `WikiMemory`'s transaction callbacks are async: they await multiple `runAsync` / `getAllAsync` calls inside the transaction body. (LLM calls happen *before* the `withTransactionAsync` wrapper, not inside it.) Manual `BEGIN`/`COMMIT`/`ROLLBACK` is the correct approach.

**`closeAsync()`**

Calls `db.close()`. This releases WASM memory for in-memory DBs and — critically — releases the OPFS file lock for OPFS-backed DBs. Without closing, an OPFS-backed DB would block all other tabs from opening the same file until the page is unloaded:

```typescript
closeAsync(): Promise<void> {
  try {
    db.close();
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
}
```

### OPFS persistence

The same `createSqliteWasmAdapter(db)` factory works for persistent storage. The caller passes an OPFS-backed DB instance instead of an in-memory `DB`. No changes to the adapter implementation.

**Browser constraints:**
- Both OPFS VFS options are only available inside a **Web Worker** (not the main UI thread). The DB must be constructed and all `wiki.*` calls must run inside the Worker. The main thread communicates via `postMessage` or a message-passing wrapper.
- Closing the DB (via `adapter.closeAsync()` or `wiki.close()` if exposed) must be called before the Worker terminates to release the OPFS file lock. Failure to close blocks other tabs from opening the same DB file.

**VFS choice:**

| VFS | Class | COOP/COEP headers? | Concurrency | Notes |
|-----|-------|--------------------|-------------|-------|
| **SAHPool** (recommended) | `PoolUtil.OpfsSAHPoolDb` | Not required | Single connection | Best performance; no header requirement |
| Standard OPFS | `sqlite3.oo1.OpfsDb` | Required (`require-corp` + `same-origin`) | Multi-tab (with locking) | Safari < 17 not supported |

**Recommended: SAHPool VFS**

The SAHPool VFS does not require COOP/COEP headers, making it usable in any deployment environment. It is single-connection per origin (one tab at a time holds the lock), which is the correct model for a memory store anyway.

Initialization inside a Worker:

```typescript
// wiki.worker.ts
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';
import { createWiki } from '@equationalapplications/react-llm-wiki/js';

const sqlite3 = await sqlite3InitModule();
const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 12 });
const rawDb = new poolUtil.OpfsSAHPoolDb('/wiki.db');
const adapter = createSqliteWasmAdapter(rawDb);
const wiki = createWiki(adapter, { llmProvider: /* receive via postMessage */ });
await wiki.setup();

// Handle messages from main thread
self.onmessage = async (e) => {
  const { type, payload } = e.data;
  if (type === 'read') {
    const bundle = await wiki.read(payload.entityId, payload.query);
    self.postMessage({ type: 'readResult', bundle });
  }
  // ... other operations
};
```

`initialCapacity: 12` (≥ 2× expected number of DB files) is a reasonable default. The capacity is persistent across sessions — setting it at first initialization is sufficient.

**Alternative: Standard OPFS VFS**

Use `sqlite3.oo1.OpfsDb` if multi-tab concurrency is required and the deployment server can emit COOP/COEP headers:

```typescript
// Requires: Cross-Origin-Embedder-Policy: require-corp
//           Cross-Origin-Opener-Policy: same-origin
const rawDb = new sqlite3.oo1.OpfsDb('/wiki.db', 'c');
const adapter = createSqliteWasmAdapter(rawDb);
```

**kvvfs (localStorage) — not recommended**

`sqlite3.oo1.JsStorageDb` is main-thread only (no Worker required) and backed by `localStorage`. Its effective storage limit is ~2.5 MB (localStorage is 5 MB but JS uses 2-byte encoding). Too small for a memory store with any significant history. Not recommended.

### Export subpath: `@equationalapplications/react-llm-wiki/adapters`

tsup derives the output filename from the entry filename. To get `dist/adapters.js` / `.mjs` / `.d.ts` — matching the package.json export paths — the tsup entry must be `src/adapters.ts`, not `src/adapters/sqliteWasm.ts`. Create a thin barrel:

**`packages/react/src/adapters.ts`** (barrel):
```typescript
export { createSqliteWasmAdapter } from './adapters/sqliteWasm';
```

The implementation lives in `packages/react/src/adapters/sqliteWasm.ts` as before; the barrel file is the tsup entry.

Add `./adapters` to `packages/react/package.json` exports:

```json
"./adapters": {
  "types": "./dist/adapters.d.ts",
  "import": "./dist/adapters.mjs",
  "require": "./dist/adapters.js"
}
```

Add `src/adapters.ts` as a tsup entry in `packages/react/tsup.config.ts`:

```typescript
entry: ['src/index.ts', 'src/js.ts', 'src/adapters.ts'],
```

Because the adapter uses a local structural interface with no runtime import of `@sqlite.org/sqlite-wasm`, the package does not need to be listed in tsup `external`. No WASM code is referenced at module level.

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

### Integration test: `packages/react/__tests__/sqliteWasmAdapter.test.ts`

**Why in `packages/react`, not `packages/core`?** The adapter is implemented in `packages/react`. Placing the test in `packages/core` would require core to depend on a react-package artifact, reversing the intended dependency direction. `@sqlite.org/sqlite-wasm` works in Node.js, so the test can run in a Node vitest environment with no browser required.

Add a Node vitest config or rely on the existing one in `packages/react` — check whether a Node environment is already configured before adding a second config file.

`sqliteWasmAdapter.test.ts`:

```typescript
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createWiki } from '@equationalapplications/core-llm-wiki';
import { createSqliteWasmAdapter } from '../src/adapters/sqliteWasm';

let rawDb: ReturnType<typeof sqlite3.oo1.DB>; // closed in afterEach

it('setup + write + read round-trips through FTS5 with porter stemming', async () => {
  const sqlite3 = await sqlite3InitModule();
  rawDb = new sqlite3.oo1.DB(':memory:', 'c');
  const adapter = createSqliteWasmAdapter(rawDb);
  const wiki = createWiki(adapter, { llmProvider: stubProvider });
  await wiki.setup();

  // Insert a fact directly via runAsync (bypassing LLM)
  await adapter.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['fact_1', 'entity-1', 'Running habit', 'User runs every morning', '[]', 'certain', 'user_document', Date.now(), Date.now()]
  );

  // 'ran' → porter stem 'ran'; 'run' → porter stem 'run'; both should match 'runs' / 'running'
  const bundle = await wiki.read('entity-1', 'running');
  expect(bundle.facts).toHaveLength(1);
  expect(bundle.facts[0].title).toBe('Running habit');
});

afterEach(() => { rawDb?.close(); });
```

Add `@sqlite.org/sqlite-wasm` to `devDependencies` in **`packages/react/package.json`**. It is a devDependency for build/typecheck and test; for end users it is an optional peer dep.

### README updates

The `packages/react/README.md` web setup section should:

1. Note that `expo-sqlite` on web (react-native-web) does not support FTS5.
2. Show the recommended setup using `@sqlite.org/sqlite-wasm` + `createSqliteWasmAdapter`.
3. Replace or annotate any existing `sql.js` example (if present) to note that `sql.js` does not include FTS5.

Minimal examples to include:

**In-memory (non-persistent):**
```typescript
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';
import { createWiki } from '@equationalapplications/react-llm-wiki/js';

const sqlite3 = await sqlite3InitModule();
const rawDb = new sqlite3.oo1.DB(':memory:', 'c');
const adapter = createSqliteWasmAdapter(rawDb);
const wiki = createWiki(adapter, { llmProvider: myProvider });
await wiki.setup();
```

**OPFS-persistent (inside a Web Worker — recommended for persistence):**
```typescript
// wiki.worker.ts — run this file as a Worker
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';
import { createWiki } from '@equationalapplications/react-llm-wiki/js';

const sqlite3 = await sqlite3InitModule();
const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 12 });
const rawDb = new poolUtil.OpfsSAHPoolDb('/wiki.db');
const adapter = createSqliteWasmAdapter(rawDb);
const wiki = createWiki(adapter, { llmProvider: myProvider });
await wiki.setup();
// call adapter.closeAsync() before the Worker terminates
```

Note: OPFS requires a Worker context. The README should direct users to the Worker setup section and explain that all `wiki.*` calls must originate from within the Worker.

---

## File Checklist

| File | Action |
|------|--------|
| `packages/react/src/adapters/sqliteWasm.ts` | Create |
| `packages/react/src/adapters.ts` | Create (barrel re-export, tsup entry) |
| `packages/react/package.json` | Add `./adapters` export; `@sqlite.org/sqlite-wasm` optional peer dep + devDependency |
| `packages/react/tsup.config.ts` | Add `src/adapters.ts` entry |
| `packages/react/__tests__/sqliteWasmAdapter.test.ts` | Create |
| `packages/react/README.md` | Update web setup section: in-memory example + OPFS Worker example |
| `README.md` (root) | Update web/vanilla installation and setup sections to recommend `@sqlite.org/sqlite-wasm` + `createSqliteWasmAdapter`; annotate `sql.js` examples with FTS5 caveat; add OPFS Worker setup note |

---

## Open Questions

1. ~~**Type imports from `@sqlite.org/sqlite-wasm`**~~ — Resolved in design: use a local structural interface. `@sqlite.org/sqlite-wasm` is `devDependencies` + optional `peerDependencies` in `packages/react`. No runtime import in the adapter file.

2. **`lastInsertRowId` precision** — SQLite rowids are 64-bit integers. `db.selectValue('SELECT last_insert_rowid()')` returns a JS `number`. For the row counts used in `WikiMemory` this is safe (well within `Number.MAX_SAFE_INTEGER`), but worth noting.

3. ~~**OPFS persistence**~~ — In scope. The same `createSqliteWasmAdapter(db)` factory accepts any `oo1.DB` subclass including `OpfsDb` and `OpfsSAHPoolDb`. No separate factory needed. See the OPFS design section. `closeAsync()` must call `db.close()` (not a no-op) to release OPFS file locks.
