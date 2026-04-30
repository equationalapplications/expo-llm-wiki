# Design: React Bindings for expo-llm-wiki

**Date:** 2026-04-29  
**Status:** Implemented

---

## Problem

The current API (`createWiki(db, options)` → `WikiMemory`) works well for non-React contexts (background tasks, service modules, tests), but React component authors have no ergonomic way to consume memory reads reactively or to call mutations with loading/error state managed for them.

---

## Architecture

Two layers, cleanly separated:

```
WikiMemory (class)          ← core, no React dependency
    ↑
WikiProvider (component)    ← puts instance in React context
    ↑
hooks                       ← thin wrappers: manage loading/error/data state
```

The hooks contain **no business logic** — they only wrap class method calls with `useState` / `useEffect`. All real logic stays in `WikiMemory`.

---

## New Files

| File | Purpose |
|---|---|
| `src/react/WikiContext.tsx` | Creates context, exports `WikiProvider` |
| `src/react/useMemoryRead.ts` | Reactive read hook |
| `src/react/useWikiWrite.ts` | `write` mutation hook |
| `src/react/useWikiMaintenance.ts` | `runLibrarian`, `runHeal` mutation hooks |
| `src/react/useWikiIngest.ts` | `ingestDocument` mutation hook |
| `src/react/useWikiForget.ts` | `forget` mutation hook |
| `src/react/index.ts` | Re-exports all React bindings |

React bindings are exported from a separate entry point `expo-llm-wiki/react` so that non-React users do not transitively import React.

---

## API

### Provider

```typescript
import { WikiProvider } from 'expo-llm-wiki/react';

// Wrap once at app root (or any subtree that needs it)
const wiki = createWiki(db, { llmProvider });

<WikiProvider wiki={wiki}>
  <App />
</WikiProvider>
```

`WikiProvider` accepts one prop: `wiki: WikiMemory`.

---

### `useMemoryRead(entityId, query)`

Reactive read. Auto-fetches on mount and whenever `entityId` or `query` changes.

```typescript
const { data, isPending, error, refetch } = useMemoryRead('entity-123', 'weekend plans');
// data: MemoryBundle | null
// isPending: boolean
// error: Error | null
// refetch: () => void  — manual trigger
```

If `entityId` or `query` changes while a fetch is in-flight, the in-flight fetch is allowed to complete (its result still updates `data`), and a new fetch with the latest values is queued to run immediately after it settles. If multiple changes arrive while a fetch is in-flight, only the latest queued values are used — intermediate ones are coalesced. Results are never silently discarded.

---

### `useWikiWrite()`

```typescript
const { execute, isPending, error } = useWikiWrite();
await execute('entity-123', { type: 'observation', summary: '...' });
```

---

### `useWikiMaintenance()`

```typescript
const { runLibrarian, runHeal, isPending, error } = useWikiMaintenance();
await runLibrarian('entity-123');
await runHeal('entity-123');
```

`isPending` is `true` if either operation is in-flight. Shared state is intentional here: both are background maintenance passes typically triggered by the same scheduler or UI affordance.

---

### `useWikiIngest()`

```typescript
const { execute, isPending, error } = useWikiIngest();
await execute('entity-123', 'raw document text...');
```

---

### `useWikiForget()`

Kept separate from `useWikiWrite` so that overlapping write and forget operations do not stomp on each other's `isPending` / `error` state.

```typescript
const { execute, isPending, error } = useWikiForget();
await execute('entity-123', { entryId: 'fact-456' });
```

---

## Mutation Hook Shape (shared contract)

All mutation hooks return the same shape:

```typescript
{
  execute: (...args) => Promise<void>;
  isPending: boolean;
  error: Error | null;
}
```

On call, `isPending` flips to `true`. On success or failure it flips back. `error` is set on failure and cleared on the next `execute` call.

---

## Entry Points

`package.json` exports:

```json
{
  "exports": {
    ".": {
      "require": "./dist/index.js",
      "import": "./dist/index.mjs",
      "types": "./dist/index.d.ts"
    },
    "./react": {
      "require": "./dist/react/index.js",
      "import": "./dist/react/index.mjs",
      "types": "./dist/react/index.d.ts"
    }
  }
}
```

`react` is added as a **peer dependency** (not bundled).

---

## What Does NOT Change

- `WikiMemory` class — no changes
- `createWiki` factory — no changes
- `types.ts` — no changes
- `LLMProvider` shape — no changes
- Non-React usage pattern — unchanged

---

## Out of Scope

- Suspense support (can be added later)
- Optimistic updates
- Per-call LLM provider overrides
- `useWikiSetup()` hook (setup is a one-time async operation best done before rendering)
