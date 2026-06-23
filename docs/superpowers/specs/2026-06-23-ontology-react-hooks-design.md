# Spec: Ontology React hooks (`useOntologyManifest`, `useSetOntologyManifest`)

**Date:** 2026-06-23
**Status:** Implemented
**Follow-up to:** [2026-06-23-per-entity-seeded-ontology-design.md](./2026-06-23-per-entity-seeded-ontology-design.md) (§"Public API (`WikiMemory`)")
**Package:** `@equationalapplications/react-llm-wiki` (`packages/react`), re-exported through `@equationalapplications/expo-llm-wiki`

---

## Problem

The per-entity seeded ontology feature ships core APIs on `WikiMemory`:

- `getOntologyManifest(entityId)` — async read
- `setOntologyManifest(entityId, manifest, options?)` — async write

`packages/react` already exposes a consistent hook surface for memory operations (`useMemoryRead`, `useWikiWrite`, `useWikiIngest`, etc.) and a `useWiki()` context accessor (`packages/react/src/WikiContext.tsx`). Ontology has no React bindings. Developers must hand-roll `useEffect` + `useState` (or call `useWiki()` imperatively in event handlers) to load or edit an entity's taxonomy — boilerplate that every other major wiki operation avoids.

The interim README guidance ("call `wiki.getOntologyManifest()` via `useWiki()`") is acceptable for v1 documentation but not a first-class DX match for the rest of the ecosystem.

## Goals

- Add **`useOntologyManifest(entityId)`** — reactive read hook mirroring `useMemoryRead`'s fetch-on-mount / refetch-on-`entityId`-change contract.
- Add **`useSetOntologyManifest()`** — mutation hook mirroring `useWikiWrite`'s shared `{ execute, isPending, error, lastResult }` contract.
- Re-export both hooks through `packages/expo` with zero expo-package code changes (existing `export *` chain).
- **Update `packages/react/README.md` and `packages/expo/README.md`** so frontend developers discover ontology through first-class hook documentation (Features list, Hooks reference, lifecycle diagrams) — not the interim `useWiki()` workaround added before hooks existed.

## Non-Goals

- No changes to `packages/core` — `WikiMemory` ontology APIs are already implemented.
- No `WikiProvider` invalidation bus or cross-hook auto-refetch in v1 (matches `useWikiWrite` + `useMemoryRead`: writes do not automatically refresh reads; callers invoke `refetch()` after a successful mutation when needed).
- No subscription/push updates when ontology changes from *another* `WikiMemory` instance or external DB writer (same limitation as all other react hooks).
- No multi-entity variant — ontology is always scoped to a single `entityId` string.
- No `useSyncExternalStore` — stay on `useEffect` + `useState` like every other hook in this package (`peerDependencies: react >= 17`).
- No dedicated ontology UI components or settings panels.

---

## API

### `useOntologyManifest(entityId)`

```typescript
// packages/react/src/useOntologyManifest.ts
import type { OntologyManifest, OntologyMode } from '@equationalapplications/core-llm-wiki';

export interface OntologyManifestState {
  /** Resolved manifest, or `null` when `getOntologyManifest` returns `null`. */
  manifest: OntologyManifest | null;
  /** Resolved mode, or `null` when no manifest row/seed applies. */
  mode: OntologyMode | null;
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useOntologyManifest(entityId: string): OntologyManifestState;
```

**Behavior:**

1. Reads `wiki` via `useWiki()` (must be inside `WikiProvider`).
2. On mount and whenever `entityId` or `wiki` changes, calls `wiki.getOntologyManifest(entityId)`.
3. Maps core `null` → `{ manifest: null, mode: null }` (entity has no persisted or seeded manifest).
4. Exposes `refetch()` to manually re-run the fetch with the latest `entityId` (same semantics as `useMemoryRead().refetch`).
5. Uses the **in-flight fetch queue** pattern from `useMemoryRead` (`packages/react/src/useMemoryRead.ts:125-155`): if a fetch is in flight when `entityId` changes or `refetch()` fires, queue one follow-up fetch with the latest args; never discard an in-flight result.

**Naming note:** Return field is `isPending`, not `isLoading`, to match `useMemoryRead` and all mutation hooks in this package.

### `useSetOntologyManifest()`

```typescript
// packages/react/src/useSetOntologyManifest.ts
import type { OntologyManifest, OntologyMode } from '@equationalapplications/core-llm-wiki';

export function useSetOntologyManifest(): {
  execute: (
    entityId: string,
    manifest: OntologyManifest,
    options?: { mode?: OntologyMode },
  ) => Promise<void>;
  isPending: boolean;
  error: Error | null;
  lastResult: void | null;
};
```

**Behavior:**

1. Reads `wiki` via `useWiki()`.
2. `execute(entityId, manifest, options?)` delegates to `wiki.setOntologyManifest(entityId, manifest, options)`.
3. State transitions mirror `useWikiWrite` (`packages/react/src/useWikiWrite.ts`):
   - On call: `setError(null)`, `setIsPending(true)`, `setLastResult(null)`.
   - On success: `setLastResult(undefined)`, rethrow nothing.
   - On failure: wrap non-`Error` throws as `new Error(String(e))`, set `error`, rethrow.
   - `finally`: `setIsPending(false)`.
4. Uses `wikiRef` pattern so `execute` callback identity is stable (`useCallback(..., [])`).

**Recommended pairing:**

```tsx
const { manifest, mode, refetch } = useOntologyManifest(entityId);
const { execute, isPending } = useSetOntologyManifest();

const handleSave = async () => {
  await execute(entityId, nextManifest, { mode: 'strict' });
  refetch(); // refresh read hook after successful write
};
```

---

## Implementation

### `useOntologyManifest.ts`

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import type { OntologyManifest, OntologyMode } from '@equationalapplications/core-llm-wiki';
import { useWiki } from './WikiContext';

export interface OntologyManifestState {
  manifest: OntologyManifest | null;
  mode: OntologyMode | null;
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useOntologyManifest(entityId: string): OntologyManifestState {
  const wiki = useWiki();
  const [manifest, setManifest] = useState<OntologyManifest | null>(null);
  const [mode, setMode] = useState<OntologyMode | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const entityIdRef = useRef(entityId);
  entityIdRef.current = entityId;

  const fetchQueue = useRef<{
    inFlight: boolean;
    pending: string | null;
  }>({ inFlight: false, pending: null });

  const scheduleFetch = useRef(function schedule(eid: string) {
    const fq = fetchQueue.current;
    if (fq.inFlight) {
      fq.pending = eid;
      return;
    }
    fq.inFlight = true;
    setIsPending(true);

    wikiRef.current.getOntologyManifest(eid).then(
      (result) => {
        if (result) {
          setManifest(result.manifest);
          setMode(result.mode);
        } else {
          setManifest(null);
          setMode(null);
        }
        setError(null);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
      },
    ).finally(() => {
      fq.inFlight = false;
      const next = fq.pending;
      fq.pending = null;
      if (next) {
        scheduleFetch.current(next);
      } else {
        setIsPending(false);
      }
    });
  });

  useEffect(() => {
    scheduleFetch.current(entityIdRef.current);
  }, [entityId, wiki]);

  const refetch = useCallback(() => {
    scheduleFetch.current(entityIdRef.current);
  }, [entityId]);

  return { manifest, mode, isPending, error, refetch };
}
```

### `useSetOntologyManifest.ts`

```typescript
import { useState, useCallback, useRef } from 'react';
import type { OntologyManifest, OntologyMode } from '@equationalapplications/core-llm-wiki';
import { useWiki } from './WikiContext';

export function useSetOntologyManifest() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<void | null>(null);

  const execute = useCallback(async (
    entityId: string,
    manifest: OntologyManifest,
    options?: { mode?: OntologyMode },
  ): Promise<void> => {
    setError(null);
    setIsPending(true);
    setLastResult(null);
    try {
      await wikiRef.current.setOntologyManifest(entityId, manifest, options);
      setLastResult(undefined);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      setError(error);
      throw error;
    } finally {
      setIsPending(false);
    }
  }, []);

  return { execute, lastResult, isPending, error };
}
```

### Design decisions

| Decision | Resolution |
| :--- | :--- |
| Hook names | `useOntologyManifest` (read) + `useSetOntologyManifest` (mutation). Read hook omits `Wiki` prefix (like `useMemoryRead`); mutation uses verb prefix (like `useSet*` is explicit; alternative `useWikiOntologyManifest` rejected to keep read name short). |
| `isPending` vs `isLoading` | `isPending` — matches all existing hooks. |
| Null core response | Expose `{ manifest: null, mode: null }` — do not synthesize `mode: 'off'` in the hook; hosts that need the effective runtime mode should call core after seeding or consult `WikiConfig.ontology.mode`. |
| Cross-hook refresh | Manual `refetch()` after `execute()` in v1 — no `WikiProvider` event bus. |
| `entityId` validation | None — consistent with other hooks; core accepts any string. |
| Initial `isPending` | `true` on first fetch (same as `useMemoryRead`). |

---

## Export surface

**`packages/react/src/index.ts`:**

```typescript
export { useOntologyManifest } from './useOntologyManifest';
export type { OntologyManifestState } from './useOntologyManifest';
export { useSetOntologyManifest } from './useSetOntologyManifest';
```

`OntologyManifest`, `OntologyMode`, and related types remain available via the existing `export * from '@equationalapplications/core-llm-wiki'` line.

**`packages/expo/src/index.ts`:** No change — `export * from '@equationalapplications/react-llm-wiki'` already re-exports new hooks.

**JSDoc:** Add JSDoc blocks on both exported hook functions and `OntologyManifestState` (public API surface per repo conventions).

---

## Testing

Extend `packages/react/__tests__/hooks.test.tsx` (single-file convention).

### Mock extensions

Add to `makeMockWiki()`:

```typescript
getOntologyManifest: vi.fn().mockResolvedValue(null),
setOntologyManifest: vi.fn().mockResolvedValue(undefined),
```

### `describe('useOntologyManifest')`

1. **Initial fetch** — `renderHook(() => useOntologyManifest('e1'), { wrapper })` starts `isPending: true`, then settles with `manifest`/`mode` from mock resolution; `getOntologyManifest` called with `'e1'`.
2. **Null response** — mock resolves `null` → `manifest: null`, `mode: null`, `error: null`.
3. **`entityId` change** — rerender with new id → second `getOntologyManifest` call with new id.
4. **Error** — mock rejects → `error` set, `isPending` false.
5. **`refetch()`** — manual `refetch()` triggers another `getOntologyManifest` call without `entityId` change.
6. **Queued fetch** — rapid `entityId` change while first fetch in flight → final settled state matches last `entityId` (mirror `useMemoryRead` queue test if one exists, or add minimal version).

### `describe('useSetOntologyManifest')`

1. **Success** — `execute('e1', manifest, { mode: 'strict' })` calls `setOntologyManifest` with same args; `isPending` toggles; `lastResult` becomes `undefined`; `error` null.
2. **Failure** — mock rejects → `error` set, `execute` rethrows, `isPending` false.
3. **Stable `execute`** — two renders → same `execute` reference (`toBe`).

Use the same `wrapper(wiki)` + `WikiProvider` pattern as existing tests.

---

## Documentation

**Required deliverable:** Both `@equationalapplications/react-llm-wiki` (`packages/react/README.md`) and `@equationalapplications/expo-llm-wiki` (`packages/expo/README.md`) must be updated as part of hook implementation — not deferred to a separate docs PR. These READMEs are the primary entry point for React Native and React web developers; ontology must appear alongside semantic search, multi-entity reads, and source provenance.

Apply the same content structure to both files. Only the import path differs:

| Package | Import from |
| :--- | :--- |
| `packages/react` | `@equationalapplications/react-llm-wiki` |
| `packages/expo` | `@equationalapplications/expo-llm-wiki` |

### Checklist (both READMEs)

#### 1. Features section

- **Keep** the existing **Seeded ontologies** bullet; extend it to mention the dedicated hooks, e.g.:
  > **Seeded ontologies** — Enforce strict taxonomies or allow emergent graph relationship extraction (`useOntologyManifest`, `useSetOntologyManifest`; Strict, Emergent, or Off; defaults to Off).
- **Update** the **Mutation hooks** bullet (`packages/react` only) to include `useSetOntologyManifest` alongside `useWikiWrite`, `useWikiIngest`, etc.
- **Update** the **React hooks** bullet (`packages/expo` only) to mention ontology hooks in the re-export list if other hooks are enumerated there.

#### 2. Hooks section — replace interim `useWiki()` workaround

**Remove** the entire `### Seeded ontologies (useWiki())` subsection (interim guidance that says "there is no dedicated ontology hook"). **Replace** with two hook subsections under **Hooks**, placed after `useEntityStatus` and before the next major section (`Multi-Entity Reads` in react; `Component Lifecycle` in expo):

##### `useOntologyManifest(entityId)`

Reactive read — fetches on mount and when `entityId` changes:

```typescript
import { useOntologyManifest } from '@equationalapplications/react-llm-wiki';
// expo: import from '@equationalapplications/expo-llm-wiki'

const { manifest, mode, isPending, error, refetch } = useOntologyManifest('user-123');
// manifest: OntologyManifest | null
// mode: OntologyMode | null ('strict' | 'emergent' | 'off' when present)
```

Note: `manifest` and `mode` are `null` when the entity has no persisted or seeded manifest (`getOntologyManifest` returned `null`). Call `refetch()` after mutations to refresh.

##### `useSetOntologyManifest()`

Mutation — same `{ execute, isPending, error, lastResult }` contract as `useWikiWrite`:

```typescript
import { useOntologyManifest, useSetOntologyManifest } from '@equationalapplications/react-llm-wiki';

export function OntologySettings({ entityId }: { entityId: string }) {
  const { manifest, mode, refetch } = useOntologyManifest(entityId);
  const { execute, isPending, error } = useSetOntologyManifest();

  const handleSave = async () => {
    await execute(entityId, {
      node_types: [{ type: 'person', description: 'An individual.' }],
      edge_types: [{
        type: 'reports_to',
        source_type: 'person',
        target_type: 'person',
        description: 'Reporting hierarchy.',
      }],
    }, { mode: 'strict' });
    refetch();
  };

  // render manifest/mode; wire handleSave to a save button
}
```

Add a short note after the example:

> Global defaults and `seedManifests` bootstrap are configured at construction time via `createWiki(..., { config: { ontology: ... } })`. See the [core package README § Per-Entity Seeded Ontology](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md#per-entity-seeded-ontology) for mode semantics and manifest schema.

> `useSetOntologyManifest` does not automatically refresh `useOntologyManifest` — call `refetch()` after a successful `execute()`, same as `useWikiWrite` + `useMemoryRead`.

#### 3. Component Lifecycle mermaid diagram

Update the **Component Lifecycle** flowchart in both READMEs to include ontology hooks alongside existing branches:

```mermaid
C -->|"useOntologyManifest(entityId)"| S["[Read Ontology]"]
C -->|"useSetOntologyManifest()"| T["[Update Ontology]"]
```

Place new nodes in the same `{"Use Hook?"}` decision diamond as `useMemoryRead`, `useWikiWrite`, etc. Wire `useSetOntologyManifest` into the shared `Execute` / `Write completes` path if the diagram groups mutations (match existing style in each file).

#### 4. Data flow bullets

Under **Data flow** (or equivalent prose after the lifecycle diagram), add:

- **Ontology reads** auto-refetch when `entityId` or `wiki` changes; call `refetch()` manually after ontology mutations.
- **Ontology writes** (`useSetOntologyManifest`) do not automatically re-trigger `useOntologyManifest` in the same component unless `refetch()` is called after `execute()` succeeds.

#### 5. Do not change

- Do not duplicate the full ontology mode/manifest schema — link to `packages/core/README.md` instead.
- Do not edit root `README.md` or `CHANGELOG.md` in this spec (covered by the core ontology spec / semantic-release).

### Acceptance (documentation)

- [ ] Interim `### Seeded ontologies (useWiki())` sections removed from both READMEs.
- [ ] `useOntologyManifest` and `useSetOntologyManifest` documented under **Hooks** with working import paths per package.
- [ ] **Features** bullets updated to reference the hooks.
- [ ] Component lifecycle diagrams include ontology hook branches.
- [ ] Data-flow prose mentions ontology read/write invalidation contract.

---

## File map

| Action | Path | Responsibility |
| :--- | :--- | :--- |
| Create | `packages/react/src/useOntologyManifest.ts` | Reactive read hook |
| Create | `packages/react/src/useSetOntologyManifest.ts` | Mutation hook |
| Modify | `packages/react/src/index.ts` | Export hooks + `OntologyManifestState` |
| Modify | `packages/react/__tests__/hooks.test.tsx` | Unit tests |
| Modify | `packages/react/README.md` | Features, Hooks, lifecycle diagram, data-flow prose |
| Modify | `packages/expo/README.md` | Same documentation updates (expo import paths) |

No `packages/core` or `packages/expo/src` changes.

---

## Versioning & changelog

- Ship in the same PR as [2026-06-23-per-entity-seeded-ontology-design.md](./2026-06-23-per-entity-seeded-ontology-design.md) if both are ready together, or as a follow-up `feat(react)` PR immediately after core ontology lands.
- **Do not edit `CHANGELOG.md` manually** — semantic-release generates entries from conventional commits.
- Suggested commit/PR title when bundled with core: `feat(react): add ontology manifest hooks`
- If split: `feat(react): add useOntologyManifest and useSetOntologyManifest`

---

## Acceptance

- [ ] `useOntologyManifest` and `useSetOntologyManifest` exported from `packages/react/src/index.ts`.
- [ ] Both hooks reachable from `@equationalapplications/expo-llm-wiki` without expo-package code changes.
- [ ] All test cases in §Testing pass via `pnpm test` (or package-scoped equivalent).
- [ ] JSDoc on public hook exports and `OntologyManifestState`.
- [ ] Documentation checklist in §Documentation satisfied for `packages/react/README.md` and `packages/expo/README.md`.
- [ ] No changes to `packages/core`.
- [ ] `CHANGELOG.md` untouched.
