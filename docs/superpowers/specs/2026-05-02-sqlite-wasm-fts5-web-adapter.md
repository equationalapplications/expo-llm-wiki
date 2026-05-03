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
- Shared browser runtime helpers (Worker server + main-thread client/proxy) live in `@equationalapplications/react-llm-wiki` under a new `./web` export subpath.
- Expo web users can consume those browser helpers through a thin Expo-package re-export/subpath without changing the native Expo API.
- The implementation does not change `@equationalapplications/core-llm-wiki` at all.
- An integration test confirms that `@sqlite.org/sqlite-wasm` + the adapter + `WikiMemory` work end-to-end with FTS5 in Node.
- A second test covers the Worker client/proxy boundary used by React hooks and Expo web consumers.
- Web users can opt into OPFS-backed persistent storage by passing an `OpfsSAHPoolDb` (or `OpfsDb`) instance to `createSqliteWasmAdapter` instead of an in-memory `DB`.
- The spec documents Worker setup requirements, package ownership, and where the `llmProvider` must live.

## Non-Goals

- Automatic detection of the web environment and transparent adapter swapping.
- Polyfilling missing FTS5 features in adapters that lack it (e.g. graceful degradation to `LIKE`). The correct fix is a correct SQLite build.
- Replacing or changing the native `expo-sqlite` adapter path. The Expo package may add web-only re-exports/subpaths, but native `createWiki(db, options)` remains unchanged.
- Shipping a generic main-thread-to-Worker `llmProvider` bridge. The Worker constructs its own `llmProvider`; any custom provider RPC remains application-owned.

---

## Design

### Package ownership

This work splits into shared browser runtime code and Expo-facing convenience layers.

- `@equationalapplications/react-llm-wiki` owns all browser-only sqlite-wasm code: the low-level adapter, the Worker RPC/server/client helpers, and the structural `WikiClient` type consumed by the React hooks.
- `@equationalapplications/expo-llm-wiki` remains thin. It continues to own the native `expo-sqlite` adapter and will add a `./web` re-export/factory that delegates to the React package so Expo apps can keep Expo-flavored import paths on web.
- `@equationalapplications/core-llm-wiki` remains unchanged.

Why this split: the Expo package's current adapter is typed specifically to `expo-sqlite`'s `SQLiteDatabase`, while OPFS on web is a Worker-backed sqlite-wasm runtime. Trying to embed OPFS directly into the current Expo adapter would mix two unrelated transports into one API surface. The React package is already the web-facing package, so it should own the shared browser runtime.

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

Where `SqliteWasmDB` is a structural interface compatible with `sqlite3.oo1.DB` and its subclasses, already constructed and open. The caller is responsible for calling `sqlite3InitModule()` and constructing the DB. Once the DB is wrapped, lifecycle should flow through `adapter.closeAsync()` rather than direct `db.close()` calls behind the adapter's back.

The adapter accepts a pre-constructed `sqlite3.oo1.DB` instance. Because the adapter file must not contain a runtime `import` of `@sqlite.org/sqlite-wasm` (the WASM binary must not be bundled into the adapter), `SqliteWasmDB` is typed as a **local structural interface** listing only the methods the adapter calls (`exec`, `prepare`, `changes`, `selectValue`, `close`). No external import is needed at runtime. `@sqlite.org/sqlite-wasm` must still be added to `devDependencies` of `packages/react` so that TypeScript can resolve the types used to verify the structural match during build and typecheck.

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

Uses `db.prepare()` + `bind()` + `step()` to run a single DML statement. Returns `{ changes, lastInsertRowId }` via `db.changes()` and `last_insert_rowid()`.

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

### React-side client boundary

OPFS cannot be consumed by passing a Worker-owned `WikiMemory` instance directly into React context on the main thread. The React package must widen its provider/hook boundary from the concrete `WikiMemory` class to a structural interface.

Recommended shape:

```typescript
import type { WikiMemory } from '@equationalapplications/core-llm-wiki';

export type WikiClient = Pick<
  WikiMemory,
  | 'read'
  | 'write'
  | 'ingestDocument'
  | 'forget'
  | 'hasChanged'
  | 'runLibrarian'
  | 'runHeal'
  | 'runPrune'
  | 'exportDump'
>;
```

`WikiMemory` satisfies this type directly for native/in-memory usage. A new main-thread `WikiWorkerClient` also satisfies it by forwarding calls over `postMessage` to a dedicated Worker.

Update `packages/react/src/WikiContext.tsx` and the hooks to accept `WikiClient` instead of concrete `WikiMemory`. `packages/react/src/js.ts` should also widen its helper signatures to `WikiClient` so plain JS consumers can use the same proxy client.

`WikiClient` intentionally excludes shutdown methods because the React hooks do not use them. Any Worker lifecycle helper (`dispose()`, `terminate()`, etc.) should live alongside the proxy client, not inside the provider contract.

### Worker runtime helpers

Add a new `@equationalapplications/react-llm-wiki/web` export subpath. It owns the Worker RPC boundary so applications do not hand-write message protocols.

Recommended exports:

```typescript
export function createWikiWorkerClient(worker: Worker): WikiClient;
export function serveWikiWorker(wiki: WikiClient, endpoint?: DedicatedWorkerGlobalScope): void;
```

`createWikiWorkerClient()` runs on the main thread and returns a `WikiClient` implementation backed by `postMessage()`.

`serveWikiWorker()` runs inside the Worker and dispatches incoming RPC requests onto a real `WikiMemory` instance.

RPC messages should stay JSON-serializable:

- request: `{ id, method, args }`
- success response: `{ id, result }`
- error response: `{ id, error: { name, message } }`

No attempt should be made to transfer arbitrary functions or class instances across the boundary.

### OPFS persistence

The same `createSqliteWasmAdapter(db)` factory works for persistent storage, but OPFS is only usable through a Worker-backed runtime. The Worker owns the real `WikiMemory`; the main thread talks to it through `createWikiWorkerClient()`.

**Browser constraints:**
- Both OPFS VFS options are only available inside a **Web Worker** (not the main UI thread). The DB must be constructed and all real `WikiMemory` calls must run inside the Worker.
- The `llmProvider` must also be created inside the Worker. Standard `fetch`-based providers work there. If an app needs a main-thread-only provider, that custom bridge is application-owned and out of scope for this package.
- `adapter.closeAsync()` must be called before the Worker terminates to release the OPFS file lock. Failure to close blocks other tabs from opening the same DB file.

**VFS choice:**

| VFS | Class | COOP/COEP headers? | Concurrency | Notes |
|-----|-------|--------------------|-------------|-------|
| **SAHPool** (recommended) | `PoolUtil.OpfsSAHPoolDb` | Not required | Single connection | Best performance; no header requirement |
| Standard OPFS | `sqlite3.oo1.OpfsDb` | Required (`require-corp` + `same-origin`) | Multi-tab (with locking) | Safari < 17 not supported |

**Recommended: SAHPool VFS**

The SAHPool VFS does not require COOP/COEP headers, making it usable in any deployment environment. It is single-connection per origin (one tab at a time holds the lock), which is the correct model for a memory store anyway.

Main thread:

```typescript
import { WikiProvider } from '@equationalapplications/react-llm-wiki';
import { createWikiWorkerClient } from '@equationalapplications/react-llm-wiki/web';

const worker = new Worker(new URL('./wiki.worker.ts', import.meta.url), { type: 'module' });
const wiki = createWikiWorkerClient(worker);

export default function App() {
  return (
    <WikiProvider wiki={wiki}>
      <YourApp />
    </WikiProvider>
  );
}
```

Worker initialization:

```typescript
// wiki.worker.ts
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';
import { createWiki } from '@equationalapplications/react-llm-wiki/js';
import { serveWikiWorker } from '@equationalapplications/react-llm-wiki/web';

const sqlite3 = await sqlite3InitModule();
const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 12 });
const rawDb = new poolUtil.OpfsSAHPoolDb('/wiki.db');
const adapter = createSqliteWasmAdapter(rawDb);
const wiki = createWiki(adapter, { llmProvider: workerLocalProvider });
await wiki.setup();
serveWikiWorker(wiki);
```

`initialCapacity: 12` (≥ 2× expected number of DB files) is a reasonable default. The capacity is persistent across sessions — setting it at first initialization is sufficient.

At Worker shutdown, call `adapter.closeAsync()` before terminating the Worker.

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

For Expo apps targeting web, `@equationalapplications/expo-llm-wiki/web` may thinly re-export `createWikiWorkerClient` from the React package. The Worker file itself should still import sqlite-wasm helpers from `@equationalapplications/react-llm-wiki`, because that is where the browser runtime lives.

### Export subpaths

tsup derives the output filename from the entry filename. To get `dist/adapters.js` / `.mjs` / `.d.ts` — matching the package.json export paths — the tsup entry must be `src/adapters.ts`, not `src/adapters/sqliteWasm.ts`. Create a thin barrel:

**`packages/react/src/adapters.ts`** (barrel):
```typescript
export { createSqliteWasmAdapter } from './adapters/sqliteWasm';
```

The implementation lives in `packages/react/src/adapters/sqliteWasm.ts` as before; the barrel file is the tsup entry.

Add `./adapters` and `./web` to `packages/react/package.json` exports:

```json
"./adapters": {
  "types": "./dist/adapters.d.ts",
  "import": "./dist/adapters.mjs",
  "require": "./dist/adapters.js"
},
"./web": {
  "types": "./dist/web.d.ts",
  "import": "./dist/web.mjs",
  "require": "./dist/web.js"
}
```

Add `src/adapters.ts` and `src/web.ts` as tsup entries in `packages/react/tsup.config.ts`:

```typescript
entry: ['src/index.ts', 'src/js.ts', 'src/adapters.ts', 'src/web.ts'],
```

Because the adapter uses a local structural interface with no runtime import of `@sqlite.org/sqlite-wasm`, the package does not need to be listed in tsup `external`. No WASM code is referenced at module level.

If Expo convenience re-exports are included, add `packages/expo/src/web.ts` as a thin re-export of `@equationalapplications/react-llm-wiki/web` and expose it through `./web` in `packages/expo/package.json`. Do not duplicate adapter or Worker-runtime code inside `packages/expo`.

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

### Tests in `packages/react`

**Why in `packages/react`, not `packages/core`?** The browser adapter and Worker client are implemented in `packages/react`. Placing the tests in `packages/core` would require core to depend on a react-package artifact, reversing the intended dependency direction.

Current `packages/react/vitest.config.ts` only includes `*.test-DISABLED.*`, so new tests would not run. Update it to include `__tests__/**/*.test.ts` in a Node environment while leaving the React hook tests disabled by suffix.

Add two tests:

1. `sqliteWasmAdapter.test.ts` — Node integration test for `createSqliteWasmAdapter` + `WikiMemory` + FTS5:

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

2. `wikiWorkerClient.test.ts` — Node/unit test for `createWikiWorkerClient` + `serveWikiWorker` using an in-process mocked Worker/message transport. This validates the proxy boundary that the React hooks and Expo web wrapper rely on.

A real browser/OPFS smoke test is desirable but not required for the initial spec. Manual validation in a browser remains required when implementing the OPFS path.

Add `@sqlite.org/sqlite-wasm` to `devDependencies` in **`packages/react/package.json`**. It is a devDependency for build/typecheck and test; for end users it is an optional peer dep.

### README updates

The `packages/react/README.md` web setup section should:

1. Note that `expo-sqlite` on web (react-native-web) does not support FTS5.
2. Show the recommended setup using `createWikiWorkerClient` on the main thread and `@sqlite.org/sqlite-wasm` + `createSqliteWasmAdapter` + `serveWikiWorker` inside the Worker.
3. Make it explicit that `llmProvider` is constructed inside the Worker.
4. Replace or annotate any existing `sql.js` example (if present) to note that `sql.js` does not include FTS5.

The `packages/expo/README.md` web setup section should:

1. Distinguish Expo native from Expo web.
2. Keep the current native `createWiki(db, options)` example unchanged.
3. Add an Expo web example using `@equationalapplications/expo-llm-wiki/web` on the main thread, while noting that the Worker file imports browser-runtime helpers from `@equationalapplications/react-llm-wiki`.

Minimal examples to include:

**React web, main thread:**

```typescript
import { WikiProvider } from '@equationalapplications/react-llm-wiki';
import { createWikiWorkerClient } from '@equationalapplications/react-llm-wiki/web';

const worker = new Worker(new URL('./wiki.worker.ts', import.meta.url), { type: 'module' });
const wiki = createWikiWorkerClient(worker);

export default function App() {
  return (
    <WikiProvider wiki={wiki}>
      <YourApp />
    </WikiProvider>
  );
}
```

**Worker (recommended for persistence):**

```typescript
// wiki.worker.ts
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';
import { createWiki } from '@equationalapplications/react-llm-wiki/js';
import { serveWikiWorker } from '@equationalapplications/react-llm-wiki/web';

const sqlite3 = await sqlite3InitModule();
const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 12 });
const rawDb = new poolUtil.OpfsSAHPoolDb('/wiki.db');
const adapter = createSqliteWasmAdapter(rawDb);
const wiki = createWiki(adapter, { llmProvider: workerLocalProvider });
await wiki.setup();
serveWikiWorker(wiki);
```

**Expo web, main thread convenience import:**

```typescript
import { WikiProvider } from '@equationalapplications/expo-llm-wiki';
import { createWikiWorkerClient } from '@equationalapplications/expo-llm-wiki/web';

const worker = new Worker(new URL('./wiki.worker.ts', import.meta.url), { type: 'module' });
const wiki = createWikiWorkerClient(worker);
```

Note: OPFS requires a Worker context. The README should direct users to the Worker setup section and explain that all real `wiki.*` operations and the `llmProvider` live inside the Worker.

---

## File Checklist

| File | Action |
|------|--------|
| `packages/react/src/WikiClient.ts` | Create local structural interface/type alias for provider + hook boundary |
| `packages/react/src/WikiContext.tsx` | Update to accept `WikiClient` instead of concrete `WikiMemory` |
| `packages/react/src/js.ts` | Widen helper signatures to `WikiClient` |
| `packages/react/src/adapters/sqliteWasm.ts` | Create |
| `packages/react/src/adapters.ts` | Create (barrel re-export, tsup entry) |
| `packages/react/src/web/createWikiWorkerClient.ts` | Create main-thread Worker proxy client |
| `packages/react/src/web/serveWikiWorker.ts` | Create Worker-side RPC server helper |
| `packages/react/src/web.ts` | Create (barrel re-export, tsup entry) |
| `packages/react/package.json` | Add `./adapters` and `./web` exports; `@sqlite.org/sqlite-wasm` optional peer dep + devDependency |
| `packages/react/tsup.config.ts` | Add `src/adapters.ts` and `src/web.ts` entries |
| `packages/react/vitest.config.ts` | Re-enable Node `*.test.ts` files while leaving hook tests disabled |
| `packages/react/__tests__/sqliteWasmAdapter.test.ts` | Create |
| `packages/react/__tests__/wikiWorkerClient.test.ts` | Create |
| `packages/react/README.md` | Update web setup section: main-thread client + Worker runtime examples |
| `packages/expo/src/web.ts` | Create thin re-export of React web helpers |
| `packages/expo/package.json` | Add optional `./web` export for Expo web convenience import |
| `packages/expo/README.md` | Update Expo web section to point at `./web` helper while keeping native setup unchanged |
| `README.md` (root) | Update web/vanilla and Expo web sections to recommend `@sqlite.org/sqlite-wasm` + Worker client/runtime helpers; annotate `sql.js` examples with FTS5 caveat |

---

## Open Questions

1. ~~**Type imports from `@sqlite.org/sqlite-wasm`**~~ — Resolved in design: use a local structural interface. `@sqlite.org/sqlite-wasm` is `devDependencies` + optional `peerDependencies` in `packages/react`. No runtime import in the adapter file.

2. **`lastInsertRowId` precision** — SQLite rowids are 64-bit integers. `db.selectValue('SELECT last_insert_rowid()')` returns a JS `number`. For the row counts used in `WikiMemory` this is safe (well within `Number.MAX_SAFE_INTEGER`), but worth noting.

3. ~~**OPFS persistence**~~ — In scope. The same `createSqliteWasmAdapter(db)` factory accepts any `oo1.DB` subclass including `OpfsDb` and `OpfsSAHPoolDb`. No separate adapter factory is needed. OPFS is exposed through a Worker runtime owned by `@equationalapplications/react-llm-wiki`.

4. ~~**Package placement**~~ — Resolved in design: browser-only sqlite-wasm, OPFS, and Worker client code live in `packages/react`; `packages/expo` may add only thin web re-exports/factories.

5. ~~**Main-thread React integration**~~ — Resolved in design: React hooks/provider widen to a structural `WikiClient` interface so they can consume either a real `WikiMemory` instance or a main-thread Worker proxy client.
