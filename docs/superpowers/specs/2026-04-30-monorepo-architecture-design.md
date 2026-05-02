# Monorepo Architecture: Cross-Platform Wiki Support

**Status:** Implemented
**Date:** May 2, 2026  
**Motivation:** Enable `expo-llm-wiki` to work across Expo, web (React/Vue/Svelte/vanilla JS), and Node.js backends without coupling consumers to unnecessary dependencies.

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
│   ├── core/           # @eq/wiki-core
│   ├── expo/           # @eq/wiki-expo
│   └── react/          # @eq/wiki-react
├── package.json        # workspace root (pnpm/yarn workspaces)
├── pnpm-workspace.yaml
└── docs/
    └── superpowers/specs/...
```

### **Package 1: `@eq/wiki-core` — DB-Agnostic Core**

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
  allAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  runAsync(sql: string, params?: unknown[]): Promise<{ lastInsertRowid?: number }>;
  withTransactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}
```

**Dependencies:**
- None (zero runtime deps)
- Peer deps: None

**Publishing:** `@eq/wiki-core@x.y.z`

---

### **Package 2: `@eq/wiki-expo` — Expo + React Native**

**Purpose:** Turn-key wrapper for Expo users.

**Exports:**
- `createWiki(db, options)` — pre-bound to `expo-sqlite`
- Re-exports core types
- React hooks (if applicable; imported from `@eq/wiki-react`)

**Usage:**
```ts
import * as SQLite from 'expo-sqlite';
import { createWiki } from '@eq/wiki-expo';

const db = await SQLite.openDatabaseAsync('my-app.db');
const wiki = await createWiki(db, { llmProvider: ... });
```

**Dependencies:**
- `@eq/wiki-core`
- `expo-sqlite` (peer)
- `react` (peer, for hooks re-export)

**Compatibility:** Works with Expo 50+, react-native-web (same `expo-sqlite` API).

**Publishing:** `@eq/wiki-expo@x.y.z`

---

### **Package 3: `@eq/wiki-react` — Web + Framework-Agnostic**

**Purpose:** React hooks + vanilla JS utilities for web, works with any JS framework or plain HTML.

**Two Entry Points:**

**1. Vanilla JS (primary):**
```ts
import { createWiki, read, write } from '@eq/wiki-react';

const wiki = await createWiki(sqlJsAdapter, options);
const facts = await wiki.read('entity-1', 'query');
await wiki.write({ entityId: 'entity-1', event: { ... } });
```

**2. React Hooks (optional, same export path):**
```ts
import { useWikiRead, useWikiWrite, useWikiMaintenance } from '@eq/wiki-react';

const facts = useWikiRead(wiki, 'entity-1', 'query');
const { write } = useWikiWrite(wiki);
```

**Adapter Choices (Consumer Picks):**
- **Browser:** `sql.js` (pure WASM, offline)
- **Node.js:** `better-sqlite3` (sync, fast)
- **Hybrid:** Any adapter implementing the interface

**Dependencies:**
- `@eq/wiki-core`
- `react` (peer, optional — only for `/react` export)

**Publishing:** `@eq/wiki-react@x.y.z`

---

## Usage Patterns

### Expo App
```ts
// package.json
{
  "dependencies": {
    "@eq/wiki-expo": "^2.0.0",
    "expo-sqlite": "^15.0.0"
  }
}

// app.ts
import { createWiki } from '@eq/wiki-expo';
const wiki = await createWiki(db, opts);
```

### React Web App (Vite)
```ts
// package.json
{
  "dependencies": {
    "@eq/wiki-react": "^2.0.0",
    "sql.js": "^1.10.0"
  }
}

// app.tsx
import { useWikiRead } from '@eq/wiki-react';
import initSqlJs from 'sql.js';

const adapter = await initSqlJs().then(...);
const wiki = await createWiki(adapter, opts);
const facts = useWikiRead(wiki, ...);
```

### Vanilla JS (HTML + Vite)
```ts
// package.json
{
  "dependencies": {
    "@eq/wiki-react": "^2.0.0",
    "sql.js": "^1.10.0"
  }
}

// main.js
import { createWiki } from '@eq/wiki-react';
import initSqlJs from 'sql.js';

const wiki = await createWiki(sqlJsAdapter, opts);
const facts = await wiki.read('entity-1', 'query');
```

### Vue / Svelte
```ts
// Same as vanilla JS above; framework has no bearing
import { createWiki } from '@eq/wiki-react';
const wiki = await createWiki(adapter, opts);
```

### Node.js Backend
```ts
import { createWiki } from '@eq/wiki-core';
import Database from 'better-sqlite3';

const adapter = wrapBetterSqlite3(db); // thin wrapper
const wiki = await createWiki(adapter, opts);
```

---

## Migration Path

### Phase 1: Extract Core
1. Move DB-agnostic logic → `packages/core/src/`
2. Create adapter interface
3. Update `WikiMemory.ts` to accept adapter
4. Build + publish `@eq/wiki-core`

### Phase 2: Wrap Expo
1. Create `packages/expo/`
2. Import + re-export `@eq/wiki-core`
3. Bind `expo-sqlite` adapter
4. Build + publish `@eq/wiki-expo`
5. Keep root `package.json` export for backward compat

### Phase 3: Web Utilities
1. Create `packages/react/`
2. Extract React hooks from current codebase
3. Export vanilla JS + React entry points
4. Build + publish `@eq/wiki-react`

### Backward Compatibility
- **Existing consumers:** Keep root package (aliased to `@eq/wiki-expo`)
- Default import still works: `import { createWiki } from '@eq/wiki-expo'`
- Major version bump (3.0.0) signals monorepo transition

---

## Dependency Graph

```
┌─────────────────────────────────────────┐
│         @eq/wiki-core                   │
│  (DB-agnostic logic, no deps)           │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
   ┌────▼────────┐    ┌────▼─────────────┐
   │@eq/wiki-expo│    │ @eq/wiki-react   │
   │             │    │  (vanilla + React)
   │ expo-sqlite │    │   sql.js /       │
   │ (peer)      │    │   better-sqlite3 │
   │ expo  (peer)│    │   (injected)     │
   └─────────────┘    └──────────────────┘
```

---

## Versioning Strategy

**Option 1:** Lock versions (monorepo style)
- All packages bump together: `@eq/wiki-core@3.0.0`, `@eq/wiki-expo@3.0.0`, `@eq/wiki-react@3.0.0`
- Single CHANGELOG.md
- Simpler, good for cohesive library

**Option 2:** Independent versions
- Each package versions independently
- Separate CHANGELOGs per package
- More flexibility, more complexity

**Decision:** Start with **Option 1** (lock versions). Can split later if needed.

---

## Testing Strategy

**`@eq/wiki-core` tests:**
- Existing Vitest suite, adapter-agnostic
- Use `better-sqlite3` adapter (Node.js test env)

**`@eq/wiki-expo` tests:**
- Thin wrapper, smoke tests only
- Verify `expo-sqlite` binding works

**`@eq/wiki-react` tests:**
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
✓ Web apps (Vite + React) can use `@eq/wiki-react` + `sql.js`  
✓ Vanilla JS apps work with any framework  
✓ Node.js backends can use `@eq/wiki-core` + `better-sqlite3`  
✓ No unnecessary dependencies in any consumer  
✓ Single, cohesive CHANGELOG reflects changes across monorepo  

---

## Open Questions / TBD

- Should `@eq/wiki-expo` also export React hooks, or keep them in `@eq/wiki-react` only?
- How to handle import paths for dual exports in `@eq/wiki-react` (`.` vs `/react`)?
- Publish to npm as separate packages or unified namespace (`@eq/wiki-*`)?
- What's the cutover strategy for existing npm users? (SemVer bump, docs, migration guide)

