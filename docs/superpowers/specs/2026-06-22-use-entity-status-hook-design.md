# Spec: `useEntityStatus(entityId)` React hook

**Date:** 2026-06-22
**Status:** Implemented
**Follow-up to:** [2026-05-08-entity-status-subscription.md](./2026-05-08-entity-status-subscription.md) (§"React consumer (out of scope, follow-up)")
**Package:** `@equationalapplications/expo-llm-wiki-react` (`packages/react`)

---

## Problem

`WikiMemory.getEntityStatus(entityId)` and `WikiMemory.subscribeEntityStatus(entityId, callback)` are fully implemented and shipped in `packages/core` (`packages/core/src/WikiMemory.ts:279-288`, delegating to `JobManager.ts:275-309`). There is no React binding. Developers building loading UI for background ingest/librarian/heal work must wire `useEffect` + `useState` + manual subscribe/unsubscribe themselves in every component.

`packages/react` already has seven hooks in this style (`useWikiHasChanged`, `useWikiIngest`, etc.) and a `useWiki()` context accessor (`packages/react/src/WikiContext.tsx`). No subscription-based hook exists yet in this package — all existing hooks are action/promise-based (`execute()` + `isPending`/`error`/`lastResult`).

## Goal

Add `useEntityStatus(entityId): EntityStatus` to `packages/react`, re-exported transparently through `packages/expo` via its existing `export *` re-export chain.

---

## API

```typescript
// packages/react/src/useEntityStatus.ts
export function useEntityStatus(entityId: string): EntityStatus;
```

- Returns the live `EntityStatus` (`{ ingesting, librarian, heal }`) for `entityId`, updating whenever the underlying job state transitions.
- Reads `wiki` via `useWiki()` (must be called within `WikiProvider`, same as every other hook in this package).

### Implementation

```typescript
import { useState, useEffect } from 'react';
import { useWiki } from './WikiContext';
import type { EntityStatus } from '@equationalapplications/core-llm-wiki';

export function useEntityStatus(entityId: string): EntityStatus {
  const wiki = useWiki();
  const [status, setStatus] = useState<EntityStatus>(() => wiki.getEntityStatus(entityId));

  useEffect(() => {
    setStatus(wiki.getEntityStatus(entityId));
    return wiki.subscribeEntityStatus(entityId, setStatus);
  }, [wiki, entityId]);

  return status;
}
```

### Design decisions (resolved during brainstorming)

1. **`useEffect`, not `useSyncExternalStore`.** `packages/react/package.json` declares `peerDependencies: { react: ">=17" }`; `useSyncExternalStore` requires React 18+. Adopting it would require a shim dependency (`use-sync-external-store`) not used anywhere else in this repo, for a "quick win" hook. Rejected — stay on the `useEffect` pattern used by every other hook in this package.
2. **Redundant initial fetch is intentional, not a bug.** Per `JobManager.ts:283-298` (and the binding spec, rule 1), `subscribeEntityStatus` synchronously invokes its callback once with the current snapshot immediately on subscribe. The effect therefore calls `getEntityStatus` once for the synchronous initial render value, then `subscribeEntityStatus` immediately re-delivers the same value via its mandatory initial emission. This is a harmless extra `setState` call with an identical value — not optimized away, because removing the initial `getEntityStatus` call would leave the hook's first-paint value stale/unset until the effect mounts (worse for SSR and first render).
3. **No `entityId` validation.** No other hook in `packages/react` validates its `entityId`/string arguments; `WikiMemory.getEntityStatus`/`subscribeEntityStatus` already accept any string with no normalization (per the binding spec, §"API"). Validation, if ever needed, belongs in core, not this thin wrapper.
4. **`entityId` changes are supported.** Changing `entityId` across renders re-runs the effect: old subscription is torn down (idempotent unsubscribe per binding spec rule 7-adjacent guarantee), new subscription created, state reset to the new entity's current status via the same initial-fetch-then-subscribe sequence.

---

## Export surface

- `packages/react/src/index.ts`: add `export { useEntityStatus } from './useEntityStatus';`
- `EntityStatus` is already exported transitively via the existing `export * from '@equationalapplications/core-llm-wiki';` line in the same file — no new type export needed.
- `packages/expo/src/index.ts` already does `export * from '@equationalapplications/react-llm-wiki';` — `useEntityStatus` becomes available to Expo consumers with no expo-package change.

---

## Testing

Extend `packages/react/__tests__/hooks.test.tsx` (existing single-file convention for all hooks in this package) rather than creating a new test file.

1. Extend `makeMockWiki()` with `getEntityStatus: vi.fn().mockReturnValue({ ingesting: false, librarian: false, heal: false })` and `subscribeEntityStatus: vi.fn((entityId, cb) => { cb(mockWiki.getEntityStatus(entityId)); return vi.fn(); })` (mirroring the real synchronous-initial-emission contract).
2. New `describe('useEntityStatus')` block:
   - **Initial render** — `renderHook(() => useEntityStatus('e1'), { wrapper })` returns the value from `getEntityStatus` before any effect runs.
   - **Transition update** — capture the callback passed to `subscribeEntityStatus`, invoke it with a new status inside `act()`, assert `result.current` updates.
   - **Unmount unsubscribes** — assert the unsubscribe function returned by the mocked `subscribeEntityStatus` is called on unmount.
   - **`entityId` change resubscribes** — rerender with a new `entityId`, assert old unsubscribe called, `subscribeEntityStatus` called again with the new id, and `result.current` reflects the new entity's status.

---

## Documentation

Add a short usage example to both:

- `packages/react/README.md`
- `packages/expo/README.md`

Example to include (illustrative, adapt to each README's existing voice/section structure):

```tsx
function EntityLoadingSpinner({ entityId }: { entityId: string }) {
  const { ingesting, librarian, heal } = useEntityStatus(entityId);
  if (!ingesting && !librarian && !heal) return null;
  return <Spinner label={ingesting ? 'Ingesting…' : librarian ? 'Organizing…' : 'Healing…'} />;
}
```

---

## Non-goals

- No changes to `packages/core` (already shipped per the binding spec).
- No `useSyncExternalStore` migration for this or any other hook in this package (separate future spec if the React 18+ floor is ever raised).
- No polling fallback, no debouncing, no batching of rapid transitions — the hook is a direct pass-through of whatever `subscribeEntityStatus` delivers.
- No multi-entity / wildcard variant (matches core's single-`entityId` scope).

---

## Acceptance

- `useEntityStatus` exported from `packages/react/src/index.ts` and reachable from `@equationalapplications/expo-llm-wiki` with zero expo-package code changes.
- All four test cases above pass in `packages/react/__tests__/hooks.test.tsx` via `pnpm test`.
- `packages/react/README.md` and `packages/expo/README.md` both document the hook with a usage example.
- No changes to `packages/core`.
