# Spec: Observable Entity Status — `subscribeEntityStatus`

**Date:** 2026-05-07  
**Status:** Draft  
**Tracks:** [GitHub issue #8](https://github.com/equationalapplications/expo-llm-wiki/issues/8)

---

## Problem

`WikiMemory.getEntityStatus(entityId)` returns a synchronous point-in-time snapshot (`EntityStatus`: `ingesting`, `librarian`, `heal`). Consumers that need live UI updates have no push channel: no events, no subscription, no integration with React beyond manual polling.

Polling is wasteful when idle, adds up to one poll interval of display lag on transitions, and composes poorly with React (`setInterval` in `useEffect`).

`useWikiIngest().isPending` only covers ingest initiated by that hook’s component; cross-component ingest (e.g. composer vs. chat view) still needs a wiki-level signal. Librarian work triggered inside `write()` at threshold has no call-site observable today — that is the main motivation for a package-level subscription.

---

## Goal

Add a **subscription API** on `WikiMemory` that invokes a callback when the `EntityStatus` for a given `entityId` **changes** (any boolean flips). Implementations **MUST NOT** invoke callbacks from timers, animation frames, or any periodic poll; delivery **MUST** be driven only by (1) the mandatory synchronous initial emission on subscribe and (2) job-set mutations that change the computed status for that subscriber’s `entityId`.

---

## API

**Package:** `expo-llm-wiki` / `@equationalapplications/expo-llm-wiki-core` (`WikiMemory` in `packages/core`).

```typescript
subscribeEntityStatus(
  entityId: string,
  callback: (status: EntityStatus) => void
): () => void;
```

- **Parameters:** `entityId` **MUST** use the same semantics as `getEntityStatus`.
- **Return value:** An unsubscribe function. Calling it **MUST** remove the subscription; repeated calls **MUST** be safe no-ops.
- **`EntityStatus`:** Identical to `getEntityStatus` — reuse the existing exported interface from `packages/core/src/types.ts`.

### Semantics

1. **Initial emission:** On `subscribeEntityStatus`, implementations **MUST** synchronously invoke `callback` once with a value that matches `getEntityStatus(entityId)` field-for-field at subscription time. Implementations **MUST NOT** omit this call or defer it to a later turn.
2. **Transition-only notifications:** After each internal update that could affect status for a subscribed `entityId`, compute the new `EntityStatus` (same definition as `getEntityStatus`). Compare it to the **last value passed to this subscription’s `callback`**. If any of `ingesting`, `librarian`, or `heal` differ, implementations **MUST** synchronously invoke `callback` with the new object. Implementations **MUST NOT** invoke `callback` when the three booleans are unchanged from the last emission (no “heartbeat” or duplicate snapshots).
3. **Object identity:** Each emission **MAY** be a new object literal. Callers **MUST NOT** rely on referential equality across emissions.
4. **Delivery timing:** When a `Set` mutation on `activeIngestJobs` or `activeMaintenanceJobs` changes a subscriber’s `EntityStatus`, implementations **MUST** invoke `callback` immediately after that mutation, in the same synchronous chunk of execution (before the call stack unwinds past the notifier). Implementations **MUST NOT** queue transition notifications on `queueMicrotask`, `setTimeout`, `requestAnimationFrame`, or equivalent unless this spec is explicitly revised.
5. **Errors:** A throwing `callback` **MUST NOT** leave `WikiMemory` in a corrupted state or prevent other subscribers from being notified. Implementations **MUST** catch errors per listener (or equivalent isolation) so one subscriber’s failure does not suppress delivery to the rest.

---

## Scope of status (unchanged from `getEntityStatus`)

Status reflects:

- **ingesting:** any active ingest job whose key starts with `` `${prefix}:${entityId}:` `` (see `activeIngestJobs` iteration in `getEntityStatus`).
- **librarian / heal:** presence of `activeMaintenanceJobs` entries for `_librarianKey(entityId)` and `_healKey(entityId)`.

Other maintenance keys (`prune`, `reembed`, `import`, `forget`, …) are **out of scope** for `EntityStatus` today and **MUST NOT** be folded into `EntityStatus` or this subscription unless `EntityStatus` is extended in a separate spec change.

---

## Implementation sketch

Centralize “maybe notify subscribers for `entityId`” in private helpers called from every code path that **adds or removes** entries affecting that entity’s status:

- **Ingest:** around `activeIngestJobs.add` / `delete` for keys scoped to the entity (existing logic near `ingestDocument`).
- **Librarian / heal:** around `activeMaintenanceJobs.add` / `delete` for librarian and heal keys.

After each such mutation, for each subscribed `entityId` (or cheaply: only the `entityId` affected by that operation), compute next = `getEntityStatus(entityId)`, compare to last snapshot for each listener, emit if diff.

**Data structure:** Map from `entityId` → Set of `{ callback, last: EntityStatus }` (or per-callback last snapshot). On unsubscribe, remove listener; if set empty, drop map entry.

**Performance:** O(subscribers for touched entity) per job transition — negligible compared to I/O and LLM work.

---

## Testing

Conformance **MUST** be covered by unit tests in `packages/core/__tests__/` (extend patterns in `jobs.test.ts` for `getEntityStatus`):

- Subscribe → **MUST** receive an initial callback whose payload matches `getEntityStatus` for that `entityId`.
- Ingest start/end → **MUST** invoke the callback exactly once per `ingesting` transition (and **MUST NOT** spam on irrelevant internal steps).
- Librarian/heal start/end → `librarian` / `heal` transitions **MUST** notify.
- Unsubscribe → further job activity **MUST NOT** invoke the callback; a second unsubscribe **MUST** be a no-op.
- Multiple subscribers for one `entityId` → each **MUST** receive updates; unsubscribing one **MUST NOT** affect the other.
- Other entities’ jobs **MUST NOT** notify subscriptions for a different `entityId`.

---

## React consumer

Optional follow-up (not required for core spec closure): replace polling in app code (e.g. `ChatView`) with:

```typescript
useEffect(() => {
  if (!isPremium) return;
  const wiki = getWiki();
  return wiki.subscribeEntityStatus(characterId, setWikiStatus);
}, [characterId, isPremium]);
```

React package may later expose `useEntityStatus(entityId)` as a thin wrapper; **non-goal** for the initial core delivery unless explicitly scheduled.

---

## Non-goals

- RxJS, MobX, or other full reactive frameworks.
- Subscriptions keyed by wildcards or “all entities.”
- Extending `EntityStatus` beyond the three booleans (separate spec if needed).
- Pushing progress percentages or sub-phases of ingest.

---

## Documentation and changelog

- JSDoc on `subscribeEntityStatus` mirroring `getEntityStatus` cross-references.
- `CHANGELOG.md` under a minor feature entry for the core package.
- Core `README` / `packages/expo` README: one subsection pointing premium/React examples at subscription instead of polling where applicable.

---

## Acceptance

- `subscribeEntityStatus` **MUST** be part of the supported public API of the core package export surface.
- Behavior **MUST** satisfy every **MUST** / **MUST NOT** in this document and the tests listed above.
- Issue #8 **SHOULD** be closed once the implementation is released.
