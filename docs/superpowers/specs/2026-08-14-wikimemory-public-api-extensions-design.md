# Spec: `WikiMemory` Public-API Extensions — `listEntityIds`, `upsertGraph`, `commitIngest`

**Date:** 2026-08-14
**Status:** Proposed
**Issues:** [#85](https://github.com/equationalapplications/expo-llm-wiki/issues/85), [#86](https://github.com/equationalapplications/expo-llm-wiki/issues/86)
**Packages:** `@eq/wiki-core`
**Consumer context:** `equationalapplications/aws-cloud-agent` — tier registry, deterministic-write ingest path for `tier_codebase`

---

## Problem

`WikiMemory` exposes 26 public methods; only two (`runReembed`, `exportDump`) operate without an explicit `entityId`, and neither reports the set of entity ids it touched. Two related gaps surface together:

1. **No enumeration of stored entities** ([#85](https://github.com/equationalapplications/expo-llm-wiki/issues/85)). Hosts that need to sweep a *scoped* namespace (e.g. one tier instance per reviewed repository) cannot learn which instances exist. The workarounds — querying the library's tables directly, or maintaining a parallel registry — both couple the host to schema or duplicate state that can drift from what the library actually holds.
2. **No deterministic write path into the graph** ([#86](https://github.com/equationalapplications/expo-llm-wiki/issues/86)). Both public write paths route through the LLM extractor. A `tier_codebase` namespace populated only by a Tree-sitter AST parser cannot use either without contamination — the AST is math, the extractor is probability, and a `calls` edge written via an LLM is not a fact about the code. `importDump({ merge: true })` is the only other surface that accepts facts structurally, but it acquires global + per-entity import locks, grouping `'import'` with `'reembed'` and `'prune'` rather than with `'ingest'`. Driving it once per source file inside a single-writer Lambda would put a global lock lifecycle in the inner loop and violates the consumer's transaction-participation requirement.

The motivating consumer is `aws-cloud-agent`, which holds a tier registry where a namespace is either a **singleton** (`business`, `goals`) or **scoped** (a template instantiated per subject, e.g. `codebase@owner/repo`). Maintenance (`runLibrarian` / `runHeal` / `runOntologyBackfill` / `runPrune`) runs on a schedule with no request context. For singletons the id list is a compile-time constant. For scoped namespaces, the host has no way to learn which instances exist.

---

## Solution

Three additions to the public `WikiMemory` API, plus one internal refactor. All additive. No schema migration. No new outbox event type. No breaking changes.

| Section | Surface | New / Modified |
| --- | --- | --- |
| §1 | `listEntityIds(options?: { prefix?: string }): Promise<string[]>` | New public method |
| §2 | `upsertGraph(entityId, params, adapter: SQLiteAdapter): Promise<{ nodesWritten; edgesWritten; superseded }>` | New public method |
| §3 | `commitIngest(entityId: string): Promise<{ embedded; failed; synced; evicted }>` | New public method |
| §4 | New error classes `WikiStrictOntologyViolation` and `WikiSourceRefHashCollision` | New exports |
| §2 (refactor) | `IngestionService.upsertGraphCore` extracted from `ingestDocument`; `validateAndNormalizeFact` / `validateInlineEdges` gain a `strict: boolean` flag; new `EdgeRepository.softDeleteBySourceFactIds` method | Internal refactor |

`upsertGraph` is "the tail of `ingestDocument` with the middle (LLM extraction) step removed." It accepts caller-supplied nodes and edges and writes them directly under `(sourceRef, sourceHash)` semantics identical to `ingestDocument`, with one structural difference: it must participate in the caller's transaction (C1 in §2) rather than open its own.

---

## §1. `WikiMemory.listEntityIds`

```ts
listEntityIds(options?: { prefix?: string }): Promise<string[]>;
```

Returns the set of `entity_id` values with at least one row in this database — **including entities whose only remaining rows are soft-deleted** — ascending by `entity_id COLLATE BINARY`. Empty array when the database has no entities.

**Why include soft-deleted-only entities.** The motivating use case for this method (#85) is host-driven maintenance scheduling: a host runs `runLibrarian` / `runHeal` / `runOntologyBackfill` / `runPrune` over the entity set returned by `listEntityIds`. If a scoped namespace has all its documents forgotten or superseded, it has only soft-deleted rows. A `listEntityIds` that filtered on `deleted_at IS NULL` would no longer return that namespace, the host's pruning loop would skip it, and the soft-deleted rows would never be hard-deleted — a permanent storage leak for decommissioned scopes. Including soft-deleted-only entities closes this gap: the host's pruning loop visits orphaned namespaces and `runPrune` reaps them.

**Source query.** Thin wrapper over `MetadataRepository.getDistinctEntityIds`. The repo's underlying query is widened (from its current `deleted_at IS NULL` form on entries and tasks) to a UNION across `${prefix}entries`, `${prefix}tasks`, and `${prefix}events` with no soft-delete filters, sorted by `entity_id COLLATE BINARY`.

**Effect on `exportDump`.** `exportDump` calls `getDistinctEntityIds` to enumerate entities to dump. With this change, `exportDump` will include orphaned entities (those with only soft-deleted rows) in its output. This is a deliberate widening of `exportDump`'s effective coverage — exports should be conservative for backup and migration, not selective — and is **not** a breaking change to `exportDump`'s API contract (the return shape is unchanged; only the set of entities included grows). Documented in the host-visible CHANGELOG under the `core` package.

**Optional `prefix` filter.** Applied as a post-read `.filter(id => id.startsWith(prefix))`. The `(entity_id, source_ref)` index is not seekable on `entity_id`-only prefix, so this is O(n) over distinct ids. Documented contract. Empty-string prefix matches every id (`''.startsWith('')` is true).

**Lock / transaction semantics.** Read-only. Never acquires any lock. Never opens a transaction. Propagates any underlying read errors.

**Return contract:**
- Empty database → `[]`.
- Prefix matches nothing → `[]`.
- Empty-string prefix → all ids.
- Soft-deleted-only entities → included.

```sql
-- (widened from previous form; was filtered on deleted_at IS NULL)
SELECT DISTINCT entity_id FROM ${prefix}entries
UNION
SELECT DISTINCT entity_id FROM ${prefix}tasks
UNION
SELECT DISTINCT entity_id FROM ${prefix}events
ORDER BY 1 COLLATE BINARY
```

---

## §2. `WikiMemory.upsertGraph`

### Signature

```ts
upsertGraph(
  entityId: string,
  params: {
    sourceRef: string;
    sourceHash: string;
    nodes: readonly { id: string; type: string; title: string; body?: string }[];
    edges: readonly { type: string; sourceId: string; targetId: string; id?: string }[];
  },
  adapter: SQLiteAdapter,
): Promise<{ nodesWritten: number; edgesWritten: number; superseded: number }>;
```

**`adapter` argument is required (not optional).** It is the `tx` the caller is already holding inside their `withTransactionAsync` callback. WikiMemory stores a `withSerializedTransactions`-wrapped adapter internally and exposes no way to "join" a caller's transaction; the third argument is the only mechanism that satisfies C1 below.

> *Note on the issue:* the proposed signature in [#86](https://github.com/equationalapplications/expo-llm-wiki/issues/86) is `upsertGraph(entityId, params)` (two args). This spec amends it to three args because C1 cannot otherwise be satisfied. The consumer's spec (`docs/superpowers/specs/2026-08-13-graph-write-intent-design.md` §2.2 in `equationalapplications/aws-cloud-agent`) explicitly requires the third-arg shape.

**Caller-supplied node ids.** Required for cross-file edge resolution and re-parse idempotency. The consumer derives them deterministically (e.g. `sha256(entityId:sourceRef:type:symbolPath)`) so that a re-parse produces identical ids. Library-side id generation would break that contract.

### Contract clauses (non-negotiable)

These four clauses are extracted from concrete constraints in the consuming host. Each has a host-side test that fails if violated.

#### C1 — Participates in the caller's transaction

`upsertGraph` issues plain statements against the supplied `adapter`. **No `BEGIN`, no `COMMIT`, no lock acquisition, no `WikiBusyError`.** It does not call `jobManager.acquireIngestLocks`, `db.withTransactionAsync`, or any equivalent. The caller owns the transaction boundary.

An implementation that opened its own transaction could not be called from inside the consumer's `BEGIN IMMEDIATE` block — it would either nest a `BEGIN` (an error) or silently join a transaction it doesn't know it's in, so a rollback could leave the ledger and the graph disagreeing about whether the write happened.

This clause also makes the call cheap enough to invoke once per source file inside a single-writer Lambda draining SQS batches.

#### C2 — No-op on an unchanged scope

When `(entityId, params.sourceHash)` is already mapped to `params.sourceRef` in the `source_ref_index` table, write nothing and return `{ nodesWritten: 0, edgesWritten: 0, superseded: 0 }`. Reuses `hasChanged` semantics, implemented by reading `SourceRefIndexRepository.findActiveByEntityAndHash(entityId, sourceHash)` (a single read inside the caller's tx).

When the same hash is already mapped to a *different* `sourceRef`, throw `WikiSourceRefHashCollision` (§4) — the partial UNIQUE index `(entity_id, source_hash) WHERE deleted_at IS NULL` would reject the upsert in step 5 below, but failing loudly here gives a clearer message before any writes happen.

#### C3 — Dangling edge targets are legal

An edge whose `targetId` names a node that does not exist is stored, not rejected. The `edges` table has no foreign key on `target_id` (already absent in the schema); `EdgeRepository.addIgnoreDuplicate` inserts whatever the caller passes. A traversal that reaches a missing node simply doesn't continue through it.

This rule keeps batch correctness independent of file ordering. A `calls` edge from `auth.ts` to a symbol defined in `crypto.ts` is written when `auth.ts` is parsed — possibly before `crypto.ts` is parsed, possibly when it never will be.

C3 and C4 hold each other up: because dangling targets are stored rather than skipped, a correct writer always returns `edgesWritten === validEdges.length`, which is what makes the caller's "did you drop anything?" assertion sound. If C3 went the other way, edge loss and edge deferral would be indistinguishable in the return value.

#### C4 — Strict-mode violations throw

When the persisted ontology manifest for `entityId` has `mode === 'strict'`, an out-of-manifest node `type` or edge `type` causes `upsertGraph` to throw `WikiStrictOntologyViolation` (§4). Pre-flight validation is all-or-nothing: if any node or edge is invalid in strict mode, NONE are written — never drops the offending item and returns success.

Under non-strict modes (`'emergent'`, `'off'`, or no manifest), invalid types are silently dropped or written with `okf_type: null`, matching `ingestDocument`'s current behavior. The strict-mode harmonization for `ingestDocument` itself is out of scope for this spec (§5).

### Data flow

`upsertGraph(entityId, params, adapter)`:

1. **C2 probe**: `sourceRefIndexRepo.findActiveByEntityAndHash(entityId, params.sourceHash, adapter)`.
   - Result is null → fall through to step 2.
   - Result is non-null AND `result.sourceRef === params.sourceRef` → return `{ nodesWritten: 0, edgesWritten: 0, superseded: 0 }`. Idempotent no-op per C2.
   - Result is non-null with a different sourceRef → throw `WikiSourceRefHashCollision`.

2. **Delegate** to `injectionService.upsertGraphCore(entityId, params, adapter)`. Return its result.

`upsertGraphCore(entityId, params, tx)` (runs inside the supplied `tx`, no nested transaction, no lock acquisition):

a. **Read persisted ontology mode**: `metadataRepo.getManifest(entityId, tx)`. Set `mode = manifest?.mode ?? 'off'` and `strict = (mode === 'strict')`.

b. **Validate all node types** (pre-flight, all-or-nothing): for each `params.node`, call `validateAndNormalizeFact(node, manifest, { strict })`. If `strict` and the type is out-of-manifest → throws `WikiStrictOntologyViolation` on the first invalid node. Otherwise the helper returns the canonical slug or `null`; `null` results in a fact written with `okf_type: null` (matches `ingestDocument`'s silent-drop semantics for the non-strict path).

c. **Validate all edge types** (pre-flight, all-or-nothing): group `params.edges` by `sourceId`. For each source node `n` in `params.nodes`, validate that node's outgoing edges via `validateInlineEdges(n.type, edgesForN, manifest, { strict })`. Aggregate valid edges across all source-node groups. If `strict` and any edge type is out-of-manifest for its source's type → throws `WikiStrictOntologyViolation` on the first invalid edge. Otherwise invalid edges are filtered out across groups.

d. **Supersede prior facts for `sourceRef`**: `entryRepo.softDeleteBySource(entityId, tx, params.sourceRef, null)`. Capture `deletedFactIds`; their count contributes to `superseded`.

e. **Supersede prior edges** whose source is in `deletedFactIds`: `edgeRepo.softDeleteBySourceFactIds(entityId, deletedFactIds, tx)`. This is the new `EdgeRepository` method that closes a gap the current `ingestDocument` does not have — without it, a re-parse with a new `sourceHash` would leave stale edges from the prior parse around. `deletedFactIds.length + deletedEdgeIds.length` is the `superseded` count returned.

f. **Clear prior `source_ref_index` row** for `(entityId, sourceRef)`: `sourceRefIndexRepo.softDeleteByEntityAndSourceRef(entityId, params.sourceRef, tx)`.

g. **Take ownership** of `(entityId, sourceHash, sourceRef)`: `sourceRefIndexRepo.upsert(entityId, params.sourceHash, params.sourceRef, tx)`. Partial UNIQUE index enforces uniqueness among non-deleted rows.

h. **Write nodes**: for each validated `WikiFact`, `entryRepo.upsert(wikiFact, tx)`. The repository stages an outbox INSERT per row and writes `source_ref`, `source_hash`, `source_type: 'immutable_document'`.

i. **Write edges**: for each valid edge from step (c), `edgeRepo.addIgnoreDuplicate(edge, tx)`. C3 satisfied — no FK on `target_id`, no title-index resolution, dangling targets stored verbatim.

j. **Return** `{ nodesWritten: params.nodes.length, edgesWritten: validEdges.length, superseded }`.

### Return shape

```ts
{ nodesWritten: number; edgesWritten: number; superseded: number }
```

`superseded` is the observable that proves replacement fired. An implementation that inserts the new subgraph and leaves the old one in place returns a plausible `nodesWritten` and is otherwise indistinguishable from a correct one — the graph would silently accumulate every historical version of every function, and the first symptom would be a traversal returning deleted code as current.

### Internal refactor: `upsertGraphCore`

The transactional block of `IngestionService.ingestDocument` (steps d–i above, parameterised over the source of the `(nodes, edges)` pair) is extracted as a new private method `IngestionService.upsertGraphCore(entityId, params, tx, opts?: { strict?: boolean })`. Both `ingestDocument` (with `strict: false`, preserving current behavior) and `WikiMemory.upsertGraph` (with `strict: true` driven by the persisted mode) route through it. The extraction boundary is the existing `withTransactionAsync` block in `ingestDocument`; the refactor is mechanical.

The lock acquisition (`acquireIngestLocks`), post-commit search sync, post-commit embedding, and cache eviction remain in `ingestDocument` and do **not** move into `upsertGraphCore`. They move into the new `commitIngest` (§3) for the deterministic-write path.

### Strict-mode validator change

`validateAndNormalizeFact` and `validateInlineEdges` (in `packages/core/src/utils/ontology.ts`) gain an optional `strict: boolean` parameter (default `false`):

```ts
validateAndNormalizeFact(
  fact: { type: string; /* … */ },
  manifest: OntologyManifest | null,
  opts?: { strict?: boolean },  // new; default false preserves current behavior
): { type: string | null /* canonical slug or null */ };

validateInlineEdges(
  sourceType: string,
  edges: readonly { type: string; /* … */ }[],
  manifest: OntologyManifest | null,
  opts?: { strict?: boolean },  // new
): readonly { type: string; /* … */ }[];
```

When `strict: true` and a type doesn't resolve against the manifest, the function throws `WikiStrictOntologyViolation` (§4). When `strict: false` (default), invalid types are silently dropped as today. All existing callers — currently only `IngestionService.ingestDocument` — continue to receive the default `strict: false`; grep-verified at implementation time.

---

## §3. `WikiMemory.commitIngest`

```ts
commitIngest(entityId: string): Promise<{
  embedded: number;
  failed: number;
  synced: boolean;
  evicted: boolean;
}>;
```

Post-commit companion for `upsertGraph`. Caller wraps multiple `upsertGraph` calls in their tx, commits, then calls `commitIngest(entityId)`. Encapsulates the post-commit pattern (search sync, embedding, cache eviction) in one method.

**Does not open its own transaction.** Caller's tx is already committed by the time `commitIngest` is called.

**Error tolerance:**
- `searchService.sync` failure: propagates (matches `runReembed`'s "fail loud on infrastructure" pattern).
- `embeddingService.embedFact` per-fact failure: counted in `failed`, does not fail the call. The loop is **sequential `await` with per-fact `try/catch`** (matches `runReembed`'s pattern). `Promise.allSettled` is **rejected** for this surface: concurrent embedding would defeat per-call rate limiting and complicate error attribution when several facts fail simultaneously. Because `embedFact` is an `async` LLM call, the failure mode is rejection; the loop awaits each call inside a `try/catch` and increments `failed` on rejection.
- `searchService.evictCache` failure: logged, `evicted: false`, does not fail the call (cache operations are best-effort).

**Scope:** embeds *all* facts in the entity with `embedding IS NULL`, regardless of `sourceRef`. This is conservative — if the caller wants to scope by `sourceRef`, they call `runReembed(entityId, { sourceRef })` separately. Documented contract.

**Steps:**
1. `searchService.sync(entityId)` → `synced: boolean`.
2. Loop: for each fact in `${prefix}entries` where `entity_id = ? AND embedding IS NULL`, call `embeddingService.embedFact(fact)`. Increment `embedded` on success, `failed` on throw.
3. `searchService.evictCache(entityId)` → `evicted: boolean`.
4. Return `{ embedded, failed, synced, evicted }`.

---

## §4. New error classes

Both added to `packages/core/src/types.ts` and re-exported from the package barrel. Extend `Error` directly. Mirror the existing `WikiBusyError` / `WikiDuplicateHashError` public shape (a `code` field plus named fields relevant to the violation).

### `WikiStrictOntologyViolation`

```ts
export class WikiStrictOntologyViolation extends Error {
  readonly entityId: string;
  readonly kind: 'node' | 'edge';
  readonly type: string;
  readonly code = 'WIKI_STRICT_ONTOLOGY_VIOLATION' as const;
  constructor(entityId: string, kind: 'node' | 'edge', type: string) {
    super(
      `Out-of-manifest ${kind} type "${type}" for entity "${entityId}" under strict mode.`,
    );
    this.entityId = entityId;
    this.kind = kind;
    this.type = type;
    this.name = 'WikiStrictOntologyViolation';
  }
}
```

Thrown when the persisted ontology mode is `'strict'` and a node or edge type doesn't resolve against the manifest. Per C4, all-or-nothing: the first invalid item throws; none are written.

### `WikiSourceRefHashCollision`

```ts
export class WikiSourceRefHashCollision extends Error {
  readonly entityId: string;
  readonly sourceHash: string;
  readonly existingSourceRef: string;
  readonly attemptedSourceRef: string;
  readonly code = 'WIKI_SOURCE_REF_HASH_COLLISION' as const;
  constructor(params: {
    entityId: string;
    sourceHash: string;
    existingSourceRef: string;
    attemptedSourceRef: string;
  }) {
    super(
      `Source hash "${params.sourceHash}" for entity "${params.entityId}" ` +
        `is already mapped to sourceRef "${params.existingSourceRef}"; ` +
        `cannot remap to "${params.attemptedSourceRef}".`,
    );
    this.entityId = params.entityId;
    this.sourceHash = params.sourceHash;
    this.existingSourceRef = params.existingSourceRef;
    this.attemptedSourceRef = params.attemptedSourceRef;
    this.name = 'WikiSourceRefHashCollision';
  }
}
```

Thrown at the C2 probe when the supplied `sourceHash` is already mapped to a different `sourceRef` for the same entity. Indicates either a caller-side bug (id derivation collision) or a race with another writer; in both cases fail loud.

---

## Cross-cutting

**Backwards compatibility:** all three new methods are additive. No existing method's signature changes. No return type widens in a way that breaks strict destructure-only callers.

**Public-surface ownership:** hosts use the `WikiMemory` facade. `IngestionService.upsertGraphCore`, `EdgeRepository.softDeleteBySourceFactIds`, and the new strict-mode validator option are library-internal. Migration off direct-schema access in the consumer (e.g. `aws-cloud-agent` reaching under the abstraction today) is the host's job; this spec does not change that.

**Outbox events:** unchanged. `upsertGraph` stages the same per-row INSERT outbox events that `ingestDocument` does today, via the same `entryRepo.upsert` path.

**Locking:** `upsertGraph` and `commitIngest` acquire no locks. The `'ingest'`, `'import'`, `'prune'`, `'librarian'`, `'heal'`, `'ontologyBackfill'`, `'reembed'`, and `'forget'` lock groupings are unaffected.

**Schema:** no migrations. No new columns. No new tables. No new indexes.

**`source_type: 'immutable_document'`:** facts written by `upsertGraph` use this value, matching `ingestDocument`'s anchor-grade semantics (the corpus heal uses to prioritize its reviews).

**Strict-mode harmonization:** out of scope (§5).

---

## Tests

Two new test files; no modifications to existing tests required.

### `packages/core/__tests__/upsertGraphContract.test.ts`

Harness: `makeWiki()` from `packages/core/__tests__/write.test.ts` (returns `{ wiki, db }`). `openTestDatabase()` from `packages/core/__tests__/helpers/sqliteAdapter.ts` provides the in-memory better-sqlite3 adapter whose `withTransactionAsync` returns `tx === adapter` — the property that makes C1 testable as a direct rollback assertion.

**C1 — participates in caller's tx:**
- `rollback after throw inside caller tx leaves graph empty`: `db.withTransactionAsync(async tx => { await wiki.upsertGraph(entityId, paramsWith1Node, tx); throw new Error('rollback'); })` rejects; assert zero rows in `entries`, `edges`, `source_ref_index` for the entity.
- `does not call withTransactionAsync internally`: wrap adapter with a call-logging proxy; assert no `BEGIN` / `COMMIT` issued during `upsertGraph`.
- `does not acquire any lock`: in parallel, `acquireImportLocks([entityId])` AND `upsertGraph(...)`. Both succeed; no `WikiBusyError`.

**C2 — no-op on unchanged scope:**
- `re-call with same (sourceRef, sourceHash) returns zeros, writes nothing`: first call writes 3 nodes + 2 edges. Second call: identical params. Assert returns zeros; row counts unchanged.
- `same sourceHash with different sourceRef throws WikiSourceRefHashCollision`: first call `sourceRef='a', hash='h`; second call `sourceRef='b', hash='h`; assert throws.

**C3 — dangling edge targets legal:**
- `edge whose targetId names a missing node is stored verbatim`: nodes=[{id:'a:sym1'}], edges=[{sourceId:'a:sym1', targetId:'b:sym_never_parsed'}]. Assert edge row exists with `target_id='b:sym_never_parsed'`.
- `traverseGraph from dangling source returns empty path through that edge`.

**C4 — strict-mode throws:**
- `out-of-manifest node type under strict mode throws WikiStrictOntologyViolation`: set manifest `mode='strict'`; `upsertGraph` with unknown type; assert throws.
- `out-of-manifest edge type under strict mode throws`: symmetric.
- `all-or-nothing — first invalid node throws, NONE written`: 3 nodes, 2nd invalid. Assert 0 rows in `entries`, `edges`, `source_ref_index`.
- `out-of-manifest type under non-strict mode silently drops (matches ingestDocument parity)`: mode='off'; facts written with `okf_type=null`; invalid edges filtered.

**`upsertGraph` integration with `commitIngest`:**
- `commitIngest embeds facts with embedding IS NULL after upsertGraph`: call `upsertGraph` (with `tx`); commit; call `commitIngest`; assert `embedded > 0` and all rows have non-null `embedding`.
- `commitIngest per-fact embedFact failures counted, do not fail the call`: mock `embedFact` to throw on second call; assert `failed: 1, embedded: 1`, no throw.
- `commitIngest searchService.sync failure propagates`: mock `sync` to throw; assert rejects.
- `commitIngest searchService.evictCache failure tolerated, evicted: false`: mock `evictCache` to throw; assert returns `evicted: false`, no throw.

### `packages/core/__tests__/listEntityIds.test.ts`

- `returns [] for empty database`.
- `returns ids sorted ascending, COLLATE BINARY`.
- `returns union across entries/tasks/events with no soft-delete filter`: seed entries/tasks/events for several entities; soft-delete all rows for one entity; assert that entity STILL appears in the result (closes the decommissioned-scope leak).
- `prefix filter scopes the result`.
- `empty-string prefix returns all ids`.
- `prefix matching nothing returns []`.

### Regression sentinels

The following must continue to pass without modification:

- `__tests__/ingestDuplicateHash.test.ts` — `upsertGraphCore` extraction must preserve `ingestDocument`'s observable behavior.
- `__tests__/integration/outbox-atomicity.test.ts` — supersession + outbox staging still atomic.
- `__tests__/integration/prune-atomicity.test.ts` — atomicity around prune operations.
- `__tests__/integration/heal-librarian-dedupe-race.test.ts` — race contract around dedupe.
- All existing callers of `validateAndNormalizeFact` / `validateInlineEdges` receive the default `strict: false`. Grep-verify at implementation time: only `IngestionService.ingestDocument` calls them today; the new `strict` parameter is opt-in.

### Vitest configuration

Default. No special ordering or setup needed.

---

## Out of Scope

- **Strict-mode harmonization for `ingestDocument` itself.** Today's `validateAndNormalizeFact` / `validateInlineEdges` silently drop invalid types regardless of mode. This spec closes that gap for `upsertGraph` only. Closing it for `ingestDocument` would surface a behavior change for existing callers and is a separate future ticket — explicitly noted here so it's not silently closed off.
- **Counts in `listEntityIds` return value.** The motivating case (§85) only needs the id list. Counts (`Array<{ entityId: string; factCount: number }>`) would require either an N+1 follow-up query or a more expensive JOIN'd aggregation. Not implemented in v1; documented as a possible v2 if the empty-namespace-skip use case becomes real.
- **Index on `entity_id` alone.** The `(entity_id, source_ref)` index does not support `entity_id`-only prefix seeks. Adding such an index is a schema change and out of scope. The O(n) `.filter()` is acceptable for v1; revisit if profiling shows it as a bottleneck.
- **`commitIngest(entityId, sourceRefs)` overload.** Considered scoping by `sourceRef` to embed only the new facts. Rejected as premature; callers needing scope can call `runReembed(entityId, { sourceRef })` after `commitIngest`.
- **New `DirectWriteService` to host `upsertGraphCore`.** Considered extracting into a new service for cleaner name separation. Rejected in favor of keeping the diff focused on `IngestionService` + `WikiMemory` + the strict-mode validator addition.
- **A new public `syncSearchIndex(entityId)` method.** `searchService.sync` is reachable only through the existing post-commit hooks inside `ingestDocument` and the new `commitIngest`. Exposing it directly is out of scope.

---

## References

- [#85](https://github.com/equationalapplications/expo-llm-wiki/issues/85) — core: no way to enumerate entity ids present in a database
- [#86](https://github.com/equationalapplications/expo-llm-wiki/issues/86) — feat(core): expose `upsertGraph` — `ingestDocument`'s deterministic tail, without extraction
- `docs/superpowers/specs/2026-08-13-graph-write-intent-design.md` (in `equationalapplications/aws-cloud-agent`, branch `spec/graph-write-intent`, §2.2 for the C1–C4 clause derivations)
- `docs/superpowers/specs/2026-08-07-source-ref-lifecycle-design.md` — sibling spec establishing `sourceRef` / `sourceHash` lifecycle primitives; this spec reuses `sourceRefIndexRepo.upsert` and `softDeleteByEntityAndSourceRef`
- `docs/superpowers/specs/2026-07-09-transaction-serialization-spec.md` — establishes `withSerializedTransactions` and the `tx === adapter` invariant that makes C1 testable
- `docs/superpowers/specs/2026-07-13-ontology-backfill-spec.md` — establishes per-entity ontology mode persistence that C4 reads
