# Monorepo Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `expo-llm-wiki` into three packages — `@eq/wiki-core` (pure TS logic), `@eq/wiki-expo` (Expo/React Native wrapper), and `@eq/wiki-react` (React hooks + vanilla JS) — in a pnpm workspace monorepo.

**Architecture:** The key change is replacing the hardcoded `expo-sqlite` import in `WikiMemory.ts` with a generic `SQLiteAdapter` interface (pattern already exists in `src/__tests__/helpers/sqliteAdapter.ts`). Each platform package wraps its native driver behind that interface. The root package becomes a backward-compat re-export of `@eq/wiki-expo`.

**Tech Stack:** pnpm workspaces, tsup, TypeScript, Vitest, better-sqlite3 (tests), expo-sqlite (expo package), sql.js (optional, for wiki-react browser tests)

---

## File Structure

### New files created
```
pnpm-workspace.yaml
packages/
  core/
    package.json
    tsconfig.json
    tsup.config.ts
    src/
      index.ts               — public API (createWiki, types, utils)
      types.ts               — all types including SQLiteAdapter interface
      WikiMemory.ts          — adapter-based, no expo-sqlite import
      prompts.ts             — moved from src/prompts.ts
      db/
        schema.ts            — uses SQLiteAdapter, no expo-sqlite
        migrations.ts        — uses SQLiteAdapter, no expo-sqlite
      utils/
        formatContext.ts     — moved from src/utils/
        formatMemoryDump.ts  — moved from src/utils/
    __tests__/               — all existing tests (moved + updated imports)
      helpers/
        sqliteAdapter.ts     — promoted to first-class (same code, new import path)
        sqliteAdapter.test.ts
      chunkText.test.ts
      export.test.ts
      formatContext.test.ts
      formatMemoryDump.test.ts
      hasChanged.test.ts
      importDump.test.ts
      importDumpMerge.test.ts
      ingest.test.ts
      jobs.test.ts
      migrations.test.ts
      porterStemmer.test.ts
      prune.test.ts
      synonymMap.test.ts
      validateFact.test.ts
    vitest.config.ts

  expo/
    package.json
    tsconfig.json
    tsup.config.ts
    src/
      index.ts               — createWiki(db: SQLiteDatabase, opts) + re-exports core types + react hooks
      adapter.ts             — wraps expo-sqlite SQLiteDatabase → SQLiteAdapter

  react/
    package.json
    tsconfig.json
    tsup.config.ts
    src/
      index.ts               — hooks + WikiProvider + useWiki
      WikiContext.tsx        — moved from src/react/WikiContext.tsx
      useMemoryRead.ts       — moved from src/react/
      useWikiWrite.ts        — moved from src/react/
      useWikiMaintenance.ts  — moved from src/react/
      useWikiIngest.ts       — moved from src/react/
      useWikiForget.ts       — moved from src/react/
      useWikiExport.ts       — moved from src/react/
      useWikiHasChanged.ts   — moved from src/react/
```

### Modified files
```
package.json          — workspace root; scripts delegate to pnpm -r; exports become re-exports
tsconfig.json         — workspace root tsconfig (references packages/*)
```

### Deleted after migration
```
src/                  — all source moved into packages/core and packages/react
```

---

## Task 1: Initialize pnpm workspace root

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json` (root)

- [ ] **Step 1: Create pnpm-workspace.yaml**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 2: Update root package.json**

Replace the `scripts` and add `private: true`:

```json
{
  "name": "expo-llm-wiki-workspace",
  "private": true,
  "version": "2.3.0",
  "scripts": {
    "build": "pnpm -r build",
    "build:core": "pnpm --filter @eq/wiki-core build",
    "build:expo": "pnpm --filter @eq/wiki-expo build",
    "build:react": "pnpm --filter @eq/wiki-react build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "dev": "pnpm -r dev"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 3: Install pnpm if needed and verify workspace mode**

```bash
which pnpm || npm install -g pnpm
pnpm install
```

Expected: pnpm creates a `node_modules` at root with workspace symlinks.

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml package.json
git commit -m "chore: init pnpm workspace root"
```

---

## Task 2: Create `packages/core` scaffolding

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/tsup.config.ts`
- Create: `packages/core/vitest.config.ts`

- [ ] **Step 1: Create packages/core/package.json**

```json
{
  "name": "@eq/wiki-core",
  "version": "2.3.0",
  "description": "DB-agnostic core logic for LLM Wiki Memory.",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js",
      "import": "./dist/index.mjs"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "files": ["dist", "LICENSE", "README.md"],
  "license": "MIT",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org"
  },
  "engines": { "node": ">=20" },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "better-sqlite3": "^9.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 2: Create packages/core/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "skipLibCheck": true
  },
  "include": ["src", "__tests__"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create packages/core/tsup.config.ts**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

- [ ] **Step 4: Create packages/core/vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: Commit scaffolding**

```bash
git add packages/core/
git commit -m "chore(core): scaffold @eq/wiki-core package"
```

---

## Task 3: Add `SQLiteAdapter` interface to core types

**Files:**
- Create: `packages/core/src/types.ts`

The `SQLiteAdapter` interface replaces the direct `expo-sqlite` dependency. It matches what `src/__tests__/helpers/sqliteAdapter.ts` already implements.

- [ ] **Step 1: Copy `src/types.ts` to `packages/core/src/types.ts` and add `SQLiteAdapter`**

Copy the full contents of `src/types.ts` then add at the top (before `WikiConfig`):

```ts
/**
 * Platform-agnostic SQLite driver interface.
 * Each platform package (wiki-expo, wiki-react) provides an adapter
 * that wraps its native driver behind this interface.
 */
export interface SQLiteAdapter {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}
```

The full file `packages/core/src/types.ts` should be:

```ts
/**
 * Platform-agnostic SQLite driver interface.
 */
export interface SQLiteAdapter {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}

export interface WikiConfig {
  tablePrefix?: string;
  maxFtsResults?: number;
  pruneEventsAfter?: number;
  pruneRetainSoftDeletedFor?: number;
  autoLibrarianThreshold?: number;
  autoHealThreshold?: number;
  orphanAfterDays?: number | null;
  staleInferredAfterDays?: number | null;
  maxChunkLength?: number;
  chunkOverlap?: number;
  chunkConcurrency?: number;
  synonymMap?: Record<string, string[]>;
}

export interface WikiFact {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  tags: string[];
  confidence: 'certain' | 'inferred' | 'tentative';
  source_type: 'user_stated' | 'agent_inferred' | 'user_confirmed' | 'user_document';
  source_hash: string | null;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number;
  deleted_at: number | null;
}

export interface WikiTask {
  id: string;
  entity_id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'abandoned';
  priority: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  deleted_at: number | null;
}

export interface WikiEvent {
  id: string;
  entity_id: string;
  event_type: 'observation' | 'decision' | 'action' | 'outcome';
  summary: string;
  related_entry_id?: string | null;
  created_at: number;
}

export interface WikiCheckpoint {
  entity_id: string;
  heal_checkpoint: number;
  memory_checkpoint: number;
}

export interface ExtractedFact {
  title: string;
  body: string;
  tags: string[];
  confidence: 'certain' | 'inferred' | 'tentative';
}

export interface ExtractedTask {
  description: string;
  priority: number;
}

export interface LLMProvider {
  generateText: (params: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}

export interface WikiOptions {
  config?: WikiConfig;
  llmProvider: LLMProvider;
}

export interface MemoryBundle {
  facts: WikiFact[];
  tasks: WikiTask[];
  events: WikiEvent[];
}

export interface MemoryDump {
  generatedAt: number;
  entities: Record<string, MemoryBundle>;
}

export interface FormattedMemoryDump {
  manifest: string;
  files: Array<{ name: string; content: string }>;
}

export interface FormatContextOptions {
  format?: 'markdown' | 'plain';
  maxFacts?: number;
  maxTasks?: number;
  maxEvents?: number;
  includeConfidence?: boolean;
  includeTags?: boolean;
  factWeights?: {
    confidence?: number;
    accessCount?: number;
    recency?: number;
  };
}

export interface EntityStatus {
  entityId: string;
  factCount: number;
  taskCount: number;
  eventCount: number;
  oldestFact: number | null;
  newestFact: number | null;
  schemaVersion: number;
}

export class WikiBusyError extends Error {
  constructor(public readonly operation: string, public readonly entityId: string) {
    super(`WikiMemory is busy with "${operation}" for entity "${entityId}". Wait for it to complete before calling again.`);
    this.name = 'WikiBusyError';
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles the types file alone**

```bash
cd packages/core && npx tsc --noEmit --strict src/types.ts 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add SQLiteAdapter interface and core types"
```

---

## Task 4: Move `db/schema.ts` and `db/migrations.ts` to core

**Files:**
- Create: `packages/core/src/db/schema.ts`
- Create: `packages/core/src/db/migrations.ts`

Both currently import `* as SQLite from 'expo-sqlite'`. Replace those with the `SQLiteAdapter` interface.

- [ ] **Step 1: Create `packages/core/src/db/schema.ts`**

Replace `import * as SQLite from 'expo-sqlite'` with the adapter import, and replace all `SQLite.SQLiteDatabase` with `SQLiteAdapter`:

```ts
import type { SQLiteAdapter } from '../types';

export async function setupDatabase(db: SQLiteAdapter, prefix: string) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS ${prefix}entries (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL DEFAULT 'inferred',
      source_type TEXT NOT NULL DEFAULT 'agent_inferred',
      source_hash TEXT,
      source_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    -- ... (copy full SQL from src/db/schema.ts; only the import and parameter type changes)
  `);
  // Copy remaining execAsync calls verbatim from src/db/schema.ts
}
```

**Do this:** copy the full body of `src/db/schema.ts` into `packages/core/src/db/schema.ts`, then:
- Replace `import * as SQLite from 'expo-sqlite';` with `import type { SQLiteAdapter } from '../types';`
- Replace every `SQLite.SQLiteDatabase` with `SQLiteAdapter`

- [ ] **Step 2: Create `packages/core/src/db/migrations.ts`**

**Do this:** copy the full body of `src/db/migrations.ts` into `packages/core/src/db/migrations.ts`, then:
- Replace `import type * as SQLite from 'expo-sqlite';` with `import type { SQLiteAdapter } from '../types';`
- In the `Migration` interface, replace `run: (db: SQLite.SQLiteDatabase, prefix: string) => Promise<void>` with `run: (db: SQLiteAdapter, prefix: string) => Promise<void>`

The interface becomes:
```ts
import type { SQLiteAdapter } from '../types';

export interface Migration {
  version: number;
  description: string;
  run: (db: SQLiteAdapter, prefix: string) => Promise<void>;
}

export const CURRENT_SCHEMA_VERSION = 2; // match src/db/migrations.ts value
```

Copy the full `MIGRATIONS` array and `CURRENT_SCHEMA_VERSION` constant verbatim.

- [ ] **Step 3: Verify types**

```bash
cd packages/core && npx tsc --noEmit --strict src/db/schema.ts src/db/migrations.ts src/types.ts 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/db/
git commit -m "feat(core): move db schema and migrations to @eq/wiki-core"
```

---

## Task 5: Move `WikiMemory.ts` and `prompts.ts` to core

**Files:**
- Create: `packages/core/src/WikiMemory.ts`
- Create: `packages/core/src/prompts.ts`

This is the biggest change: remove `import * as SQLite from 'expo-sqlite'` and replace the `private db: SQLite.SQLiteDatabase` field with `private db: SQLiteAdapter`.

- [ ] **Step 1: Copy `src/prompts.ts` verbatim**

```bash
cp src/prompts.ts packages/core/src/prompts.ts
```

No changes needed — prompts are plain strings.

- [ ] **Step 2: Create `packages/core/src/WikiMemory.ts`**

Copy `src/WikiMemory.ts` in full, then apply these targeted changes:

**Change A — replace import:**
```ts
// OLD (remove this line):
import * as SQLite from 'expo-sqlite';

// NEW (add these):
import type { SQLiteAdapter } from './types';
```

**Change B — replace db field type in class body:**
```ts
// OLD:
export class WikiMemory {
  private db: SQLite.SQLiteDatabase;

// NEW:
export class WikiMemory {
  private db: SQLiteAdapter;
```

**Change C — replace constructor signature:**
```ts
// OLD:
  constructor(db: SQLite.SQLiteDatabase, options: WikiOptions) {

// NEW:
  constructor(db: SQLiteAdapter, options: WikiOptions) {
```

**Change D — update remaining imports (db and types are now relative):**
```ts
// Replace:
import { setupDatabase } from './db/schema';
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from './db/migrations';
import { WikiOptions, MemoryBundle, WikiEvent, WikiFact, WikiTask, WikiCheckpoint, ExtractedFact, ExtractedTask, WikiBusyError, EntityStatus } from './types';
import { LIBRARIAN_SYSTEM_PROMPT, HEAL_SYSTEM_PROMPT, INGEST_SYSTEM_PROMPT } from './prompts';
// (These paths are unchanged — they already match the core package layout)
```

All `this.db.runAsync`, `this.db.getAllAsync`, `this.db.getFirstAsync`, `this.db.execAsync`, `this.db.withTransactionAsync` calls are unchanged because `SQLiteAdapter` exposes the same method names as the test helper already uses.

- [ ] **Step 3: Verify `WikiMemory.ts` compiles**

```bash
cd packages/core && npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors. Fix any `expo-sqlite` reference that was missed.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/src/prompts.ts
git commit -m "feat(core): move WikiMemory to @eq/wiki-core with SQLiteAdapter"
```

---

## Task 6: Move utilities and create core `index.ts`

**Files:**
- Create: `packages/core/src/utils/formatContext.ts`
- Create: `packages/core/src/utils/formatMemoryDump.ts`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Copy utilities verbatim**

```bash
cp src/utils/formatContext.ts packages/core/src/utils/formatContext.ts
cp src/utils/formatMemoryDump.ts packages/core/src/utils/formatMemoryDump.ts
```

Check that their imports are relative (they should be — they only import from `../types`). Update any import path that references `../types` to still resolve correctly from `packages/core/src/utils/`.

- [ ] **Step 2: Create `packages/core/src/index.ts`**

```ts
export * from './types';
export { WikiMemory } from './WikiMemory';
export { formatContext } from './utils/formatContext';
export { formatMemoryDump } from './utils/formatMemoryDump';

export function createWiki(db: import('./types').SQLiteAdapter, options: import('./types').WikiOptions): WikiMemory {
  return new WikiMemory(db, options);
}
```

- [ ] **Step 3: Build core**

```bash
cd packages/core && pnpm build
```

Expected: `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts` created with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/utils/ packages/core/src/index.ts
git commit -m "feat(core): add utils and index — @eq/wiki-core buildable"
```

---

## Task 7: Move tests to `packages/core`

**Files:**
- Create: `packages/core/__tests__/helpers/sqliteAdapter.ts`
- Create: `packages/core/__tests__/helpers/sqliteAdapter.test.ts`
- Create: `packages/core/__tests__/*.test.ts` (all 14 test files)

- [ ] **Step 1: Copy test helpers**

```bash
mkdir -p packages/core/__tests__/helpers
cp src/__tests__/helpers/sqliteAdapter.ts packages/core/__tests__/helpers/sqliteAdapter.ts
cp src/__tests__/helpers/sqliteAdapter.test.ts packages/core/__tests__/helpers/sqliteAdapter.test.ts
```

Update the import in `packages/core/__tests__/helpers/sqliteAdapter.ts`:
- Remove `import type * as SQLite from 'expo-sqlite';`
- Change return type from `SQLite.SQLiteDatabase` to `SQLiteAdapter` (imported from `@eq/wiki-core` types, or relative `../../src/types`)

The updated file:
```ts
import Database from 'better-sqlite3';
import type { SQLiteAdapter } from '../../src/types';

export function openTestDatabase(): SQLiteAdapter {
  const db = new Database(':memory:');

  return {
    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },

    async runAsync(sql: string, args: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...(args as any[]));
      return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
    },

    async getAllAsync<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...(args as any[])) as T[];
    },

    async getFirstAsync<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...(args as any[]));
      return (row ?? null) as T | null;
    },

    async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
      db.exec('BEGIN');
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    async closeAsync(): Promise<void> {
      db.close();
    },
  };
}
```

- [ ] **Step 2: Copy all test files**

```bash
cp src/__tests__/chunkText.test.ts packages/core/__tests__/
cp src/__tests__/export.test.ts packages/core/__tests__/
cp src/__tests__/formatContext.test.ts packages/core/__tests__/
cp src/__tests__/formatMemoryDump.test.ts packages/core/__tests__/
cp src/__tests__/hasChanged.test.ts packages/core/__tests__/
cp src/__tests__/importDump.test.ts packages/core/__tests__/
cp src/__tests__/importDumpMerge.test.ts packages/core/__tests__/
cp src/__tests__/ingest.test.ts packages/core/__tests__/
cp src/__tests__/jobs.test.ts packages/core/__tests__/
cp src/__tests__/migrations.test.ts packages/core/__tests__/
cp src/__tests__/porterStemmer.test.ts packages/core/__tests__/
cp src/__tests__/prune.test.ts packages/core/__tests__/
cp src/__tests__/synonymMap.test.ts packages/core/__tests__/
cp src/__tests__/validateFact.test.ts packages/core/__tests__/
```

- [ ] **Step 3: Update import paths in copied test files**

Each test file currently imports from `'../WikiMemory'` or `'../types'` (relative to `src/__tests__/`). In `packages/core/__tests__/`, those become `'../src/WikiMemory'`, `'../src/types'`, etc.

Run a bulk find-replace:
```bash
cd packages/core/__tests__
# Replace '../WikiMemory' → '../src/WikiMemory'
find . -name '*.test.ts' -exec sed -i '' "s|from '\.\./WikiMemory'|from '../src/WikiMemory'|g" {} +
# Replace '../types' → '../src/types'  
find . -name '*.test.ts' -exec sed -i '' "s|from '\.\./types'|from '../src/types'|g" {} +
# Replace '../utils/' → '../src/utils/'
find . -name '*.test.ts' -exec sed -i '' "s|from '\.\./utils/|from '../src/utils/|g" {} +
# Replace '../db/' → '../src/db/'
find . -name '*.test.ts' -exec sed -i '' "s|from '\.\./db/|from '../src/db/|g" {} +
# Replace '../prompts' → '../src/prompts'
find . -name '*.test.ts' -exec sed -i '' "s|from '\.\./prompts'|from '../src/prompts'|g" {} +
# Update helper import
find . -name '*.test.ts' -exec sed -i '' "s|from '\./helpers/sqliteAdapter'|from './helpers/sqliteAdapter'|g" {} +
```

- [ ] **Step 4: Run core tests**

```bash
cd packages/core && pnpm test
```

Expected: all tests pass. If any test fails due to an import path that wasn't caught by the sed above, fix it manually.

- [ ] **Step 5: Commit**

```bash
git add packages/core/__tests__/
git commit -m "test(core): migrate test suite to @eq/wiki-core"
```

---

## Task 8: Create `packages/expo`

**Files:**
- Create: `packages/expo/package.json`
- Create: `packages/expo/tsconfig.json`
- Create: `packages/expo/tsup.config.ts`
- Create: `packages/expo/src/adapter.ts`
- Create: `packages/expo/src/index.ts`

- [ ] **Step 1: Create `packages/expo/package.json`**

```json
{
  "name": "@eq/wiki-expo",
  "version": "2.3.0",
  "description": "Expo/React Native adapter for @eq/wiki-core.",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js",
      "import": "./dist/index.mjs"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "files": ["dist", "LICENSE", "README.md"],
  "license": "MIT",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org"
  },
  "dependencies": {
    "@eq/wiki-core": "workspace:*"
  },
  "peerDependencies": {
    "expo-sqlite": "^14.0.0 || ^15.0.0 || ^55.0.0",
    "react": ">=17"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `packages/expo/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/expo/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['react', 'expo-sqlite', '@eq/wiki-core'],
});
```

- [ ] **Step 4: Create `packages/expo/src/adapter.ts`**

This wraps `expo-sqlite`'s `SQLiteDatabase` behind `SQLiteAdapter`:

```ts
import type * as SQLite from 'expo-sqlite';
import type { SQLiteAdapter } from '@eq/wiki-core';

export function createExpoAdapter(db: SQLite.SQLiteDatabase): SQLiteAdapter {
  return {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: async (sql, params = []) => {
      const result = await db.runAsync(sql, params as any[]);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    getAllAsync: (sql, params = []) => db.getAllAsync(sql, params as any[]),
    getFirstAsync: (sql, params = []) => db.getFirstAsync(sql, params as any[]),
    withTransactionAsync: (fn) => db.withTransactionAsync(fn),
    closeAsync: () => db.closeAsync(),
  };
}
```

- [ ] **Step 5: Create `packages/expo/src/index.ts`**

```ts
import type * as SQLite from 'expo-sqlite';
import { WikiMemory, type WikiOptions } from '@eq/wiki-core';
import { createExpoAdapter } from './adapter';

export * from '@eq/wiki-core';

export function createWiki(db: SQLite.SQLiteDatabase, options: WikiOptions): WikiMemory {
  return new WikiMemory(createExpoAdapter(db), options);
}
```

- [ ] **Step 6: Install workspace deps and typecheck**

```bash
pnpm install
cd packages/expo && pnpm typecheck 2>&1 | head -30
```

Expected: no errors (expo-sqlite types resolve via peerDeps).

- [ ] **Step 7: Commit**

```bash
git add packages/expo/
git commit -m "feat(expo): add @eq/wiki-expo with expo-sqlite adapter"
```

---

## Task 9: Create `packages/react`

**Files:**
- Create: `packages/react/package.json`
- Create: `packages/react/tsconfig.json`
- Create: `packages/react/tsup.config.ts`
- Create: `packages/react/src/index.ts`
- Create: `packages/react/src/WikiContext.tsx`
- Create: `packages/react/src/useMemoryRead.ts`
- Create: `packages/react/src/useWikiWrite.ts`
- Create: `packages/react/src/useWikiMaintenance.ts`
- Create: `packages/react/src/useWikiIngest.ts`
- Create: `packages/react/src/useWikiForget.ts`
- Create: `packages/react/src/useWikiExport.ts`
- Create: `packages/react/src/useWikiHasChanged.ts`

- [ ] **Step 1: Create `packages/react/package.json`**

```json
{
  "name": "@eq/wiki-react",
  "version": "2.3.0",
  "description": "React hooks for @eq/wiki-core.",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js",
      "import": "./dist/index.mjs"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "files": ["dist", "LICENSE", "README.md"],
  "license": "MIT",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org"
  },
  "dependencies": {
    "@eq/wiki-core": "workspace:*"
  },
  "peerDependencies": {
    "react": ">=17"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `packages/react/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/react/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['react', '@eq/wiki-core'],
});
```

- [ ] **Step 4: Copy hook files from `src/react/`**

```bash
mkdir -p packages/react/src
cp src/react/WikiContext.tsx packages/react/src/WikiContext.tsx
cp src/react/useMemoryRead.ts packages/react/src/useMemoryRead.ts
cp src/react/useWikiWrite.ts packages/react/src/useWikiWrite.ts
cp src/react/useWikiMaintenance.ts packages/react/src/useWikiMaintenance.ts
cp src/react/useWikiIngest.ts packages/react/src/useWikiIngest.ts
cp src/react/useWikiForget.ts packages/react/src/useWikiForget.ts
cp src/react/useWikiExport.ts packages/react/src/useWikiExport.ts
cp src/react/useWikiHasChanged.ts packages/react/src/useWikiHasChanged.ts
```

- [ ] **Step 5: Update imports in copied hook files**

Each hook imports `WikiMemory` or types from a relative path (`'../WikiMemory'` or `'../types'`). Update to `'@eq/wiki-core'`:

```bash
cd packages/react/src
find . -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  "s|from '\.\./WikiMemory'|from '@eq/wiki-core'|g"
find . -name '*.ts' -o -name '*.tsx' | xargs sed -i '' \
  "s|from '\.\./types'|from '@eq/wiki-core'|g"
```

Also update `WikiContext.tsx` which imports `WikiMemory` from `'../WikiMemory'`:
```ts
// packages/react/src/WikiContext.tsx — final result:
import React, { createContext, useContext, type ReactNode } from 'react';
import { WikiMemory } from '@eq/wiki-core';

const WikiContext = createContext<WikiMemory | null>(null);

export function WikiProvider({ wiki, children }: { wiki: WikiMemory; children: ReactNode }) {
  return <WikiContext.Provider value={wiki}>{children}</WikiContext.Provider>;
}

export function useWiki(): WikiMemory {
  const wiki = useContext(WikiContext);
  if (!wiki) throw new Error('useWiki must be used within WikiProvider');
  return wiki;
}
```

- [ ] **Step 6: Create `packages/react/src/index.ts`**

```ts
export { WikiProvider, useWiki } from './WikiContext';
export { useMemoryRead } from './useMemoryRead';
export { useWikiWrite } from './useWikiWrite';
export { useWikiMaintenance } from './useWikiMaintenance';
export type { MaintenanceResult } from './useWikiMaintenance';
export { useWikiIngest } from './useWikiIngest';
export { useWikiForget } from './useWikiForget';
export { useWikiExport } from './useWikiExport';
export { useWikiHasChanged } from './useWikiHasChanged';
```

- [ ] **Step 7: Install deps and typecheck**

```bash
pnpm install
cd packages/react && pnpm typecheck 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/react/
git commit -m "feat(react): add @eq/wiki-react hooks package"
```

---

## Task 10: Update root package as backward-compat alias for `@eq/wiki-expo`

The original `@equationalapplications/expo-llm-wiki` package continues to work for existing consumers by re-exporting from `@eq/wiki-expo`.

**Files:**
- Modify: `package.json` (root)
- Modify: `src/index.ts` (root entry)
- Modify: `src/react/index.ts` (root react entry)

- [ ] **Step 1: Update root `package.json` to depend on workspace packages**

```json
{
  "name": "@equationalapplications/expo-llm-wiki",
  "version": "3.0.0",
  "description": "LLM Wiki Memory for Expo/React Native. Alias for @eq/wiki-expo.",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js",
      "import": "./dist/index.mjs"
    },
    "./react": {
      "types": "./dist/react/index.d.ts",
      "require": "./dist/react/index.js",
      "import": "./dist/react/index.mjs"
    }
  },
  "scripts": {
    "build": "pnpm -r build && tsup src/index.ts src/react/index.ts --format cjs,esm --dts --external react --external expo-sqlite --external @eq/wiki-core --out-dir dist",
    "dev": "tsup src/index.ts src/react/index.ts --format cjs,esm --dts --external react --external expo-sqlite --external @eq/wiki-core --out-dir dist --watch",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  },
  "dependencies": {
    "@eq/wiki-core": "workspace:*",
    "@eq/wiki-expo": "workspace:*",
    "@eq/wiki-react": "workspace:*"
  },
  "peerDependencies": {
    "expo-sqlite": "^14.0.0 || ^15.0.0 || ^55.0.0",
    "react": ">=17"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  }
}
```

- [ ] **Step 2: Replace `src/index.ts` with a re-export**

```ts
// Backward compat: re-export everything from @eq/wiki-expo
export * from '@eq/wiki-expo';
```

- [ ] **Step 3: Replace `src/react/index.ts` with a re-export**

```ts
// Backward compat: re-export everything from @eq/wiki-react
export * from '@eq/wiki-react';
```

- [ ] **Step 4: Build root**

```bash
pnpm install && pnpm build
```

Expected: root `dist/` built. All three packages also build as part of `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/react/index.ts package.json
git commit -m "feat: root package is now backward-compat alias for @eq/wiki-expo v3.0.0"
```

---

## Task 11: Update root tsconfig.json for workspace references

**Files:**
- Modify: `tsconfig.json`

- [ ] **Step 1: Update root `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "jsx": "react-jsx"
  },
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/expo" },
    { "path": "./packages/react" }
  ]
}
```

- [ ] **Step 2: Run full typecheck**

```bash
pnpm typecheck
```

Expected: all packages typecheck clean.

- [ ] **Step 3: Run all tests**

```bash
pnpm test
```

Expected: all `packages/core` tests pass. `packages/expo` and `packages/react` have no tests yet (thin wrappers).

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json
git commit -m "chore: add workspace project references to root tsconfig"
```

---

## Task 12: Delete old `src/` source files (keep tests for reference until CI green)

After all packages are built and tests pass, remove the now-duplicate source from `src/`.

- [ ] **Step 1: Verify `pnpm test` passes from root**

```bash
pnpm test
```

Expected: all tests green. If anything fails, fix before continuing.

- [ ] **Step 2: Delete old source (keep `src/__tests__` temporarily as reference)**

```bash
rm src/index.ts src/types.ts src/WikiMemory.ts src/prompts.ts
rm -rf src/db src/utils src/react
```

- [ ] **Step 3: Run tests again**

```bash
pnpm test
```

Expected: still green (tests now live exclusively in `packages/core/__tests__`).

- [ ] **Step 4: Delete remaining `src/__tests__`**

```bash
rm -rf src/__tests__
```

- [ ] **Step 5: Final build + test**

```bash
pnpm build && pnpm test
```

Expected: clean build, all tests green.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: remove src/ — source now lives in packages/core and packages/react"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ `@eq/wiki-core` — pure TS, no runtime deps, adapter interface, all business logic
- ✅ `@eq/wiki-expo` — expo-sqlite adapter, re-exports core, React hooks via `@eq/wiki-react`
- ✅ `@eq/wiki-react` — all React hooks, `WikiProvider`, `useWiki`
- ✅ Root package backward compat (`@equationalapplications/expo-llm-wiki`)
- ✅ pnpm workspaces
- ✅ Versioning locked (all `2.3.0` → bump to `3.0.0` at root for major signal)
- ✅ `better-sqlite3` test adapter promoted to `SQLiteAdapter` type
- ✅ All existing tests migrated to `packages/core`

**Type consistency:**
- `SQLiteAdapter` defined in Task 3, used in Tasks 4, 5, 7, 8 — consistent
- `createWiki` signature: `(db: SQLiteAdapter, options: WikiOptions): WikiMemory` in core; `(db: SQLite.SQLiteDatabase, options: WikiOptions): WikiMemory` in expo — consistent with spec
- `WikiMemory` imported from `@eq/wiki-core` in all downstream packages — consistent
