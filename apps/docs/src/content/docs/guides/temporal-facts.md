---
title: Temporal facts
description: Keep history when facts change — supersede, asOf reads, history chains, and occurred_at on events.
sidebar:
  order: 8
---

Facts can carry a validity window, `[valid_from, valid_to)`. Nothing changes until you use it:
a fact with no validity data is always current.

## Replace a fact and keep history

```ts
// The user moved; the move happened on March 1.
const { newId } = await wiki.supersede(
  'user-123',
  seattleFactId,
  { title: 'Lives in San Francisco', body: 'Moved in March.' },
  { validFrom: Date.parse('2026-03-01') },
);
```

## Ask about the past

```ts
await wiki.read('user-123', 'where do I live');                                   // San Francisco
await wiki.read('user-123', 'where do I live', { asOf: Date.parse('2026-02-01') }); // Seattle
await wiki.history('user-123', seattleFactId);                                     // [Seattle, San Francisco]
```

- The window is **half-open**. At the switch instant, only the new fact matches.
- `asOf` answers "what do we *now* know was true at time T". If you learn about a past change
  late, past queries still come out correct.
- `traverseGraph({ asOf })` only walks edges whose two facts were both live at that instant.

To record a new fact that replaces nothing, use [`remember()`](/expo-llm-wiki/reference/wiki-memory/#remember) with an optional `valid_from`. It stores the fact directly, with no LLM call. `supersede()` is still the way to replace one.

## Rules

`supersede()` throws `WikiSupersedeError` (with a `reason`) when the target:

- is an `immutable_document` fact (re-ingest the document instead),
- belongs to another entity,
- is already superseded, or
- would create a cycle.

## Record when events really happened

```ts
await wiki.write('user-123', {
  event_type: 'observation',
  summary: 'Moved to SF',
  occurred_at: Date.parse('2026-03-01'), // real-world time; defaults to ingestion time
});
```

Pass the **client's** timestamp, so a delayed or queued write still reflects when the event happened.

## Retention

History is kept indefinitely by default. Set `config.pruneSupersededAfter` (in days) to let
`runPrune()` retire facts that expired that long ago. `getMemoryBundle()` and `exportDump()`
return all non-deleted facts, including history.

:::tip
The `'ops'` [librarian strategy](/expo-llm-wiki/guides/maintenance/#librarian-strategies) uses
`supersede()` for changed facts automatically, so you get history without writing any code.
:::
