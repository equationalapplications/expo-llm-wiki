# Public `WikiMemory.syncSearchIndex()`: Design

**Date:** 2026-09-30
**Status:** Draft — awaiting review
**Branch:** `docs/core-sync-search-index-246`
**Source baseline:** `18a34f8` (v7.8.0)
**Issue:** #246

**Delivery:** one PR. This spec is committed first (`docs(core)`) and reviewed as a draft PR; the code lands on the same branch after approval (`feat(core)`). Merged as a merge commit, never squash. Additive and non-breaking, so the release is a 7.x minor.

## 1. Problem

`upsertGraph(entityId, params, tx)` writes inside the host's transaction. Core never sees that commit, so it cannot index the new nodes itself. Instead it calls `searchService.markStale(entityId)`, which makes the entity's *next* `syncEntries` do a full rebuild.

Nothing public triggers that next sync. So after the host commits, `read(entityId, query)` on the same instance misses the new nodes on every path that uses the keyword index:
- keyword ranking
- prefilter
- hybrid blend
- keyword fallback

`RetrievalService` queries MiniSearch directly and never looks at stale state. The full-scan semantic path reads SQLite, but upsertGraph nodes have no embeddings yet, so it can't surface them either. The nodes only become findable after:
- the entity's next core write (`importDump`, `ingestDocument`, `write`, or a maintenance pass), or
- a fresh instance's `setup()`, which runs a global `sync()`.

`incrementalSearchIndex.test.ts` ("upsertGraph nodes become keyword-searchable on the entity's next core write") pins exactly this.

**The workaround in use today** (SynapseTree) is:

```ts
await wiki.runPrune(entityId, { retainSoftDeletedFor: null, retainEventsFor: null });
```

It deletes nothing, and its final `syncEntries(entityId, syncedIds)` rebuilds the stale entity. But it relies on an implementation detail of prune. It also takes the prune job lock, and it performs prune's other work: if `pruneSupersededAfter` is configured, it hard-deletes superseded rows. A future prune change could silently break these hosts.

`upsertGraph`'s own JSDoc makes this worse. It tells hosts to drive the maintenance sweep for post-commit work, which conflates search indexing (cheap, local, no LLM) with embedding (the sweep's job).

## 2. Decision

Add one public method to `WikiMemory`:

```ts
/**
 * Brings the keyword search index up to date with SQLite after a host
 * transaction that used upsertGraph has committed.
 *
 * With `entityId`: rebuilds that entity if it is stale or has never been
 * indexed; otherwise a no-op that still waits for index rebuilds already
 * queued. Without: does the same for every entity currently marked stale.
 *
 * Call only after the host's transaction commits. Serialized with core's
 * internal index syncs. Never rejects: on failure the entity stays stale
 * and the next call retries it. Does not compute embeddings — that remains
 * the maintenance sweep's job.
 */
async syncSearchIndex(entityId?: string): Promise<void>
```

### 2.1 With an `entityId`

```ts
assertEntityId(entityId);
return this.searchService.syncEntries(entityId, []);
```

`syncEntries(id, [])` already has exactly the required semantics (`SearchService.ts`, `syncEntries`):

| Entity state | Behaviour |
|---|---|
| Stale (marked by `upsertGraph`) | Full `rebuildIndex(entityId)`. Clears the stale flag only if no new `markStale` landed during the rebuild's read (the `staleEpochs` check). Vacuums, evicts the vector cache. |
| Never indexed on this instance | Full rebuild, which registers it. |
| Tracked and not stale | No-op that returns the current `syncChain`, so the caller still waits for rebuilds already queued. No vector-cache eviction. |
| Rebuild throws | Caught. Entity re-marked stale, `console.warn`, resolves. |

It runs on the same `syncChain` as every internal sync (`importDump`, `ingestDocument`, maintenance passes, `forget`), so no extra locking is needed. It deliberately takes **no** `JobManager` lock. Maintenance does not hold a lock across its own index syncs either, and taking one here would make a harmless call fail with lock contention during a concurrent maintenance pass.

`assertEntityId` is the existing module-level guard (`WikiMemory.ts`). It throws `TypeError('Invalid entityId: must be a non-empty string.')`, the same as `pendingSources`, `lint` and `getInstructions`. This is the method's only throw. It happens synchronously inside the async function, so it surfaces as a rejected promise. "Never rejects" therefore applies to valid input only, which the JSDoc must say.

### 2.2 Without an argument — **review decision**

The issue is internally inconsistent here. Its JSDoc says "for every stale entity when omitted", but its implementation note says "delegate to `searchService.sync()`". Those differ: `sync()` with no argument rebuilds **every** entity's index, then vacuums and clears the whole vector cache. That is O(database), the same cost as `setup()`.

**Recommended: sync stale entities only.** Add one method to `SearchService`:

```ts
/** Runs syncEntries(id, []) for each entity currently marked stale. */
async syncStale(): Promise<void> {
  const ids = [...this.staleEntities];
  await Promise.all(ids.map((id) => this.syncEntries(id, [])));
}
```

- It snapshots the stale set when called. An entity marked stale afterwards is left for the next call, which the "after commit" contract already covers.
- Each `syncEntries` call chains itself onto `syncChain`, so `Promise.all` does not run rebuilds in parallel. It only waits for all of them to finish.
- If nothing is stale it resolves immediately without waiting on the chain. That is acceptable, because there is nothing for the caller to observe.
- It matches the JSDoc and the method name ("bring up to date", not "rebuild everything"), and costs O(stale entities).
- It suits hosts that batch writes to several entities in one transaction.

**Alternative: delegate to `sync()`.** No new `SearchService` method, but a host that calls `syncSearchIndex()` after every multi-entity transaction pays a full-database rebuild each time. It would also need a different JSDoc.

**Alternative: drop the no-argument form (YAGNI).** SynapseTree, the only known consumer, always knows the entity it wrote. The signature could require `entityId`, and a no-argument form could be added later without breaking anyone.

This spec assumes the recommended option. §5 and §6 change accordingly if the review picks one of the others.

## 3. Contract details

**Call after commit, not inside the transaction.** `SQLiteAdapter` exposes no transaction state, so this is documented, not enforced.

What goes wrong if a host calls it inside its open transaction:
- The rebuild reads SQLite through core's own adapter, not the host's `tx`. Depending on the driver's connection model, it either sees the uncommitted rows (they become phantom documents if the host rolls back) or misses them.
- Either way, `markStale` ran *before* the rebuild took its epoch snapshot. The epochs match, so the rebuild clears the stale flag.
- If it missed the rows, they stay unindexed until the next `markStale` or full `sync()`.

The JSDoc on both `syncSearchIndex` and `upsertGraph` states the rule plainly.

**Rollback.** If the host rolls back instead of committing, the entity is still marked stale. Calling `syncSearchIndex` anyway is harmless: the rebuild reads the rolled-back state, which is correct. Not calling it is also fine, because the next core write rebuilds the entity.

**No embedding.** New upsertGraph nodes still have no vectors until a maintenance pass embeds them, so pure-semantic ranking won't surface them yet. That is unchanged and stays documented. The method fixes keyword, prefilter, hybrid and fallback retrieval.

**Diagnostics.** None are emitted. Index failures are logged with `console.warn` inside `SearchService`, as they already are for every internal sync. A new diagnostic code is out of scope.

**Idempotent and cheap to over-call.** Calling it on a non-stale entity is a chain-wait. Hosts may call it after every commit without checking anything first.

## 4. Considered and rejected: lazy sync inside `read()`

`read()` could `await syncEntries(entityId, [])` whenever the entity is stale, fixing the bug with no host change. Rejected because:
- **Wrong timing.** A host that reads inside its own open transaction, after `upsertGraph`, would trigger exactly the mid-transaction rebuild §3 warns about, invisibly and with no way to opt out.
- **Hidden cost.** The first `read` after an `upsertGraph` would pay an O(entity) rebuild inside a latency-sensitive call.
- **Changes an existing contract.** today `read` never mutates index state; it only queries MiniSearch and SQLite.

An explicit call after commit puts the cost and the timing where the host controls them.

## 5. Changes

### Code
- `packages/core/src/WikiMemory.ts`: add `syncSearchIndex(entityId?)` next to `clearVectorCache()`.
- `packages/core/src/services/SearchService.ts`: add `syncStale()` (recommended option in §2.2 only).

### Docs
- `WikiMemory.upsertGraph` JSDoc: replace "Hosts that want embeddings synced should drive the existing maintenance sweep…" with two sentences:
  - Call `syncSearchIndex(entityId)` after the transaction commits to make the nodes keyword-searchable.
  - Embeddings still come from the maintenance sweep (`runLibrarian` / `runHeal` / `runOntologyBackfill` / `runPrune`, scoped via `listEntityIds`).
- Update the inline comment above `markStale` in `upsertGraph` to name `syncSearchIndex` as the intended trigger.
- `README.md`, "Direct Graph Write" (`###` section): extend the example to show the commit, then `await wiki.syncSearchIndex('entity-123')`. Add one sentence explaining why (core never sees the host's commit) and the after-commit rule.
- `packages/core/README.md`, "Direct Graph Write" (`##` section): the same change. The two sections are near-duplicates today and should stay in sync.
- No change to `docs/synapsetree-integration.md`: it doesn't document `upsertGraph`. SynapseTree swaps its `runPrune` workaround on its own side.

### Not changed
- `runPrune` keeps re-syncing the entity at the end. Hosts using the workaround keep working. The workaround just stops being the recommended path.
- No change to `markStale`, `syncEntries`, `sync`, `RetrievalService`, or any repository.
- No change to `core-llm-tools`: this is a host API, not a model-facing tool.

## 6. Tests

New `describe` block in `packages/core/__tests__/incrementalSearchIndex.test.ts`, reusing its `freshWiki` / `search` / `dumpOf` / `makeFact` helpers and read-count instrumentation:

1. **The fix.** `upsertGraph` inside `withTransactionAsync` commits. `search(wiki, 'pelican')` is `[]`. After `await wiki.syncSearchIndex(ENTITY)`, it returns `['node_1']`. The existing "next core write" test stays as is.
2. **The public read path.** Same setup, asserting through `wiki.read(ENTITY, 'pelican')` rather than the `__testAccess` search helper. Covers the default read path, and hybrid when an `embed` stub is configured.
3. **No-op on a clean entity.** Index an entity, then call `syncSearchIndex(ENTITY)`. The read counters show zero full reads and zero row reads.
4. **No-argument form rebuilds stale entities only.** Run `upsertGraph` on two entities in one transaction and leave a third entity clean. After `syncSearchIndex()`, both upserted entities are searchable and the clean entity saw no full read.
5. **Never rejects on index failure.** Make `entryRepo`'s rebuild read throw once. `syncSearchIndex(ENTITY)` resolves and the entity is still stale. A second call, with the read restored, indexes the node.
6. **Epoch safety.** A `markStale(ENTITY)` landing during the rebuild's read (injected via the read hook) leaves the entity stale after the call resolves.
7. **Concurrent with maintenance.** Start `runPrune(ENTITY, …)` and `syncSearchIndex(ENTITY)` without awaiting between them. Both resolve, and the final index contains the node.
8. **Input validation.** `syncSearchIndex('')` rejects with `TypeError('Invalid entityId: must be a non-empty string.')`.

In `packages/core/__tests__/upsertGraphContract.test.ts`, add `syncSearchIndex` to the public API surface assertions (exists as a function on `WikiMemory`).

If the review picks the "delegate to `sync()`" alternative, test 4 changes to assert that every entity is rebuilt. If it picks "drop the no-argument form", test 4 is removed and the signature takes a required `entityId`.

## 7. Release

- Code commit type: `feat(core): add WikiMemory.syncSearchIndex() for hosts that write through upsertGraph (#246)`, which produces a minor release (7.9.0 unless something else lands first).
- No `BREAKING CHANGE` footer. The method is additive, and no existing behaviour changes.
- Close #246 from the code PR.
