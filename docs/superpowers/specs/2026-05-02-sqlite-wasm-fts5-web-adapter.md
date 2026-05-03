# Spec: sqlite-wasm FTS5 Web Adapter with Snapshot Rehydration

**Date:** 2026-05-02
**Status:** Draft

---

## Problem

`@equationalapplications/expo-llm-wiki` is broken on web (`react-native-web`). The `expo-sqlite` package uses `wa-sqlite` as its web runtime, and the bundled `wa-sqlite` build is compiled without `-DSQLITE_ENABLE_FTS5`. When `WikiMemory.setup()` runs on web, `CREATE VIRTUAL TABLE ... USING fts5(...)` throws. Any `read()` call with a non-empty query also fails because it relies on `MATCH` against the FTS5 table.

The previous OPFS design required a Web Worker. Expo Metro cannot support this: it fails to bundle module-type Workers required by `@sqlite.org/sqlite-wasm` (see spike results below). This spec removes the Worker and OPFS requirement. The web DB is in-memory, and durable state comes from snapshot rehydration. For Expo web, use the Vite bundler instead of Metro.

Alternatives evaluated and rejected:

- **`sql.js` (v1.14.1)** - Latest version. Makefile only enables `SQLITE_ENABLE_FTS3`. FTS5 is absent.
- **`sql.js-fts5`** - Abandoned fork from 2021 (v1.4.0). Cannot be relied on.
- **Custom FTS5 `wa-sqlite` package** - Rejected. It would require maintaining and publishing a custom SQLite WASM runtime.
- **OPFS-backed sqlite-wasm** - Rejected for this spec. OPFS requires a Worker-backed runtime, and Expo Metro cannot bundle module-type Workers (verified via spike testing). This spec avoids the Worker requirement entirely.

---

## Requirement

**Implement FTS5 full-text search in Expo (SDK 55+) on `react-native-web`, preserving wiki state across reloads through snapshot rehydration rather than persistent SQLite database storage.**

Persistence is no longer a literal SQLite file requirement. The required durable unit is the logical wiki state: facts, tasks, events, and mutations produced by document ingestion, `write()`, librarian, heal, forget, prune, and import flows. On reload, the app creates a new in-memory sqlite-wasm DB, restores a saved `MemoryDump`, and lets SQLite rebuild the FTS5 index from inserted rows.

---

## Goals

- Web users can use full FTS5 search with the `porter unicode61` tokenizer.
- The runtime uses `@sqlite.org/sqlite-wasm` on the main thread with `sqlite3.oo1.DB(':memory:', 'c')`.
- Expensive LLM-derived state survives reloads by saving `exportDump()` snapshots and restoring them with `importDump()`.
- Librarian, heal, prune, forget, write, ingest, and import mutations are preserved when the app saves a snapshot after successful mutation.
- The sqlite-wasm adapter lives in `@equationalapplications/react-llm-wiki` under `./adapters`.
- Optional snapshot helpers live in `@equationalapplications/react-llm-wiki` under `./snapshot`.
- `@equationalapplications/expo-llm-wiki` may add a thin `./web` convenience subpath that re-exports the React web adapter, snapshot helpers, and a web factory that accepts a core `SQLiteAdapter`.
- `@equationalapplications/core-llm-wiki` remains unchanged.
- Tests confirm FTS5 works and snapshot rehydration restores searchable state in a fresh in-memory DB.
- Documentation clearly recommends Vite as the supported Expo web bundler; Metro is not compatible.

## Non-Goals

- Persistent SQLite file storage on web.
- OPFS, SAHPool, standard OPFS VFS, COOP/COEP headers, or multi-tab SQLite file locking.
- Web Worker RPC helpers or a Worker-owned `WikiMemory`.
- Maintaining a custom FTS5 `wa-sqlite` or `expo-sqlite` fork.
- Automatic web environment detection and transparent adapter swapping.
- Polyfilling FTS5 on adapters that lack it.
- Changing the native Expo `createWiki(db, options)` path.

---

## Design

### Package Ownership

- `@equationalapplications/react-llm-wiki` owns browser-only sqlite-wasm code: the low-level adapter and optional snapshot helper utilities.
- `@equationalapplications/expo-llm-wiki` remains thin. Native usage keeps the current `expo-sqlite` adapter. Web usage may re-export React web helpers from `./web` for Expo-flavored import paths. The main `createWiki(db, options)` export stays native-bound to `expo-sqlite`; web must use a separate adapter-based factory.
- `@equationalapplications/core-llm-wiki` remains unchanged. It already exposes `exportDump()` and `importDump()`, which are the snapshot boundary.

### Package: `@sqlite.org/sqlite-wasm`

Use the official SQLite WASM package from the SQLite team. It includes FTS5 and the `porter`/`unicode61` tokenizers.

Use the OO1 API directly on the main thread:

```typescript
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const sqlite3 = await sqlite3InitModule({ print: console.log, printErr: console.error });
const rawDb = new sqlite3.oo1.DB(':memory:', 'c');
```

The OO1 API is synchronous. Adapter methods wrap calls in `Promise.resolve()` / `Promise.reject()` to satisfy the shared `SQLiteAdapter` interface.

### New file: `packages/react/src/adapters/sqliteWasm.ts`

Exports:

```typescript
export function createSqliteWasmAdapter(db: SqliteWasmDB): SQLiteAdapter
```

`SqliteWasmDB` is a local structural interface compatible with `sqlite3.oo1.DB`. The adapter file must not import `@sqlite.org/sqlite-wasm` at runtime, so the WASM binary is not pulled into this package entry. The consumer initializes sqlite-wasm and passes an open DB instance.

The adapter only needs these DB capabilities:

- `exec`
- `prepare`
- `changes`
- `selectValue`
- `close`

#### Method Implementations

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

`db.exec()` must accept multi-statement SQL because `setupDatabase()` sends full DDL in one call.

**`runAsync(sql, params?)`**

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
      lastInsertRowId: (db.selectValue('SELECT last_insert_rowid()') as number | undefined) ?? 0,
    });
  } catch (e) {
    return Promise.reject(e);
  }
}
```

Use `step()` plus `finalize()` rather than `stepFinalize()` inside another `finally`.

**`getAllAsync<T>(sql, params?)`**

```typescript
getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]> {
  try {
    const rows: T[] = [];
    db.exec({ sql, ...(params?.length ? { bind: params } : {}), resultRows: rows, rowMode: 'object' });
    return Promise.resolve(rows);
  } catch (e) {
    return Promise.reject(e);
  }
}
```

**`getFirstAsync<T>(sql, params?)`**

```typescript
async getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await this.getAllAsync<T>(sql, params);
  return rows[0] ?? null;
}
```

**`withTransactionAsync<T>(fn)`**

`db.transaction(fn)` cannot be used because `WikiMemory` transaction callbacks are async. Use explicit SQL:

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

**`closeAsync()`**

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

### Snapshot Rehydration

The sqlite-wasm DB is ephemeral. State persistence happens outside SQLite.

Existing core methods are the persistence boundary:

- `wiki.exportDump(entityIds?)`
- `wiki.importDump(dump, { merge? })`

Startup flow:

1. Initialize `@sqlite.org/sqlite-wasm`.
2. Create `new sqlite3.oo1.DB(':memory:', 'c')`.
3. Wrap it with `createSqliteWasmAdapter(rawDb)`.
4. Create `WikiMemory` with the adapter and `llmProvider`.
5. Call `wiki.setup()`.
6. Load the latest saved snapshot from durable storage.
7. Call `wiki.importDump(snapshot)`.
8. Render `WikiProvider` after restore completes.

Mutation flow:

1. Run the mutating operation.
2. If it succeeds, call `wiki.exportDump()`.
3. Store the serialized snapshot in durable browser storage.

Mutating operations that must trigger snapshot save:

- `write()`
- `ingestDocument()`
- `forget()`
- `runLibrarian()`
- `runHeal()`
- `runPrune()`
- `importDump()`

The FTS5 index is rebuilt during rehydration because `importDump()` inserts rows into the normal tables and the existing FTS triggers populate `${prefix}entries_fts`.

### Snapshot Storage

Recommended storage: IndexedDB.

Reason: snapshots can grow beyond `localStorage` limits, and IndexedDB is async. The package should not own a specific storage backend. It should expose small structural interfaces or helpers that let apps plug in IndexedDB, AsyncStorage-for-web shims, or a backend API.

`localStorage` is acceptable only for examples or tiny demos. It is synchronous and too small for meaningful document memory.

Backend/object storage remains application-owned. It can support cross-device restore, but it changes privacy and hosting assumptions.

### Optional Snapshot Helpers

Add `packages/react/src/snapshot.ts` for ergonomic helpers around existing core APIs.

Recommended structural store type:

```typescript
export interface WikiSnapshotStore {
  getSnapshot(): Promise<string | null>;
  setSnapshot(snapshot: string): Promise<void>;
  removeSnapshot?(): Promise<void>;
}
```

Recommended exports:

```typescript
export async function serializeWikiSnapshot(wiki: WikiMemory): Promise<string>;

export async function restoreWikiSnapshot(
  wiki: WikiMemory,
  snapshot: string | null,
  opts?: { merge?: boolean }
): Promise<void>;

export async function saveWikiSnapshot(
  wiki: WikiMemory,
  store: WikiSnapshotStore
): Promise<void>;

export async function restoreWikiSnapshotFromStore(
  wiki: WikiMemory,
  store: WikiSnapshotStore,
  opts?: { merge?: boolean }
): Promise<void>;
```

A wrapper helper may also be added to reduce missed saves. If added, it should return a structural client type rather than pretending to be an actual `WikiMemory` class instance:

```typescript
export type SnapshottingWikiClient = Pick<
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
  | 'importDump'
>;

export function createSnapshottingWiki(
  wiki: WikiMemory,
  store: WikiSnapshotStore,
  options?: { debounceMs?: number }
): SnapshottingWikiClient;
```

If implemented, the wrapper must save only after successful mutating calls. Failed mutations must not overwrite the last good snapshot.

### React Integration

No Worker proxy is required. `WikiProvider` can continue receiving a concrete `WikiMemory` instance.

React apps should delay rendering children until setup and snapshot restore are complete:

```typescript
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { WikiProvider } from '@equationalapplications/react-llm-wiki';
import { createWiki } from '@equationalapplications/react-llm-wiki/js';
import { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';
import { restoreWikiSnapshotFromStore, saveWikiSnapshot } from '@equationalapplications/react-llm-wiki/snapshot';

const sqlite3 = await sqlite3InitModule();
const rawDb = new sqlite3.oo1.DB(':memory:', 'c');
const adapter = createSqliteWasmAdapter(rawDb);
const wiki = createWiki(adapter, { llmProvider });

await wiki.setup();
await restoreWikiSnapshotFromStore(wiki, snapshotStore);

await wiki.ingestDocument('user-1', documentText, { sourceRef: 'upload.md' });
await saveWikiSnapshot(wiki, snapshotStore);
```

### Expo Web Integration

Native Expo usage stays unchanged:

```typescript
import * as SQLite from 'expo-sqlite';
import { createWiki } from '@equationalapplications/expo-llm-wiki';

const db = await SQLite.openDatabaseAsync('wiki.db');
const wiki = createWiki(db, { llmProvider });
await wiki.setup();
```

Expo web usage uses sqlite-wasm in memory plus snapshots. If `packages/expo/src/web.ts` is added, it should thinly re-export React web helpers:

```typescript
import { createWiki as createCoreWiki } from '@equationalapplications/core-llm-wiki';

export { createCoreWiki as createWebWiki };
export { createSqliteWasmAdapter } from '@equationalapplications/react-llm-wiki/adapters';
export {
  serializeWikiSnapshot,
  restoreWikiSnapshot,
  saveWikiSnapshot,
  restoreWikiSnapshotFromStore,
} from '@equationalapplications/react-llm-wiki/snapshot';
```

Then web consumers can use Expo-flavored imports:

```typescript
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteWasmAdapter, createWebWiki, restoreWikiSnapshotFromStore } from '@equationalapplications/expo-llm-wiki/web';

const sqlite3 = await sqlite3InitModule();
const rawDb = new sqlite3.oo1.DB(':memory:', 'c');
const wiki = createWebWiki(createSqliteWasmAdapter(rawDb), { llmProvider });
await wiki.setup();
await restoreWikiSnapshotFromStore(wiki, snapshotStore);
```

### Bundler and Deployment Requirements

This design removes the Worker requirement. It still requires loading the sqlite-wasm `.wasm` asset.

`@sqlite.org/sqlite-wasm` ships WASM binaries alongside its JS module. Bundlers that do not serve those assets correctly will cause `sqlite3InitModule()` to reject at runtime.

**Vite** - expected to work without extra configuration.

**webpack 5** - may require:

```javascript
module.exports = {
  experiments: { asyncWebAssembly: true },
};
```

**Next.js** - may require:

```javascript
const nextConfig = {
  webpack(config) {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};
```

**Expo web / Metro** - **NOT SUPPORTED.**

`@sqlite.org/sqlite-wasm` requires a Web Worker by default. On initialization, it tries to load `sqlite3-worker1.mjs` using `new Worker(new URL("sqlite3-worker1.mjs", import.meta.url), { type: "module" })`. Metro does not reliably bundle or serve module-type Workers, and it fails with "Unable to resolve sqlite3-worker1.mjs" at bundler time.

For Expo web projects, use **Vite bundler** instead:

```bash
npx expo start --web --bundler vite
```

Vite handles WASM and Worker imports automatically. This is the documented and supported path for Expo web development with sqlite-wasm.

#### Spike Testing

A spike was run on 2026-05-03 to verify Metro compatibility:

1. Created a clean Expo SDK 55 project using `npx create-expo-app --template default@sdk-55`
2. Installed `@sqlite.org/sqlite-wasm`
3. Added `wasm` to `metro.config.js` `assetExts`
4. Wrote a test app importing and initializing sqlite-wasm with FTS5
5. Ran `npx expo start --web`

**Result:** Metro bundler failed during compilation:
```
Web Bundling failed: Unable to resolve "sqlite3-worker1.mjs" 
from "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs"

Error at line 209: return new Worker(new URL("sqlite3-worker1.mjs", 
import.meta.url), { type: "module" });
```

**Conclusion:** This is a **fundamental incompatibility**. `@sqlite.org/sqlite-wasm` uses Worker mode by default, and Metro's bundler cannot resolve module-type Worker imports. No configuration change can fix this. Vite is the only supported Expo web path for sqlite-wasm.

### Export Subpaths

`packages/react/src/adapters.ts` barrel:

```typescript
export { createSqliteWasmAdapter } from './adapters/sqliteWasm';
```

`packages/react/src/snapshot.ts` exports snapshot helpers.

Add `./adapters` and `./snapshot` to `packages/react/package.json` exports:

```json
"./adapters": {
  "types": "./dist/adapters.d.ts",
  "import": "./dist/adapters.mjs",
  "require": "./dist/adapters.js"
},
"./snapshot": {
  "types": "./dist/snapshot.d.ts",
  "import": "./dist/snapshot.mjs",
  "require": "./dist/snapshot.js"
}
```

Add `src/adapters.ts` and `src/snapshot.ts` as tsup entries:

```typescript
entry: ['src/index.ts', 'src/js.ts', 'src/adapters.ts', 'src/snapshot.ts'],
```

If Expo web convenience re-exports are included, add `packages/expo/src/web.ts` and `./web` in `packages/expo/package.json`. This subpath must not imply persistent DB storage or Worker support.

### Peer Dependency

Add `@sqlite.org/sqlite-wasm` as an optional peer dependency in `packages/react/package.json`:

```json
"peerDependencies": {
  "@sqlite.org/sqlite-wasm": ">=3.46.0"
},
"peerDependenciesMeta": {
  "@sqlite.org/sqlite-wasm": { "optional": true }
}
```

Also add it to `packages/react` devDependencies for typecheck and tests.

It is optional for the package as a whole because native-only users do not need it. Docs must state that web users of `createSqliteWasmAdapter` must install it.

### Tests in `packages/react`

Update `packages/react/vitest.config.ts` to include `__tests__/**/*.test.ts` while leaving hook tests disabled by suffix. Node test files should include:

```typescript
// @vitest-environment node
```

Update the `test` script from the echo stub to `vitest run`.

Add tests:

1. `sqliteWasmAdapter.test.ts` - confirms `@sqlite.org/sqlite-wasm` + adapter + `WikiMemory` create FTS5 tables and return FTS5 search results.
2. `snapshotRehydration.test.ts` - exports a dump from one in-memory DB, creates a fresh in-memory DB, imports the dump, and verifies `read()` finds restored facts through FTS5.
3. Maintenance snapshot test - stubs `llmProvider`, runs `runLibrarian()` or `runHeal()`, snapshots, rehydrates, and verifies the changed state survives.
4. Snapshot helper tests - malformed JSON rejects clearly; failed save does not mutate the wiki; failed mutation does not overwrite the last good snapshot.

### README Updates

`packages/react/README.md` should:

1. Note that `expo-sqlite` on web lacks FTS5.
2. Show main-thread sqlite-wasm setup with `createSqliteWasmAdapter`.
3. Show snapshot restore before rendering `WikiProvider`.
4. Show snapshot save after mutating operations.
5. Recommend IndexedDB for snapshots.
6. Warn that `localStorage` is only for small demos.
7. Explain that this is not persistent SQLite DB storage.
8. Keep or add the `sql.js` FTS5 caveat.

`packages/expo/README.md` should:

1. Keep native `expo-sqlite` docs unchanged.
2. Add an Expo web section for sqlite-wasm in-memory + snapshot rehydration.
3. Explain that Expo web requires Vite bundler (`npx expo start --web --bundler vite`).
4. Document that stock Metro is not compatible with sqlite-wasm (spike-verified).
5. Use `@equationalapplications/expo-llm-wiki/web` examples only if the thin re-export is implemented.

Root `README.md` should:

1. Update web guidance to in-memory FTS5 + snapshot rehydration.
2. Remove OPFS/Worker as the recommended web path.
3. Mention Worker/OPFS as out of scope for this release.
4. Document the Metro caveat in the Expo web section.

---

## File Checklist

| File | Action |
|------|--------|
| `packages/react/src/adapters/sqliteWasm.ts` | Create sqlite-wasm adapter |
| `packages/react/src/adapters.ts` | Create barrel re-export |
| `packages/react/src/snapshot.ts` | Create snapshot helper utilities |
| `packages/react/package.json` | Add `./adapters`, `./snapshot`, optional sqlite-wasm peer + devDependency, real test script |
| `packages/react/tsup.config.ts` | Add `src/adapters.ts` and `src/snapshot.ts` entries |
| `packages/react/vitest.config.ts` | Enable Node `*.test.ts` files while hook tests stay disabled |
| `packages/react/__tests__/sqliteWasmAdapter.test.ts` | Create FTS5 integration test |
| `packages/react/__tests__/snapshotRehydration.test.ts` | Create snapshot export/import/FTS test |
| `packages/react/__tests__/snapshotHelpers.test.ts` | Create helper edge-case tests if helpers are added |
| `packages/react/README.md` | Document web adapter + snapshot rehydration |
| `packages/expo/src/web.ts` | Optional thin re-export of React adapter/snapshot helpers plus `createWebWiki` |
| `packages/expo/tsup.config.ts` | Add `src/web.ts` only if Expo web re-export is implemented |
| `packages/expo/package.json` | Add `./web` only if Expo web re-export is implemented |
| `packages/expo/README.md` | Document native vs web snapshot path and Metro caveat |
| `README.md` | Update web and Expo web sections |

---

## Open Questions

1. **Expo Metro WASM loading** - Still open. This design removes Workers, but stock Expo Metro must still prove it can serve `@sqlite.org/sqlite-wasm` assets.

2. **Snapshot helper scope** - Decide whether to ship only serialization helpers or also a mutation-wrapping `createSnapshottingWiki()` helper. The wrapper reduces missed saves but needs careful typing.

3. **Snapshot storage package** - Decide whether to provide an IndexedDB store helper. Recommended initial scope: document IndexedDB and expose only structural store helpers, not a storage implementation.

4. **Save cadence** - Recommended: save after every successful mutation, with optional debounce for repeated writes. Docs must warn that unsaved mutations can be lost on reload.

5. **Large snapshot performance** - Rehydration cost grows with snapshot size. Initial implementation should test reasonable document-memory sizes and document that very large stores may need backend sync or a future persistent DB path.
