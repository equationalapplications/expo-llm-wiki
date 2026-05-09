# Spec: Observable Entity Status — `subscribeEntityStatus`

**Date:** 2026-05-08
**Status:** Final
**Tracks:** [GitHub issue #8](https://github.com/equationalapplications/expo-llm-wiki/issues/8)
**Package:** `@equationalapplications/expo-llm-wiki-core` (`packages/core`)

---

## Problem

`WikiMemory.getEntityStatus(entityId)` (defined at `packages/core/src/WikiMemory.ts` ~line 2199) returns a synchronous point-in-time `EntityStatus` snapshot:

```typescript
// packages/core/src/types.ts
export interface EntityStatus {
  ingesting: boolean;
  librarian: boolean;
  heal: boolean;
}
```

Consumers that need live UI updates have no push channel today: no events, no subscription, no React integration beyond manual polling. Polling is wasteful when idle, adds up to one poll interval of display lag on transitions, and composes poorly with React (`setInterval` in `useEffect`).

`useWikiIngest()` (in `packages/react/src/useWikiIngest.ts`) only exposes `isPending` for ingest started by that hook's component; cross-component ingest still needs a wiki-level signal. Critically, **librarian work auto-triggered inside `write()` once the threshold is reached** (see `runLibrarianThenMaybeHeal` invocation around `WikiMemory.ts` line 1743) has no call-site observable today — that is the primary motivation for a package-level subscription.

---

## Goal

Add a **subscription API** on `WikiMemory` that invokes a callback when the `EntityStatus` for a given `entityId` **changes** (any of the three booleans flips).

Delivery **MUST** be driven only by:

1. The mandatory synchronous initial emission on subscribe, and
2. Mutations to `activeIngestJobs` / `activeMaintenanceJobs` that change the computed status for that subscriber's `entityId`.

Implementations **MUST NOT** invoke callbacks from `setInterval`, `setTimeout`, `requestAnimationFrame`, `queueMicrotask`, or any periodic poll.

---

## API

```typescript
// packages/core/src/WikiMemory.ts — public method on WikiMemory
subscribeEntityStatus(
  entityId: string,
  callback: (status: EntityStatus) => void
): () => void;
```

- **`entityId`** **MUST** use the same semantics as `getEntityStatus(entityId)` (no normalization, no wildcard).
- **Return value** **MUST** be an unsubscribe function. Calling it removes the subscription; **repeated calls MUST be safe no-ops** (idempotent).
- **`EntityStatus`** **MUST** be the existing exported interface from `packages/core/src/types.ts` (re-exported from the package index via `export * from './types'`). No new fields are added.

### Semantics (normative)

1. **Initial emission.** `subscribeEntityStatus` **MUST** synchronously invoke `callback` exactly once, before returning the unsubscribe function, with a value field-equivalent to `getEntityStatus(entityId)` at subscription time. Implementations **MUST NOT** defer this emission to a microtask, timer, or later turn.

2. **Transition-only notifications.** After every code path that adds to or removes from `activeIngestJobs` or `activeMaintenanceJobs` for keys whose suffix affects this entity's status (see Scope below), implementations **MUST** compute the new `EntityStatus` for each subscribed `entityId` whose status could be affected and compare it to the **last value passed to that subscription's callback**. If any of `ingesting`, `librarian`, or `heal` differ, implementations **MUST** synchronously invoke `callback` with the new object. Implementations **MUST NOT** invoke `callback` when the three booleans are unchanged from the last emission (no heartbeat, no duplicate snapshots).

3. **Object identity.** Each emission **MAY** be a new object literal. Callers **MUST NOT** rely on referential equality across emissions; equality of the three booleans is the contract.

4. **Delivery timing.** When a `Set` mutation on `activeIngestJobs` or `activeMaintenanceJobs` changes a subscriber's `EntityStatus`, implementations **MUST** invoke `callback` immediately after that mutation, in the same synchronous execution chunk (before the call stack unwinds past the notifier helper). Implementations **MUST NOT** queue notifications on `queueMicrotask`, `setTimeout`, `requestAnimationFrame`, or equivalent.

5. **Listener isolation.** A throwing `callback` **MUST NOT** corrupt `WikiMemory` state, prevent the surrounding job code from completing, or suppress delivery to other subscribers. Implementations **MUST** wrap each listener invocation in a try/catch and route caught errors to the same channel `WikiMemory` uses for non-fatal background errors (currently `console.error`, consistent with the librarian dispatch at `WikiMemory.ts` ~line 1745). The mutation that triggered the notification still completes.

6. **Subscribe during emission.** A `subscribeEntityStatus` call made from inside another listener's callback **MUST** receive its initial emission synchronously (per rule 1). It **MUST NOT** receive duplicate notifications for the in-flight transition.

7. **Unsubscribe during emission.** Calling the unsubscribe function from inside a listener callback **MUST** prevent any further callbacks to that listener, including for any not-yet-iterated listeners of the same in-flight transition for the same `entityId`. Implementations **MUST** iterate listeners over a snapshot (or equivalent) so concurrent removal does not throw or skip remaining listeners.

---

## Scope of status (unchanged from `getEntityStatus`)

The exact computation lives in `getEntityStatus` and **MUST** be reused (or kept identical to) the canonical definition:

- **`ingesting`** — true iff any key in `activeIngestJobs` starts with `` `${prefix}:${entityId}:` ``. The existing private helper `_isIngestActiveFor(entityId)` in `WikiMemory.ts` already encapsulates this scan and **SHOULD** be reused.
- **`librarian`** — `activeMaintenanceJobs.has(_librarianKey(entityId))`.
- **`heal`** — `activeMaintenanceJobs.has(_healKey(entityId))`.

Other maintenance keys (`prune`, `reembed`, `import`, `forget`, global `_globalReembedKey`, `_globalImportKey`) are **out of scope** for `EntityStatus` and **MUST NOT** be folded into this subscription. If `EntityStatus` is later extended, this spec **MUST** be revised in tandem.

---

## Implementation sketch

### Storage

```typescript
// inside WikiMemory
private statusSubscribers = new Map<
  string, // entityId
  Set<{ callback: (s: EntityStatus) => void; last: EntityStatus }>
>();
```

### Notifier helper

```typescript
private _notifyStatusSubscribers(entityId: string): void {
  const set = this.statusSubscribers.get(entityId);
  if (!set || set.size === 0) return;
  const next = this.getEntityStatus(entityId);
  // Snapshot for safe iteration if a callback unsubscribes.
  for (const entry of Array.from(set)) {
    if (
      entry.last.ingesting === next.ingesting &&
      entry.last.librarian === next.librarian &&
      entry.last.heal === next.heal
    ) continue;
    entry.last = next;
    try {
      entry.callback(next);
    } catch (err) {
      console.error(err);
    }
  }
}
```

### Public API

```typescript
subscribeEntityStatus(
  entityId: string,
  callback: (status: EntityStatus) => void
): () => void {
  const initial = this.getEntityStatus(entityId);
  // Synchronous initial emission BEFORE registering, so a throwing callback
  // does not leave a stale entry in the set; any throw is also caught here.
  try { callback(initial); } catch (err) { console.error(err); }

  let set = this.statusSubscribers.get(entityId);
  if (!set) {
    set = new Set();
    this.statusSubscribers.set(entityId, set);
  }
  const entry = { callback, last: initial };
  set.add(entry);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const s = this.statusSubscribers.get(entityId);
    if (!s) return;
    s.delete(entry);
    if (s.size === 0) this.statusSubscribers.delete(entityId);
  };
}
```

### Mutation call-sites that MUST notify

Every `add` / `delete` listed below **MUST** be paired with a `_notifyStatusSubscribers(entityId)` call **after** the set mutation. Approximate current line numbers in `packages/core/src/WikiMemory.ts` are listed for reviewer convenience; implementations **MUST** locate them by code, not by line number.

| Job | Add site (approx.) | Delete site (approx.) | Notes |
|---|---|---|---|
| Auto-librarian (in `write()` path) | ~1743 `activeMaintenanceJobs.add(jobKey)` | ~1746 `.finally(() => …delete(jobKey))` | `entityId` is in scope. |
| Auto-heal (inside `runLibrarianThenMaybeHeal`) | ~1768 `activeMaintenanceJobs.add(healKey)` | ~1777 `.delete(healKey)` in `finally` | `entityId` is in scope. |
| Ingest | ~2948 `activeIngestJobs.add(jobKey)` | ~3033 `activeIngestJobs.delete(jobKey)` in `finally` | Notify with the ingest's `entityId`. |

Job sets that **do not** affect `EntityStatus` (`prune`, `reembed`, `import`, `forget`, global keys) **MUST NOT** invoke the notifier. Adding a notify call there is harmless functionally but is a spec violation that wastes work and risks future drift.

### Reuse, do not duplicate

`subscribeEntityStatus` and `_notifyStatusSubscribers` **MUST** call `getEntityStatus(entityId)` rather than reimplementing the boolean computation. This guarantees the subscription contract stays bit-for-bit identical to point-in-time reads.

### Performance

Per transition: O(subscribers for the affected `entityId`). Each comparison is three boolean equality checks. Negligible vs. SQLite I/O and LLM calls.

---

## Testing

New tests **MUST** live in `packages/core/__tests__/`. Extend the patterns in `jobs.test.ts` (which already exercises `getEntityStatus`).

Required cases:

1. **Initial emission.** Subscribe → callback invoked synchronously exactly once with `{ ingesting: false, librarian: false, heal: false }` (or the actual current status if any job is in flight). Assert the call happens before `subscribe…` returns.
2. **Ingest transition.** Drive `ingestDocument` (or simulate via test helpers) → callback invoked exactly once with `ingesting: true` after add, exactly once with `ingesting: false` after delete. No intermediate redundant invocations.
3. **Librarian transition.** Trigger the auto-librarian path (write enough events to cross threshold, or invoke the dispatch helper directly) → callback invoked with `librarian: true` then `librarian: false`.
4. **Heal transition.** Same pattern for the heal dispatch.
5. **No-op writes.** A mutation to `activeIngestJobs` / `activeMaintenanceJobs` that does **not** change any of the three booleans for the subscriber **MUST NOT** invoke the callback.
6. **Out-of-scope jobs.** Running `runPrune`, `runReembed`, `importMemoryDump`, or `forget` for the subscribed entity **MUST NOT** invoke the callback (none of `ingesting`/`librarian`/`heal` flip).
7. **Unsubscribe.** After unsubscribe: subsequent ingest start/stop **MUST NOT** invoke the callback. A second call to the unsubscribe function **MUST** be a no-op (no throw, no side effect).
8. **Multiple subscribers, same entity.** Each receives its own initial emission and every subsequent transition. Unsubscribing one **MUST NOT** affect the other.
9. **Cross-entity isolation.** Jobs scoped to `entityId = "a"` **MUST NOT** notify a subscriber for `entityId = "b"`.
10. **Throwing callback.** A listener that throws on the initial emission and on transitions **MUST NOT** prevent `subscribeEntityStatus` from returning a working unsubscribe, **MUST NOT** prevent other subscribers from being notified, and **MUST NOT** prevent the underlying job from completing. Caught errors land on `console.error` (assert via spy).
11. **Unsubscribe during emission.** With two listeners A and B for the same entity, when A's callback unsubscribes B during a transition, B **MUST NOT** be invoked for that transition.
12. **Subscribe during emission.** A subscription created from inside another callback receives its initial emission synchronously and is **not** invoked again for the same in-flight transition.

---

## Public API surface

- `WikiMemory.subscribeEntityStatus` becomes part of the supported public API. It **MUST** be reflected in:
  - JSDoc on the method, cross-linking `getEntityStatus` and `EntityStatus`.
  - `packages/core/README.md` under the same section that documents `getEntityStatus`.
  - `CHANGELOG.md` under a `### Added` entry for the next minor of the core package (semantic-release feat).
- `EntityStatus` is already exported from the package index and **MUST NOT** change shape.

## React consumer (out of scope, follow-up)

A future PR **MAY** add `useEntityStatus(entityId)` to `packages/react` as a thin wrapper:

```typescript
useEffect(() => {
  const wiki = getWiki();
  return wiki.subscribeEntityStatus(entityId, setStatus);
}, [entityId]);
```

This is **explicitly not required** for this spec to be considered delivered.

---

## Non-goals

- RxJS, MobX, signals, or any reactive framework dependency.
- Subscriptions keyed by wildcards, prefixes, or "all entities."
- Extending `EntityStatus` beyond the three current booleans.
- Pushing progress percentages, sub-phases, or per-fact events.
- Cross-process / cross-tab fan-out (single in-memory `WikiMemory` instance only).

---

## Acceptance

- `subscribeEntityStatus` is exported on `WikiMemory` and behaves per every **MUST** / **MUST NOT** above.
- All twelve test cases in the Testing section are implemented under `packages/core/__tests__/` and pass with `pnpm test`.
- `getEntityStatus` remains the single source of truth for the boolean computation; the notifier delegates to it.
- Notifier is invoked at exactly the three add/delete site pairs listed (librarian, heal, ingest) and nowhere else.
- Documentation and changelog entries land in the same PR as the implementation.
- Issue #8 is closed when the implementing release ships.
