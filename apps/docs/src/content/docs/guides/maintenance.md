---
title: Maintenance
description: Librarian strategies, heal, reembed, prune, and running maintenance on your own schedule with budgets and deadlines.
sidebar:
  order: 9
---

## The jobs

| Method | What it does | Auto-triggered? |
|---|---|---|
| `runLibrarian(entityId, { promptOverride? })` | Turns recent events into facts and tasks | With `runPendingMaintenance()`, or every `autoLibrarianThreshold` events (default 20) in `'auto'` mode |
| `runHeal(entityId, { promptOverride? })` | Resolves contradictions, downgrades stale inferences, removes obsolete facts | With `runPendingMaintenance()`, or every `autoHealThreshold` events (default 100) in `'auto'` mode |
| `runReembed(entityId?, { skipExisting?, force? })` | Computes missing or outdated embeddings | No |
| `runPrune(entityId, opts)` | Hard-deletes aged soft-deleted rows and old events | No |
| `runOntologyBackfill(entityId)` | Types untyped facts | No |

Jobs for the same entity are mutually exclusive. A conflicting job throws `WikiBusyError`, which
is safe to catch and retry later.

## Librarian strategies

```ts
config: { librarian: { strategy: 'legacy' } } // default: 'ops'
```

| | `'legacy'` | `'ops'` (default) |
|---|---|---|
| Input | The newest events, plus existing facts in the prompt | Events since the last pass only |
| Dedup | Done by the model | An **embedding gate, with no LLM call**: identical facts are a no-op, novel facts are added, and only *similar-but-different* candidates go to the model |
| Changes | Rewrites facts | `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP`, in one batched call. Supersede keeps history. |
| Prompt overrides | `prompts.librarianSystemPrompt` | Ignored (ops uses its own schema) |

Gate thresholds (`gate: { k: 5, dupThreshold: 0.89, novelThreshold: 0.30 }`) depend on your
embedding model. The defaults were calibrated on BGE-small and are provisional for other models.
Without `embed`, the gate uses keyword search, and every match goes to the model.

## Heal

Heal looks at candidates such as orphaned facts (no source for `orphanAfterDays`, default 30) and
inferred facts older than `staleInferredAfterDays` (default 60). It asks the model to downgrade,
delete, or replace them. `immutable_document` facts are never rewritten. Set either threshold
to `null` to turn that check off.

## Reembed

```ts
const r = await wiki.runReembed();          // all entities
await wiki.runReembed('user-123', { skipExisting: true }); // only facts with no vector
// → { embedded, skipped, failed, deferred, permanentlyFailed }
```

- Run it after you **add** `embed()` or **change** embedding models.
- `deferred` rows are inside an exponential backoff (starting at 60 s, doubling, capped at 24 h).
  That's not an error.
- `permanentlyFailed` covers a `float32_overflow` failure or 5 failed attempts. Retry them with
  `{ force: true }`, which also skips the backoff window for `deferred` rows.
- A convergence loop should test `failed`, not `deferred`.
- A `storage_error` counts in `failed` but never enters backoff, because storage is treated as a
  separate failure domain from the embedding provider. While writes keep failing, every sweep retries every row, so a loop on
  `failed` can spin. Treat repeated `storage_error` failures as an infrastructure problem to fix,
  not something to wait out.

## Prune

```ts
await wiki.runPrune('user-123', {
  retainSoftDeletedFor: 7, // days; null to skip
  retainEventsFor: 30,     // days; null to skip
  vacuum: false,           // true rewrites the whole DB file (slow on mobile)
});
// → { entries, tasks, events }
```

Under `'deferred'` maintenance or the `'ops'` strategy, prune never deletes events the
librarian hasn't processed yet. It emits `event_retention_held` instead.

## Deferred maintenance

Since 8.0.0, `write()` only records the event by default. Nothing runs in the background and no
model is called until you run maintenance, so **no facts appear from events until you do**. To have
`write()` start the librarian and heal as background promises, set `maintenance: 'auto'`, but not on
**serverless or request-scoped** hosts, where those promises can be frozen or killed partway through.

```ts
const wiki = new WikiMemory(db, {
  llmProvider,
  config: { maintenance: 'deferred', librarian: { strategy: 'ops' } },
});

await wiki.write(entityId, { event_type: 'observation', summary, occurred_at });

const report = await wiki.runPendingMaintenance({ tokenBudget: 20_000, deadlineMs: 8_000 });
report.stoppedReason.reason; // 'complete' | 'deadline' | 'budget_exhausted' | 'budget_too_small'
// Nothing is still running at this point, so it's safe to persist the DB file.
```

- `getPendingMaintenance()` shows the backlog per entity without calling a model.
- The budget counts **text-generation tokens only**, not embedding calls. The counts come from
  the provider when you implement `generateTextWithUsage`, and are estimated otherwise.
- Entities share the budget fairly: each round runs one batch per entity.
- A crash mid-batch loses nothing, because the librarian's watermark only advances after a commit.
- **Use `'deferred'` together with `'ops'`.** The legacy strategy only reads the newest 50 events
  per pass, so a larger backlog would be skipped.

:::tip[Shutting down in auto mode?]
`await wiki.drain()` before your app is suspended or the process exits, so in-flight background
jobs can finish.
:::

## On mobile: the Night Shift pattern

Phones are hard on background work: iOS can kill memory-hungry processes, and long LLM passes
drain the battery. A pattern that works well is to **turn off auto maintenance and run it in the
foreground while the device is charging**:

```ts
import * as Battery from 'expo-battery';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const wiki = createWiki(db, {
  llmProvider,
  config: { maintenance: 'deferred', librarian: { strategy: 'ops' } },
});

export async function runNightShift() {
  const state = await Battery.getBatteryStateAsync();
  if (state !== Battery.BatteryState.CHARGING && state !== Battery.BatteryState.FULL) return;

  await activateKeepAwakeAsync();
  try {
    await wiki.runPendingMaintenance({ deadlineMs: 15 * 60_000 });
  } finally {
    deactivateKeepAwake();
  }
}
```

[Curated Journal](https://github.com/equationalapplications/curated-journal) ships the same idea as its
**Night Shift** mode: a full-screen maintenance session the user starts when the device is plugged in.

## Live job status

```ts
wiki.getEntityStatus('user-42'); // { ingesting, librarian, heal }

const unsubscribe = wiki.subscribeEntityStatus('user-42', (s) => render(s));
unsubscribe();
```

The callback fires once, synchronously, before `subscribeEntityStatus` returns (treat it as the
initial value), then again whenever any of the three flags flips.

- Each call may get a fresh object. Compare the three booleans, not object identity.
- A callback that throws is caught and logged. It doesn't affect other subscribers or the job.
- A subscription covers one entity. There's no wildcard form.
- `unsubscribe()` is safe to call more than once.

In React, use
[`useEntityStatus`](/expo-llm-wiki/reference/hooks/#useentitystatus).
