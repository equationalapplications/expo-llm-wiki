# Spec: Atomic Multi-Entity Manifest Seeding — `WikiMemory.setOntologyManifests`

**Date:** 2026-09-02
**Status:** Implemented (2026-09-02) — branch `spec/atomic-multi-entity-manifest-seed`
**Issues:** none filed; raised from consumer review (see Consumer context)
**Packages:** `@equationalapplications/core-llm-wiki`
**Consumer context:** `equationalapplications/curated-thoughts` — spec
`2026-09-01-memory-architecture-intent-implementation-design.md` §2.2, whose
manifest-seed atomicity requirements cannot be met through the public API as it
stands at 6.2.0.

---

## Problem

A host that seeds ontology manifests for several entities at once has no way to
make that seed atomic, and no way to make it conflict-safe. Both gaps trace to
the same root: `setOntologyManifest` owns its transaction and exposes no seam.

```ts
// WikiMemory.ts (6.2.0)
async setOntologyManifest(entityId, manifest, options?): Promise<void> {
  const mode = options?.mode ?? this.ontologyService.resolveMode();
  await this.db.withTransactionAsync(tx =>
    this.metadataRepo.setManifest(entityId, { mode, manifest }, tx),
  );
  this.ontologyService.invalidateCache(entityId);
}
```

**P1 — a multi-entity seed cannot be atomic.** One transaction per call means a
host seeding N entities performs N independent transactions. A failure partway
through leaves some entities typed and others not: a partial ontology, which is
a state no consumer wants and none can distinguish from a completed seed
without re-reading every entity.

**P2 — consumers cannot supply a transaction, and must not try.** The obvious
fix — accept a `tx` parameter — is unsafe as an external contract.
`WikiMemory` wraps the adapter it is constructed with in
`withSerializedTransactions` (`db/serializedAdapter.ts`) and keeps the wrapped
handle in `private db`. A consumer therefore holds only the *unwrapped* adapter
it passed to `createWiki`. A transaction opened on that handle does not
participate in the serialization mutex, so it can interleave with the engine's
own transactions. `types.ts` further documents that the outer handle deadlocks
against the mutex from inside a transaction callback and that
`tx.withTransactionAsync` throws. Handing consumers a transaction handle
without also handing them a safe way to obtain one converts an atomicity
problem into a deadlock-and-race problem.

**P3 — writes are last-writer-wins, not create-if-absent.**
`MetadataRepository.setManifest` writes:

```sql
INSERT INTO <prefix>entity_manifests (entity_id, mode, manifest_json, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(entity_id) DO UPDATE SET
  mode = excluded.mode, manifest_json = excluded.manifest_json, updated_at = excluded.updated_at
```

That is an upsert. A host wanting "seed only if absent" must read first and
write second, which leaves a time-of-check-to-time-of-use window: two
initializers (two app windows, or startup racing a first tool call) both read
*absent*, both write, and the second silently overwrites the first. When the two
carry different ontology selections the loser's manifest is destroyed with no
diagnostic.

The motivating consumer, `curated-thoughts`, states all three properties as
requirements in its §2.2 — "one transaction for the whole seed", "conflict-safe
creation … loses the race harmlessly", "once-per-DB … never rewritten" — and
today satisfies none of them through the API. It approximates the first with a
compensating rollback that rewrites each already-written manifest back to an
empty manifest at mode `off`, and the others with a read-then-write.

---

## Solution

One new public method. One internal repository parameter. Additive: no schema
migration, no new outbox event, no breaking change to any published surface.

| Section | Surface | New / Modified |
| --- | --- | --- |
| §1 | `setOntologyManifests(entries, opts?): Promise<{ written; skipped }>` | New public method |
| §2 | Input validation and rejection rules | Behaviour of §1 |
| §3 | `opts.ifAbsent` → `ON CONFLICT DO NOTHING` | Behaviour of §1 |
| §4 | `MetadataRepository.setManifest` gains `opts.ifAbsent`, returns `boolean` | Internal (not exported) |
| §4 | `setOntologyManifest` (singular) delegates to the batch | Internal refactor; contract unchanged |

The method owns its transaction, taken on the internal serialized adapter.
Consumers pass data and never see a transaction handle — which is the whole
point of P2, and the reason a `tx` parameter was rejected.

---

## §1. `WikiMemory.setOntologyManifests`

```ts
async setOntologyManifests(
  entries: Array<{
    entityId: string;
    manifest: OntologyManifest;
    mode?: OntologyMode;
  }>,
  opts?: { ifAbsent?: boolean },
): Promise<{ written: string[]; skipped: string[] }>;
```

Writes every entry's manifest inside a **single transaction**. All succeed or
none do.

**`mode` is per entry**, not per batch, falling back to
`ontologyService.resolveMode()` exactly as the singular method does. Each
manifest is an independent statement about one entity; a batch-level mode would
couple entities that have no reason to be coupled, and costs nothing to avoid.

**Return value.** `written` names the entities whose row this call actually
wrote; `skipped` names those left untouched because a manifest was already
present (only reachable under `ifAbsent`, see §3). Both preserve input order.
With `ifAbsent` absent or false, `skipped` is always empty.

The return value exists so a caller can report what happened without re-reading.
The motivating consumer's seed outcome type is exactly
`{ seeded: string[]; skipped: string[] }`; sourcing it from the return removes
that consumer's pre-read loop entirely.

**Transaction and lock semantics.** Opens exactly one transaction on the
internal serialized adapter, and only after every check in §2 has passed. Never
accepts a transaction handle. Never opens a transaction for an empty batch.

---

## §2. Input validation and rejection rules

All checks run **before** the transaction opens, so a doomed batch never reaches
the database and never takes the serialization mutex.

| Input | Behaviour |
| --- | --- |
| `entries` is empty | Return `{ written: [], skipped: [] }`. No transaction opened. |
| Duplicate `entityId` within `entries` | Throw. Nothing written. |
| Any manifest fails `validateManifest` | Throw. Nothing written. No transaction opened. |

**Duplicates are rejected rather than resolved.** Two entries naming one entity
express ambiguous intent: silently applying the last one hides a caller bug
whose symptom — a manifest that is not the one the caller thought it wrote —
surfaces far from its cause. The error names the offending `entityId`.

**Validation runs twice, deliberately.** Once here, once inside
`MetadataRepository.setManifest`. This is not redundancy to be optimized away:
the up-front pass is the fail-fast gate that keeps a bad batch away from the
mutex, and the inner call is the invariant protecting every *other* caller of
the repository. Removing either weakens something real.

---

## §3. Conflict semantics — `opts.ifAbsent`

```ts
opts?: { ifAbsent?: boolean }   // default: false
```

**`false` (default)** — upsert. `ON CONFLICT(entity_id) DO UPDATE`. Identical
to today's behaviour, so the singular method's contract is unchanged when it
delegates (§4).

**`true`** — create-if-absent. `ON CONFLICT(entity_id) DO NOTHING`. An entity
whose manifest already exists is left exactly as it is and reported in
`skipped`. Written entities are reported in `written`.

This is what makes a seed genuinely conflict-safe. The check and the write
become one statement inside one transaction, so the TOCTOU window in P3 closes:
a concurrent initializer loses the race by writing nothing, rather than by
overwriting a manifest it never read. Neither racer errors, and both observe a
consistent final state.

**Detecting which happened.** `runAsync` returns `{ changes }`; `changes === 1`
means the row was inserted, `changes === 0` means the conflict clause fired.
This is the established idiom in this codebase —
`EdgeRepository.addIgnoreDuplicate` already classifies an insert-or-skip exactly
this way.

---

## §4. Implementation

### `MetadataRepository.setManifest`

Gains an options parameter and a return value. The repository is not exported
from `index.ts`, so this is an internal change with no published effect.

```ts
async setManifest(
  entityId: string,
  data: { mode: OntologyMode; manifest: OntologyManifest },
  tx: SQLiteAdapter,
  opts?: { ifAbsent?: boolean },
): Promise<boolean>   // true = row written, false = conflict, left alone
```

The conflict clause is selected from `opts.ifAbsent`; everything else is
unchanged, including the leading `validateManifest(data.manifest)`.

### `WikiMemory.setOntologyManifests`

```
1. if entries is empty            -> return { written: [], skipped: [] }
2. reject duplicate entityIds     -> throw, naming the id
3. validateManifest(each)         -> throw on the first failure
4. withTransactionAsync:
     for each entry:
       mode = entry.mode ?? resolveMode()
       wrote = setManifest(entry.entityId, { mode, manifest }, tx, { ifAbsent })
       record into written | skipped
5. after commit: invalidateCache(entityId) for EVERY entry
6. return { written, skipped }
```

**Invalidate every entry, including skipped ones.** A skipped entry means
another writer won the race, so this instance's cached copy may be stale;
dropping it is *more* correct than keeping it. Invalidation is also always safe
regardless of transaction outcome — it removes a cached copy, and the next read
goes to the database and observes whatever actually committed. (The hazard in
this area is cache *population* with uncommitted data, which this design never
does. `OntologyService.getEffectiveState` already declines to read or populate
the cache when given a `tx`, for the same reason.)

**Ordering.** Invalidation happens after the transaction commits, not inside it.
Both orderings are correct for the reason above, but invalidating after commit
keeps the transaction body free of instance-state mutation, so a future retry
wrapper around the transaction cannot double-apply a side effect.

### `setOntologyManifest` (singular) delegates

```ts
async setOntologyManifest(entityId, manifest, options?): Promise<void> {
  await this.setOntologyManifests([{ entityId, manifest, mode: options?.mode }]);
}
```

One code path. The singular method's observable contract is unchanged: same
signature, same upsert semantics, same cache invalidation. It gains fail-fast
validation (previously validation happened inside the transaction), which is a
strict improvement and not a behaviour anyone can depend on having been absent.

---

## Cross-cutting

**Back-compatibility.** Purely additive. `setOntologyManifest` keeps its
signature, its return type, and its semantics. No existing caller changes.

**Versioning.** Minor bump (6.2.0 → 6.3.0) through the existing release flow.
The new method appears in the generated changelog; nothing is deprecated.

**Consumer sequencing.** `curated-thoughts` cannot adopt an unpublished API, so
the order is: this PR → minor release → consumer PR. The consumer's pending
ontology-seed work stays as-is until the release lands.

**What the consumer changes on adoption.** `seedManifestsIfAbsent` collapses to
one call:

```ts
const { written, skipped } = await wiki.setOntologyManifests(
  entityIds.map(entityId => ({ entityId, manifest, mode })),
  { ifAbsent: true },
);
```

This deletes its `getOntology` pre-read loop, its compensating-rollback block,
and its local empty-manifest constant. Its never-throws contract is preserved by
catching and reporting failure; it no longer has to *undo* anything, because the
engine rolled back.

**A caveat the consumer must record.** That consumer seeds its two fixed tiers
during startup and its workspace tier later, once the workspace id resolves —
the id does not exist at startup. So it makes **two** atomic calls, not one. Per
call the guarantee is complete; the phrase "one transaction for the whole seed"
in its §2.2 needs amending to say so. Failure isolation is unaffected.

---

## Tests

`packages/core/__tests__/`, following the harness in
`repositories/MetadataRepository.manifest.test.ts` (`openTestDatabase` +
`setupDatabase`), which gives real SQLite transactions rather than mocks.

**The atomicity test needs care.** An invalid manifest will not exercise
rollback, because §2 validation means the transaction never opens. A genuine
test must fail *inside* the transaction after at least one successful write —
wrap the test adapter so the second `runAsync` throws — and then assert **zero**
manifests exist, not one.

| # | Test | Pins |
| --- | --- | --- |
| 1 | Batch writes every entry; each round-trips via `getManifest` | Basic contract |
| 2 | Injected failure on the second write leaves **zero** manifests | Atomicity (P1) |
| 3 | Invalid manifest → throws, `withTransactionAsync` never called, no rows | Fail-fast before the mutex (§2) |
| 4 | Duplicate `entityId` → throws before any database contact | Ambiguous intent rejected (§2) |
| 5 | Empty array → no transaction opened, returns empty lists | No-op (§2) |
| 6 | `ifAbsent`: existing manifest untouched and reported in `skipped`; absent one in `written` | Create-if-absent (§3) |
| 7 | Two concurrent batches converge on one manifest set; neither errors | Conflict-safety through the mutex (P3) |
| 8 | Default (no `ifAbsent`) still overwrites an existing manifest | Today's behaviour preserved |
| 9 | A value cached before the batch reads back new afterwards | Invalidation fires (§4) |
| 10 | `setOntologyManifest` singular behaves identically, including mode default | Back-compat after delegation (§4) |

---

## Out of Scope

**A public transaction runner on `WikiMemory`.** Considered and rejected. It
would let consumers compose multi-step atomic operations, but it exposes the
nested-transaction footgun (`tx.withTransactionAsync` throws) and the
outer-handle deadlock to every consumer, in exchange for flexibility no current
consumer has asked for. If a consumer later needs to make a manifest write
atomic with an unrelated operation, this decision can be revisited without
breaking the batch API.

**An engine-side API for clearing typed classifications.** The motivating
consumer also switches ontologies, which requires nulling `okf_type` across
entries and tasks and deleting manifest-derived edges before reseeding. It does
this today with raw SQL against a hardcoded `llm_wiki_` prefix, because
`runOntologyBackfill` is additive-only and no clear API exists. That is a real
gap and the same species of complaint as this spec, but it is not solvable by
the same mechanism: the switch path interleaves an unbounded LLM-driven backfill
loop between the clear and the reseed, and holding a write lock across LLM calls
would block every other engine operation through the serialization mutex. It
needs its own design.

**Retrofitting `upsertGraph`'s transaction contract.** `upsertGraph(entityId,
params, adapter)` requires the caller to supply the adapter it participates in —
the same shape this spec rejects in P2. That was a deliberate requirement of its
motivating consumer (a single-writer Lambda with its own transaction scope), so
it is not presumptively wrong; but the safety analysis in P2 applies to any
consumer holding only the unwrapped adapter, and the two contracts now differ.
Worth a look, separately.

**Issue [#86](https://github.com/equationalapplications/expo-llm-wiki/issues/86)
(`expose upsertGraph`).** Related by root cause — engine capability reachable
only from inside a method consumers do not call — but a different subsystem with
a different risk profile. Cross-referenced, not bundled.

---

## References

- Consumer spec: `curated-thoughts` →
  `docs/superpowers/specs/2026-09-01-memory-architecture-intent-implementation-design.md` §2.2
- `packages/core/src/WikiMemory.ts` — `setOntologyManifest` (the method being extended)
- `packages/core/src/repositories/MetadataRepository.ts` — `setManifest` (the upsert in P3)
- `packages/core/src/services/OntologyService.ts` — `getEffectiveState` (the cache/`tx` convention §4 follows)
- `packages/core/src/repositories/EdgeRepository.ts` — `addIgnoreDuplicate` (the `changes`-based insert-or-skip idiom §3 reuses)
- `packages/core/src/types.ts` — `SQLiteAdapter.withTransactionAsync` (the nested-transaction and outer-handle contract behind P2)
- `packages/core/src/db/serializedAdapter.ts` — `withSerializedTransactions` (the mutex behind P2), applied in `WikiMemory`'s constructor at `WikiMemory.ts:88`
- `docs/superpowers/specs/2026-07-09-transaction-serialization-spec.md` — the canonical design for that mutex
- Prior art for house style: `docs/superpowers/specs/2026-08-14-wikimemory-public-api-extensions-design.md`
