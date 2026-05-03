# Spec: MiniSearch Web Fallback for expo-sqlite FTS5

**Date:** 2026-05-03
**Status:** Draft
**Supersedes:** `2026-05-02-sqlite-wasm-fts5-web-adapter.md` (deprecated)

---

## Problem

`@equationalapplications/expo-llm-wiki` is broken on web (`react-native-web`). The `expo-sqlite` web runtime ships without FTS5. When `WikiMemory.setup()` runs on web, `CREATE VIRTUAL TABLE ... USING fts5(...)` throws and the package is entirely unusable.

The sqlite-wasm approach (previous spec) was rejected because `@sqlite.org/sqlite-wasm` requires a Worker-type `Worker`, which Expo Metro cannot bundle. There is no viable path to FTS5 on Expo web at this time.

---

## Requirement

**The package must work on Expo web (`react-native-web`) with a gracefully degraded search path that uses MiniSearch instead of FTS5.**

No new WASM binary, no Worker, no SQLite fork. The web runtime continues to use `expo-sqlite`'s existing web storage layer for structured data; full-text search is handled entirely in JavaScript by MiniSearch.

---

## Goals

- `WikiMemory.setup()` does not throw on Expo web.
- `read(entityId, query)` returns relevant facts on web using MiniSearch.
- `WikiConfig.synonymMap` expansion is applied to MiniSearch queries (same config, different engine).
- `access_count` and `last_accessed_at` are updated on web reads, matching native behavior.
- All mutating operations (`write`, `ingestDocument`, `forget`, `runLibrarian`, `runHeal`, `runPrune`, `importDump`) work on web.
- MiniSearch index stays in sync with the entries table after each mutation.
- **`createWiki(db, options)` in `packages/expo` automatically uses the web path when `Platform.OS === 'web'`.** Developers use the same import and call on all platforms — no platform guard needed in user code.
- `packages/core` is **not modified**.
- `packages/react` (main entry) is **not modified**.

## Non-Goals

- FTS5 parity on web (not possible without WASM + Worker).
- Porter stemmer tokenization on web (MiniSearch uses its own tokenization).
- BM25 ranking parity (MiniSearch has its own TF-IDF scoring).
- OPFS, Worker, WASM, custom SQLite builds.
- Snapshot rehydration (orthogonal concern; out of scope here).

---

## Design

### Overview

Two new components are introduced:

1. **`FTS5SkipAdapter`** — a thin `SQLiteAdapter` wrapper that intercepts and neutralizes FTS5-specific DDL and queries. It passes all other SQL through to the wrapped adapter unchanged.
2. **`WebWikiClient`** — a wrapper around `WikiMemory` that maintains a MiniSearch index. It overrides `read()` to use MiniSearch when a query is present, and rebuilds the index after each mutating operation.

`createWebWiki(db, options)` in `packages/expo/src/web.ts` wires them together with the existing `createExpoAdapter`. The main `createWiki` factory in `packages/expo/src/index.ts` is updated to call `createWebWiki` automatically when `Platform.OS === 'web'`.

### Component: `FTS5SkipAdapter`

**File:** `packages/react/src/adapters/fts5Skip.ts`

Wraps any `SQLiteAdapter`. Intercepts calls as follows:

**`execAsync(sql)`**

Skip silently if `sql` contains any of:
- `USING fts5(` — CREATE VIRTUAL TABLE
- A trigger DDL targeting the FTS table (detect via `_fts` in the trigger body or name)

Detection is case-insensitive substring match. All other DDL passes through.

```typescript
const FTS5_PATTERNS = [/USING\s+fts5\s*\(/i, /_fts\b/i];

function hasFts5(sql: string): boolean {
  return FTS5_PATTERNS.some(p => p.test(sql));
}
```

`execAsync` can contain multiple statements (the core DDL is sent as one large string). The adapter must check whether the full string contains FTS5 patterns and, if so, strip the FTS5-related statements before forwarding the remainder.

**Approach for multi-statement `execAsync`:** Split on `;\n` (the DDL uses newlines), filter out statements matching FTS5 patterns, rejoin, and forward. If nothing remains after filtering, return `Promise.resolve()`.

**`getAllAsync(sql, params)`**

If `sql` contains `MATCH ?` (case-insensitive), return `Promise.resolve([])`. This short-circuits the FTS5 search path in `WikiMemory.read()`, which returns `[]` facts for that branch. The `WebWikiClient` overrides `read()` before it ever calls the underlying `WikiMemory.read()` with a non-empty query (see below), so this path is a defensive fallback.

**`getFirstAsync`, `runAsync`, `withTransactionAsync`, `closeAsync`**

All pass through to the wrapped adapter unchanged. The schema probe queries in `WikiMemory.setup()` that inspect `sqlite_master` for the FTS table will return `null` (table does not exist), which is safe — the migration logic tolerates missing FTS metadata.

### Component: `WebWikiClient` and auto-detection

**File:** `packages/expo/src/web.ts`

`createWebWiki` returns a plain object typed as `WikiMemory` (via `as unknown as WikiMemory`). The object implements the full public API of `WikiMemory` by delegating all methods to the wrapped `WikiMemory` instance. Only `setup()`, `read()`, `ingestDocument()`, `forget()`, `runLibrarian()`, `runHeal()`, `runPrune()`, and `importDump()` are overridden to maintain the MiniSearch index.

**Factory:**

```typescript
export function createWebWiki(
  db: SQLite.SQLiteDatabase,
  options: WikiOptions
): WikiMemory
```

Internally:
1. Creates a `FTS5SkipAdapter` wrapping `createExpoAdapter(db)`. Keeps a reference to the adapter for direct `runAsync` calls (e.g., `access_count` update).
2. Creates `new WikiMemory(fts5SkipAdapter, options)`. Keeps the `prefix` from `options.config?.tablePrefix ?? 'llm_wiki_'`.
3. Instantiates a MiniSearch instance and a `factCache: Map<string, WikiFact[]>`.
4. Returns a plain object implementing the full `WikiMemory` public API, cast as `WikiMemory`.

**Auto-detection in `packages/expo/src/index.ts`:**

```typescript
import { Platform } from 'react-native';
import { createWebWiki } from './web';

export function createWiki(db: SQLite.SQLiteDatabase, options: WikiOptions): WikiMemory {
  if (Platform.OS === 'web') {
    return createWebWiki(db, options);
  }
  return new WikiMemory(createExpoAdapter(db), options);
}
```

Developers use the same code on all platforms:

```typescript
import * as SQLite from 'expo-sqlite';
import { createWiki } from '@equationalapplications/expo-llm-wiki';

const db = await SQLite.openDatabaseAsync('wiki.db');
const wiki = createWiki(db, { llmProvider });
await wiki.setup();
```

### MiniSearch Configuration

```typescript
import MiniSearch from 'minisearch';

const miniSearch = new MiniSearch<{ id: string; entity_id: string; title: string; body: string; tags: string }>({
  fields: ['title', 'body', 'tags'],
  storeFields: ['entity_id'],
  searchOptions: {
    boost: { title: 2 },
    fuzzy: 0.2,
    prefix: true,
  },
});
```

Tags are stored as a space-joined string: `fact.tags.join(' ')`.

### Index Population

The index is populated from `wiki.exportDump()`. A `rebuildIndex(wiki, miniSearch, factCache)` helper (full signature in the `read()` Override section) is called:

- After `wiki.setup()`.
- After `ingestDocument()`, `runLibrarian()`, `runHeal()`, `importDump()`.
- After `forget()`, `runPrune()` (full rebuild keeps removal handling simple).

### Synonym Expansion Helper

`WikiMemory.formatSearchQuery` is private. The web client replicates the same token normalization and synonym lookup:

```typescript
function expandQuery(query: string, synonymMap?: Record<string, string[]>): string {
  const normalize = (v: string): string[] =>
    v.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 3);

  const tokens = normalize(query);
  const expanded: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => { if (!seen.has(t)) { seen.add(t); expanded.push(t); } };

  for (const t of tokens) {
    push(t);
    if (synonymMap) {
      for (const s of (synonymMap[t] ?? [])) {
        if (typeof s === 'string') normalize(s).forEach(push);
      }
    }
  }
  return expanded.join(' ');
}
```

### `read()` Override

**Problem with `wiki.read(entityId, '')` cap:** The plain SQL path applies `maxFtsResults` as a `LIMIT`. If an entity has more facts than the limit, some MiniSearch results may not appear in the returned bundle.

**Solution:** The `WebWikiClient` maintains an in-memory fact cache (`Map<entityId, WikiFact[]>`) rebuilt alongside the MiniSearch index during `rebuildIndex()`. The `read()` override uses this cache as the source for filtering by MiniSearch result IDs, ignoring the SQL `LIMIT`.

```typescript
async function rebuildIndex(
  wiki: WikiMemory,
  miniSearch: MiniSearch,
  factCache: Map<string, WikiFact[]>
): Promise<void> {
  const dump = await wiki.exportDump();
  miniSearch.removeAll();
  factCache.clear();
  const docs: MiniSearchDoc[] = [];
  for (const [entityId, bundle] of Object.entries(dump.entities)) {
    const activeFacts: WikiFact[] = [];
    for (const fact of bundle.facts) {
      if (!fact.deleted_at) {
        activeFacts.push(fact);
        docs.push({ id: fact.id, entity_id: fact.entity_id, title: fact.title, body: fact.body, tags: fact.tags.join(' ') });
      }
    }
    factCache.set(entityId, activeFacts);
  }
  miniSearch.addAll(docs);
}
```

```typescript
async read(entityId: string, query: string): Promise<MemoryBundle> {
  if (!query.trim()) {
    return wiki.read(entityId, '');
  }
  const maxResults = options.config?.maxFtsResults ?? 10;
  const expandedQuery = expandQuery(query, options.config?.synonymMap);
  const results = miniSearch.search(expandedQuery, {
    filter: (r) => r.entity_id === entityId,
    combineWith: 'OR',
  });
  const topResults = results.slice(0, maxResults);
  const matchingIds = new Set(topResults.map((r) => r.id));
  const allFacts = factCache.get(entityId) ?? [];
  const facts = allFacts.filter((f) => matchingIds.has(f.id));

  // Update access_count and last_accessed_at, matching native behavior.
  if (matchingIds.size > 0) {
    const ids = [...matchingIds];
    const placeholders = ids.map(() => '?').join(',');
    const now = Date.now();
    await adapter.runAsync(
      `UPDATE ${prefix}entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids]
    );
    // Keep factCache in sync.
    for (const f of allFacts) {
      if (matchingIds.has(f.id)) {
        f.access_count += 1;
        f.last_accessed_at = now;
      }
    }
  }

  // tasks and events from wiki (no FTS5 involved)
  const bundle = await wiki.read(entityId, '');
  return { facts, tasks: bundle.tasks, events: bundle.events };
}
```

(`adapter` and `prefix` are captured in the closure from `createWebWiki`.)

### Known Degradations vs Native

| Behavior | Native (FTS5) | Web (MiniSearch) |
|---|---|---|
| Tokenizer | Porter unicode61 | MiniSearch default (word splitting) |
| Stemming | Porter algorithm | None (fuzzy=0.2 compensates partially) |
| Synonym expansion | `WikiConfig.synonymMap` applied | Applied via `expandQuery` helper |
| Ranking | BM25 | MiniSearch TF-IDF |
| `access_count` update | Yes | Yes (explicit SQL after MiniSearch search) |
| Tag search | Yes (FTS5 column) | Yes (included in MiniSearch fields) |
| MiniSearch index memory | N/A | Grows proportionally with fact count; document in README for large wikis |

---

## Package Ownership

| Package | Change |
|---|---|
| `@equationalapplications/core-llm-wiki` | None |
| `@equationalapplications/react-llm-wiki` | Add `FTS5SkipAdapter`; add `./adapters` subpath |
| `@equationalapplications/expo-llm-wiki` | Add `createWebWiki` in `src/web.ts`; update `src/index.ts` to auto-detect `Platform.OS`; add `./web` subpath |

---

## Dependency: `minisearch`

Add `minisearch` as a **direct dependency** of `packages/expo` (since `createWebWiki` is the primary consumer). Also add to `packages/react` devDependencies for the adapter tests.

```json
// packages/expo/package.json
"dependencies": {
  "minisearch": "^7.0.0"
}
```

Check current MiniSearch major version before pinning.

---

## File Checklist

| File | Action |
|---|---|
| `packages/react/src/adapters/fts5Skip.ts` | Create `FTS5SkipAdapter` |
| `packages/react/src/adapters.ts` | Create barrel: `export { createFTS5SkipAdapter } from './adapters/fts5Skip'` |
| `packages/react/package.json` | Add `./adapters` subpath export; add `minisearch` devDep |
| `packages/react/tsup.config.ts` | Add `src/adapters.ts` entry |
| `packages/react/vitest.config.ts` | Enable `__tests__/**/*.test.ts` Node files |
| `packages/react/__tests__/fts5Skip.test.ts` | Unit tests for `FTS5SkipAdapter` |
| `packages/expo/src/web.ts` | `createWebWiki` factory with full `WikiMemory`-proxy client, MiniSearch, synonymMap expansion, `access_count` update |
| `packages/expo/src/index.ts` | Add `Platform.OS === 'web'` guard in `createWiki` to call `createWebWiki` |
| `packages/expo/package.json` | Add `./web` subpath; add `minisearch` dependency |
| `packages/expo/tsup.config.ts` | Add `src/web.ts` entry |
| `packages/expo/__tests__/web.test.ts` | Integration tests (setup, read, mutations, index sync, synonymMap, access_count) |
| `packages/expo/README.md` | Add Expo web section |
| `packages/react/README.md` | Document `FTS5SkipAdapter` |
| `README.md` | Update web guidance section |

---

## Tests

### `packages/react/__tests__/fts5Skip.test.ts`

- FTS5 DDL in `execAsync` is silently skipped (no error, underlying adapter not called for that SQL).
- Non-FTS5 DDL in `execAsync` passes through unchanged.
- `getAllAsync` with `MATCH ?` returns `[]` without calling underlying adapter.
- `getAllAsync` without `MATCH` passes through.
- `runAsync`, `getFirstAsync`, `withTransactionAsync`, `closeAsync` all delegate to underlying adapter.
- Multi-statement `execAsync` with mixed FTS5 and non-FTS5 statements: FTS5 parts stripped, non-FTS5 parts forwarded.

### `packages/expo/__tests__/web.test.ts`

Use a real `expo-sqlite` in-memory database (or the existing `sqliteAdapter` test helper if it can provide a bare `SQLiteAdapter`).

- `setup()` does not throw on a database backed by `FTS5SkipAdapter`.
- `read(entityId, '')` returns empty bundle on fresh DB.
- After `ingestDocument(entityId, text, ...)`, `read(entityId, someQueryTerm)` returns matching facts.
- After `forget(entityId, factId)`, the forgotten fact no longer appears in `read()` results.
- After `runLibrarian()`, new/changed facts appear in search.
- After `importDump(dump)`, imported facts are searchable.
- MiniSearch index survives multiple sequential mutations correctly (no stale entries).
- `synonymMap` in config: synonym terms expand the MiniSearch query and return results matching either the original or the synonym.
- `access_count` is incremented in the database for matched facts after a non-empty `read()`.
- `createWiki` on a mock where `Platform.OS === 'web'` returns an instance that uses the MiniSearch path.

---

## README Updates

### `packages/expo/README.md`

Add an **Expo Web** section after the native usage section:

1. State that `expo-sqlite` on web lacks FTS5 and that `createWiki` automatically selects the MiniSearch path on web.
2. Show that the same code works on all platforms — no platform guard needed:
   ```typescript
   import * as SQLite from 'expo-sqlite';
   import { createWiki } from '@equationalapplications/expo-llm-wiki';
   
   const db = await SQLite.openDatabaseAsync('wiki.db');
   const wiki = createWiki(db, { llmProvider });
   await wiki.setup();
   ```
3. Document that on web, search uses MiniSearch (degraded from FTS5 porter stemmer).
4. List known degradations: stemming differences, ranking differences, MiniSearch index memory growth.
5. Note that `synonymMap` and `access_count` work on web, with the same API as native.

### `packages/react/README.md`

Add a note that `@equationalapplications/react-llm-wiki/adapters` exports `createFTS5SkipAdapter` for custom web setups where a developer wants to wrap their own `SQLiteAdapter`.

### Root `README.md`

Update the web section to describe the MiniSearch degraded path. Remove OPFS/Worker references as the recommended web path.

---

## Resolved Design Decisions

1. **`synonymMap` on web** — Implemented via `expandQuery` helper in `createWebWiki`. Same config key, same behavior as native.

2. **`access_count` on web** — Implemented with an explicit `runAsync` in the `read()` override after collecting MiniSearch result IDs. `factCache` is kept in sync to avoid stale data.

3. **MiniSearch index memory** — Document only. README notes that very large fact sets increase in-memory index size. No mitigation in this spec.

4. **Index rebuild cost** — Full `exportDump()` + `removeAll()` + `addAll()` after every maintenance run is acceptable for now. Targeted patch strategy deferred until profiling warrants it.

5. **`Platform.OS` auto-detection** — `createWiki` in `packages/expo/src/index.ts` automatically delegates to `createWebWiki` when `Platform.OS === 'web'`. Same developer installation steps and import path on all platforms.
