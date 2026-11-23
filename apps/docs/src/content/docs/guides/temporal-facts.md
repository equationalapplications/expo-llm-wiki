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

## Expire a fact

To end a fact's validity without a replacement — an archive, not a
deletion — use `expire()`. It sets `valid_to` only: the fact stays in
the store, `asOf` reads before that time still return it, and no
supersession link is created.

```ts
await wiki.expire(entityId, factId, { at: validUntil });
```

It rejects a missing, foreign, already superseded, immutable-document,
or already expired fact, and an `at` at or before the fact's validity
start (`invalid_interval`) — the chosen `at` must be strictly later than
that start, and an omitted `at` applies the same rule to the current
time. A fact whose validity starts in the future rejects with
`invalid_interval` until that start. A negative or
non-finite `at` throws a `TypeError`.

## Rules

`supersede()` throws `WikiSupersedeError` (with a `reason`) when the target:

- has already ENDED — its `valid_to` is set to a time at or before now
  (an archived fact is protected from supersede, including a back-dated
  `validFrom`); superseding a fact whose scheduled end is still in the
  future is allowed, and that supersede overwrites the scheduled end
  with the supersede time. The overwritten end is kept in the fact's
  `prior_valid_to` and reported as an `info` diagnostic,
  `supersede_scheduled_end_replaced` (`detail.factId`, `detail.priorValidTo`);
- is an `immutable_document` fact (re-ingest the document instead),
- belongs to another entity,
- is already superseded, or
- would create a cycle.

`supersede()` also rejects a `validFrom` at or before the target's validity
start (its `valid_from`, else its creation time) with `invalid_interval`.
An omitted `validFrom` applies the same rule to the current time, so a fact
whose validity starts in the future — including one created in the same
millisecond as the call — rejects until that start. An explicit early
`valid_from` on the replacement fact is not validated against the target.

## Reopen a superseded fact

`reopen(entityId, factId)` returns a superseded fact to live. Use it when you forgot the fact's
replacement and the old fact should stand again:

```ts
await wiki.forget('user-123', { entryId: newId });   // the replacement
const { valid_to } = await wiki.reopen('user-123', oldId);
```

`reopen()` clears `superseded_by` and `superseded_at`, restores `valid_to` to the scheduled end the
supersede overwrote (`prior_valid_to`, or `null` when the fact was open-ended), and updates the search
index and read cache. It resolves with the restored `valid_to`. It throws `WikiSupersedeError` when:

- the fact is missing, soft-deleted or belongs to another entity (`not_found`, `cross_entity`);
- it is not superseded (`not_superseded`). A fact ended by `expire()` is not reopened;
- it is an `immutable_document` fact (`immutable_target`);
- its replacement is still live (`successor_live`). Any replacement that is not forgotten blocks
  reopen, including one that is itself superseded. Forget the replacement first. A forgotten or
  hard-deleted replacement passes. Only the direct replacement is checked, not the rest of a longer chain.

Two consequences. If the restored end has already passed, the fact comes back expired: `reopen()`
restores what you declared, it does not revalidate. A supersede recorded before schema 18 has no stored
end, so it restores `null`.

## Record when events really happened

```ts
await wiki.write('user-123', {
  event_type: 'observation',
  summary: 'Moved to SF',
  occurred_at: Date.parse('2026-03-01'), // real-world time; defaults to ingestion time
});
```

Pass the **client's** timestamp, so a delayed or queued write still reflects when the event happened.

The `'ops'` librarian sets `valid_from` on each fact it extracts. It uses the date the model
gives, if any. Otherwise it uses the source event's `occurred_at`, or the time the event was stored
when that is not set. If the model names no source event, it uses the newest such date in the
batch, but never a date later than the time of the pass. A fact taken from an event with a future
`occurred_at` keeps that future date, so current reads leave it out until then.

## Retention

History is kept indefinitely by default. Set `config.pruneSupersededAfter` (in days) to let
`runPrune()` retire facts that expired that long ago. `getMemoryBundle()` and `exportDump()`
return all non-deleted facts, including history.

:::tip
The `'ops'` [librarian strategy](/expo-llm-wiki/guides/maintenance/#librarian-strategies) uses
`supersede()` for changed facts automatically, so you get history without writing any code.
:::
