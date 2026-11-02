---
title: Show background job status
description: Display live "ingesting / organizing / healing" indicators and a manual maintenance panel with React hooks.
sidebar:
  order: 3
---

**Goal:** show users that memory is busy, and give power users buttons to run maintenance.

```tsx title="MemoryStatus.tsx"
import { useEntityStatus, useWikiMaintenance } from '@equationalapplications/react-llm-wiki';

export function MemoryStatus({ entityId }: { entityId: string }) {
  const { ingesting, librarian, heal } = useEntityStatus(entityId); // push-based, no polling
  const { runLibrarian, runHeal, runPrune, isPending, lastResult, error } = useWikiMaintenance();

  const busy = ingesting || librarian || heal;

  return (
    <section>
      <p>
        {busy
          ? ingesting ? 'Reading document…' : librarian ? 'Organizing memory…' : 'Tidying up…'
          : 'Memory is up to date'}
      </p>

      <button disabled={isPending || busy} onClick={() => runLibrarian(entityId)}>Consolidate now</button>
      <button disabled={isPending || busy} onClick={() => runHeal(entityId)}>Heal</button>
      <button disabled={isPending || busy} onClick={() => runPrune(entityId)}>Free space</button>

      {lastResult?.operation === 'prune' && (
        <p>Removed {lastResult.result.entries} facts, {lastResult.result.events} events.</p>
      )}
      {error && <p role="alert">{error.message}</p>}
    </section>
  );
}
```

In Expo, import the same hooks from `@equationalapplications/expo-llm-wiki` and swap the DOM
elements for React Native components.

## Notes

- `useEntityStatus` fires once right away and then on every transition.
- `isPending` from `useWikiMaintenance` is shared across all of its operations.
- If a job is already running for the entity, the hook surfaces a `WikiBusyError` as `error`.
