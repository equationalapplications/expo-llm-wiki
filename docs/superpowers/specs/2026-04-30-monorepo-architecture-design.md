# Monorepo Architecture: Cross-Platform Wiki Support

**Status:** Implemented
**Last Reviewed:** May 2, 2026  
**Motivation:** Enable `expo-llm-wiki` to work across Expo, web (React/Vue/Svelte/vanilla JS), and Node.js backends without coupling consumers to unnecessary dependencies.
**Note:** Spec updated May 2, 2026 to align with shipped implementation: package names under `@equationalapplications/*`, actual adapter interface, and resolved open questions.

---

## Problem

Current package targets Expo + React Native only (`expo-sqlite` peer dep). Users want:
- Web apps (Vite + React, plain HTML/JS, etc.)
- Node.js backends
- Same core memory logic across all platforms

Constraint: Can't bundle both `expo-sqlite` (native) and web SQLite (WASM/pure JS) without bloating every install.

---

## Solution: Monorepo with 3 Packages

### Structure
```
expo-llm-wiki/
├── packages/
│   ├── core/           # @equationalapplications/core-llm-wiki
│   ├── expo/           # @equationalapplications/expo-llm-wiki
│   └── react/          # @equationalapplications/react-llm-wiki
├── package.json        # workspace root (private, not published)
├── pnpm-workspace.yaml
└── docs/
    └── superpowers/specs/...
```

### **Package 1: `@equationalapplications/core-llm-wiki` — DB-Agnostic Core**

**Purpose:** Pure TypeScript logic, zero framework/platform assumptions.

**Exports:**
- `createWiki(adapter, options)` — factory, adapter injected
- Type definitions: `WikiOptions`, `MemoryBundle`, `WikiEvent`, etc.
- Utilities: `parseJsonResponse`, `chunkText`, `porterStemmer`, etc.
- All business logic (librarian, heal, ingest, search)

**Adapter Interface:**
```ts
interface SQLiteAdapter {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}
```

**Dependencies:**
- None (zero runtime deps)
- Peer deps: None

**Publishing:** `@equationalapplications/core-llm-wiki@x.y.z`

---

### **Package 2: `@equationalapplications/expo-llm-wiki` — Expo + React Native**

**Purpose:** Turn-key wrapper for Expo users.

**Exports:**
- `createWiki(db, options)` — pre-bound to `expo-sqlite`
- Re-exports all `@equationalapplications/core-llm-wiki` types and React hooks from `@equationalapplications/react-llm-wiki`
- `./factory` subpath: `createWiki` only, without React hooks (for non-React Expo code)

**Usage:**
```ts
import * as SQLite from 'expo-sqlite';
import { createWiki } from '@equationalapplications/expo-llm-wiki';

const db = await SQLite.openDatabaseAsync('my-app.db');
const wiki = await createWiki(db, { llmProvider: ... });
```

**Dependencies:**
- `@equationalapplications/core-llm-wiki`
- `@equationalapplications/react-llm-wiki`
- `expo-sqlite` (peer)
- `react` (peer, for hooks re-export)

**Compatibility:** Works with Expo 50+, react-native-web (same `expo-sqlite` API).

**Publishing:** `@equationalapplications/expo-llm-wiki@x.y.z`

---

### **Package 3: `@equationalapplications/react-llm-wiki` — Web + Framework-Agnostic**

**Purpose:** React hooks + vanilla JS utilities for web, works with any JS framework or plain HTML.

**Single Entry Point (`"."`):**

**Vanilla JS:**
```ts
import { createWiki } from '@equationalapplications/react-llm-wiki';

const wiki = createWiki(sqlJsAdapter, options);
const facts = await wiki.read('entity-1', 'query');
await wiki.write('entity-1', { event_type: 'observation', summary: '...' });
```

**React Hooks (same import path):**
```ts
import { WikiProvider, useMemoryRead, useWikiWrite } from '@equationalapplications/react-llm-wiki';
```

**Adapter Choices (Consumer Picks):**
- **Browser:** `sql.js` (pure WASM, offline)
- **Node.js:** `better-sqlite3` (sync, fast)
- **Hybrid:** Any adapter implementing the interface

**Dependencies:**
- `@equationalapplications/core-llm-wiki`
- `react` (peer)

**Publishing:** `@equationalapplications/react-llm-wiki@x.y.z`

---

## Usage Patterns

### Expo App
```ts
// package.json
{
  "dependencies": {
    "@equationalapplications/expo-llm-wiki": "^2.0.0",
    "expo-sqlite": "^15.0.0"
  }
}

// app.ts
import { createWiki } from '@equationalapplications/expo-llm-wiki';
const wiki = await createWiki(db, opts);
```

### React Web App (Vite)
```ts
// package.json
{
  "dependencies": {
    "@equationalapplications/react-llm-wiki": "^2.0.0",
    "sql.js": "^1.10.0"
  }
}

// app.tsx
import { useMemoryRead, createWiki } from '@equationalapplications/react-llm-wiki';
import initSqlJs from 'sql.js';

const adapter = await initSqlJs().then(...);
const wiki = createWiki(adapter, opts);
const facts = useMemoryRead(wiki, ...);
```

### Vanilla JS (HTML + Vite)
```ts
// package.json
{
  "dependencies": {
    "@equationalapplications/react-llm-wiki": "^2.0.0",
    "sql.js": "^1.10.0"
  }
}

// main.js
import { createWiki } from '@equationalapplications/react-llm-wiki';
import initSqlJs from 'sql.js';

const wiki = createWiki(sqlJsAdapter, opts);
const facts = await wiki.read('entity-1', 'query');
```

### Vue / Svelte
```ts
// Same as vanilla JS above; framework has no bearing
import { createWiki } from '@equationalapplications/react-llm-wiki';
const wiki = createWiki(adapter, opts);
```

### Node.js Backend
```ts
import { createWiki } from '@equationalapplications/core-llm-wiki';
import Database from 'better-sqlite3';

const adapter = wrapBetterSqlite3(db); // thin wrapper
const wiki = createWiki(adapter, opts);
```

---

## Migration Path

### Phase 1: Extract Core
1. Move DB-agnostic logic → `packages/core/src/`
2. Create adapter interface
3. Update `WikiMemory.ts` to accept adapter
4. Build + publish `@equationalapplications/core-llm-wiki`

### Phase 2: Wrap Expo
1. Create `packages/expo/`
2. Import + re-export `@equationalapplications/core-llm-wiki`
3. Bind `expo-sqlite` adapter
4. Build + publish `@equationalapplications/expo-llm-wiki`
5. Keep root `package.json` export for backward compat

### Phase 3: Web Utilities
1. Create `packages/react/`
2. Extract React hooks from current codebase
3. Export vanilla JS + React entry points
4. Build + publish `@equationalapplications/react-llm-wiki`

### Backward Compatibility
- Root package is now `private`; the `@equationalapplications/expo-llm-wiki` name is owned by `packages/expo` directly.
- Default import still works: `import { createWiki } from '@equationalapplications/expo-llm-wiki'`
- Major version bump (3.0.0) signals monorepo transition

---

## Dependency Graph

```
@equationalapplications/core-llm-wiki        ← no deps
 ├── @equationalapplications/expo-llm-wiki   ← peer: expo-sqlite, react
 └── @equationalapplications/react-llm-wiki  ← peer: react; consumer brings adapter
```

---

## Versioning Strategy

**Option 1:** Lock versions (monorepo style)
- All packages bump together: `@equationalapplications/core-llm-wiki@3.0.0`, `@equationalapplications/expo-llm-wiki@3.0.0`, `@equationalapplications/react-llm-wiki@3.0.0`
- Single CHANGELOG.md
- Simpler, good for cohesive library

**Option 2:** Independent versions
- Each package versions independently
- Separate CHANGELOGs per package
- More flexibility, more complexity

**Decision:** Start with **Option 1** (lock versions). Can split later if needed.

---

## Testing Strategy

**`@equationalapplications/core-llm-wiki` tests:**
- Existing Vitest suite, adapter-agnostic
- Use `better-sqlite3` adapter (Node.js test env)

**`@equationalapplications/expo-llm-wiki` tests:**
- Thin wrapper, smoke tests only
- Verify `expo-sqlite` binding works

**`@equationalapplications/react-llm-wiki` tests:**
- Vanilla JS: core tests reused
- React: hook tests (mount/update/unmount)
- Can test with `sql.js` in Node (WASM works in Vitest)

---

## Build & Publishing

**Build script (root `package.json`):**
```json
{
  "scripts": {
    "build": "pnpm -r build",
    "build:core": "cd packages/core && tsup",
    "build:expo": "cd packages/expo && tsup",
    "build:react": "cd packages/react && tsup"
  }
}
```

**Each package exports:**
- `dist/index.js` (CJS)
- `dist/index.mjs` (ESM)
- `dist/index.d.ts` (types)
- Conditional exports in `package.json`

**Publishing (pnpm):**
```bash
pnpm -r publish
```

---

## Success Criteria

✓ Expo apps work unchanged (or minimal migration)  
✓ Web apps (Vite + React) can use `@equationalapplications/react-llm-wiki` + `sql.js`  
✓ Vanilla JS apps work with any framework  
✓ Node.js backends can use `@equationalapplications/core-llm-wiki` + `better-sqlite3`  
✓ No unnecessary dependencies in any consumer  
✓ Single, cohesive CHANGELOG reflects changes across monorepo  

---

## Open Questions / TBD

- ~~Should `@equationalapplications/expo-llm-wiki` also export React hooks?~~ **Resolved:** Yes, expo re-exports all hooks from `@equationalapplications/react-llm-wiki`.
- ~~How to handle import paths for dual exports in `@equationalapplications/react-llm-wiki`?~~ **Resolved:** Single `"."` entry point; hooks and `createWiki` share the same import path.
- ~~Publish to npm as separate packages or unified namespace?~~ **Resolved:** `@equationalapplications/*` namespace.
- What's the cutover strategy for existing npm users? (SemVer bump, docs, migration guide)

