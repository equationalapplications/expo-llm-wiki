---
title: Maintenance
description: Librarian strategies, heal, reembed, prune, and running maintenance on your own schedule with budgets and deadlines.
sidebar:
  order: 9
---

## The jobs

| Method | What it does | Auto-triggered? |
|---|---|---|
| `runLibrarian(entityId, { promptOverride? })` | Turns recent events into facts and tasks | Every `autoLibrarianThreshold` events (default 20) |
| `runHeal(entityId, { promptOverride? })` | Resolves contradictions, downgrades stale inferences, removes obsolete facts | Every `autoHealThreshold` events (default 100) |
| `runReembed(entityId?, { skipExisting?, force? })` | Computes missing or outdated embeddings | No |
| `runPrune(entityId, opts)` | Hard-deletes aged soft-deleted rows and old events | No |
| `runOntologyBackfill(entityId)` | Types untyped facts | No |

Jobs for the same entity are mutually exclusive. A conflicting job throws `WikiBusyError`, which
is safe to catch and retry later.

## Librarian strategies

```ts
config: { librarian: { strategy: 'ops' } } // default: 'legacy'
```

| | `'legacy'` (default) | `'ops'` |
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
- `permanentlyFailed` covers overflow or 5 failed attempts. Retry them with `{ force: true }`.
- A convergence loop should test `failed`, not `deferred`. Repeated `storage_error` failures point
  to an infrastructure problem, not something to wait out.

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

By default, `write()` starts the librarian and heal as background promises. On **serverless or
request-scoped** hosts those promises can be frozen or killed partway through. Defer them instead:

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

## Live job status

```ts
wiki.getEntityStatus('user-42'); // { ingesting, librarian, heal }

const unsubscribe = wiki.subscribeEntityStatus('user-42', (s) => render(s));
unsubscribe();
```

The callback fires once immediately and then on every change. In React, use
[`useEntityStatus`](/expo-llm-wiki/reference/hooks/#useentitystatus).
