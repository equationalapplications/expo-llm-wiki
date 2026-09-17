# Graph Write Entity Isolation

**Date:** 2026-09-17

**Status:** Design approved in conversation; specification recorded for review; implementation not started

**Status revision 2026-09-17-b:** Specification reviewed against the source baseline. Design decision unchanged and still approved. Nine review findings folded in: the shared `upsertGraphCore` call path and its effect on `ingestDocument` (§3, §6, test 16); a deterministic suppression detector replacing reliance on `changes` alone (§4, tests 13–14); the foreign edge-ID residual, resolved as documented-and-accepted rather than widened scope (§3, §6, test 10); REQ-DAO-01's rationale narrowed from repository-wide to `upsert` (§4); verified confirmation that cross-entity dangling edges do not leak (§6); the import path's differing disclosure posture (§5); both runtime export sites (§5, test 17); the ownership lookup's zero added cost (§4); and the active-only source-hash probe (§3, test 8). Test count 15 → 17; the repository list renumbered accordingly. No requirement was weakened and the approved decision in §1 is unchanged. Implementation remains not started.

**Status revision 2026-09-17-c:** Second review round, against revision -b. Design decision still unchanged. Four corrections: the suppression detector's adapter contract is now stated rather than assumed, resolving a gap where an over-reporting adapter could report success for a write it did not perform (§4, test 14); the zero-write preflight guarantee is scoped to `upsertGraph`, because full document ingestion persists ontology state before reaching `upsertGraphCore` (§3); an inaccurate claim that an ownership predicate would break import is replaced with the actual reason import stays out of scope (§4); and §8's premature assertion that revision -b had been committed is corrected (§8). Revisions -b and -c are committed together as one spec-only commit.

**Status revision 2026-09-17-d:** Plan review clarified the affected-row contract (§4, test 14). Accurate counts remain mandatory for adapters; a permitted write reported as zero violates that contract. `upsert`'s ownership re-read is local defensive behavior, not permission for adapter under-reporting. The implementation plan also separates ontology-valid preservation tests from ontology-precedence tests and replaces its unsafe stash mutation recipe with an intact-file backup and byte-exact restoration. Historical statuses remain unchanged; implementation has not started.
**Status revision 2026-09-17-e:** Implementation complete on this branch. Commit `1aa087c` lands the code change; this revision is recorded separately as the spec closure. Verification (all run from `dev/graph-entity-isolation` at `1aa087c`):
- `pnpm --filter @equationalapplications/core-llm-wiki build` -- clean.
- `pnpm --filter @equationalapplications/core-llm-wiki typecheck` -- clean.
- `pnpm --filter @equationalapplications/core-llm-wiki test` -- 1,317/1,317 across 103 files (targeted full-core regression; no skips).
- `pnpm --filter @equationalapplications/expo-llm-wiki test` -- 12/12.
- `git diff --check` -- clean.
- New suites asserted green: `__tests__/graphOwnershipExports.test.ts` (2), `__tests__/graphOwnership.test.ts` (15 real-SQLite repo/preflight tests), `__tests__/graphOwnershipIngest.test.ts` (3 routing + rollback), `__tests__/adapterContract.test.ts` (integration + Expo driver forwarding), `__tests__/ingest.test.ts` (1 spec contract assertion, no behavior change).
- Pre-merge CI deltas: README `withTransactionAsync` example signatures corrected so host callbacks receive the active `tx` handle (interface at line 1145 plus sql.js / better-sqlite3 example impls at lines 1189 and 1218 -- previously declared `fn: () => Promise<T>` which would silently drop the host into writing on the outer connection); `WikiGraphNodeOwnershipConflict` constructor carries an explicit privacy-preserving JSDoc; the 5 functions touched by the diff (`WikiMemory.ingestDocument`, `EntryRepository.upsert`, `IngestionService.upsertGraphCore`, `IngestionService.assertGraphNodeOwnership`, the new error class) now have complete JSDoc satisfying the 80% docstring-coverage threshold.
Historical statuses -a through -d remain unchanged; they describe the design as approved before implementation, which is the record. This revision is the closure: design approved, implementation complete, verification recorded.


**Branch:** `dev/graph-entity-isolation`

**Target PR:** `main`, after implementation on this same branch

**Source baseline:** `2e7d9bacbf1f5128a3021a48b1f138f44c7c057f` (core 7.1.1)

## 1. Decision and scope

Reject an entire `upsertGraph` write when any incoming node ID already belongs to another entity. Check ownership before persistent mutation, retain existing same-entity update semantics, and enforce the ownership invariant again at the repository write boundary. Do not silently skip nodes or rewrite their IDs.

This is a focused correction to the existing TypeScript core. It introduces no database migration, composite primary key, native engine dependency, or new authentication layer. The specification is committed first; code and regression tests follow on the same branch in a separate implementation commit. Do not open a spec-only PR or implement as part of this documentation task.

### Security model

Hosts remain responsible for authentication and choosing the authorized `entityId`. The affected supported deployment is a shared database containing multiple entities, where host code derives caller-supplied graph node IDs from externally influenced structured data. Deterministic IDs can collide without guessing random UUIDs. An authorized write to one entity must not overwrite, move, or expose retained metadata from another entity's fact.

This is not an assertion of unauthenticated remote access. Hosts using separate databases or guaranteed globally unique, entity-bound IDs avoid the adversarial precondition. Direct access to the database adapter is outside the data-level boundary this change protects.

### Verified baseline

- `packages/core/src/WikiMemory.ts`, `upsertGraph`: accepts caller-supplied node IDs and performs an entity-scoped source-hash check before forwarding to `upsertGraphCore`. That probe is `SourceRefIndexRepository.findActiveByEntityAndHash` — it considers **live references only**, so a soft-deleted source-ref mapping triggers neither the no-op nor the collision path.
- `packages/core/src/services/IngestionService.ts`, `upsertGraphCore`: constructs facts using the incoming node ID and requested entity, then calls `EntryRepository.upsert`. Ontology resolution precedes source supersession and can persist seeded manifest metadata.
- `packages/core/src/services/IngestionService.ts`: `upsertGraphCore` is **not exclusive to `upsertGraph`**. `ingestDocument`'s full path reaches it through `runFullUpsertGraph`, and `ingestDocument`'s partial path calls `EntryRepository.upsert` directly through `appendPartialFacts`. Both generate IDs with `generateId()`. See §3 "Shared call path".
- `packages/core/src/repositories/EntryRepository.ts`, `upsert`: looks up an existing row globally by ID and uses `ON CONFLICT(id) DO UPDATE SET entity_id = excluded.entity_id`. Its update preserves existing OKF metadata and includes that metadata in an outbox payload under the incoming entity. The existing pre-write lookup already selects by ID alone; it simply omits `entity_id` from its column list.
- `packages/core/src/repositories/EdgeRepository.ts`, `addIgnoreDuplicate`: writes with `INSERT OR IGNORE` and, on a suppressed insert, compares the stored `(entity_id, source_id, target_id, edge_type)` tuple and throws a bare `Error` when it differs. Edges therefore never overwrite a foreign row, but the throw happens after node writes. See §3 "Foreign edge IDs".
- `packages/core/src/repositories/EdgeRepository.ts`, graph traversal: the recursive walk scopes the edge join (`e.entity_id = ?`), the neighbor-node join (`n.entity_id = ?`), and the neighborhood edge fetch (`WHERE e.entity_id = ?`). Reads are entity-scoped; see §6.
- `packages/core/src/db/serializedAdapter.ts`: the transaction wrapper converts an escaping error into `WikiTransactionError` **only** when `extractSqliteCode` matches. A plain `Error` subclass passes through with `instanceof` intact, so REQ-ERROR-01's propagation requirement is already satisfied by existing machinery rather than being new work.
- `packages/core/src/types.ts`, `SQLiteAdapter`: `runAsync` is typed to return `{ changes, lastInsertRowId }`, but the interface does not promise SQLite's exact `sqlite3_changes()` semantics, and hosts supply their own implementations. The two in-tree adapters (`packages/expo/src/adapter.ts`, `packages/integration/helpers/db.ts`) pass their driver's real value through.
- `packages/core/src/services/ImportExportService.ts`: the separate import path checks foreign ownership and skips conflicting entries, warning through `_warnCrossEntityCollision`, which logs the foreign `entity_id` and record ID. That existing policy is not the desired policy for graph writes and is not changed here; see §5 for why the two paths differ.

## 2. Ownership contract [REQ-OWN-01]

An entry ID remains owned by its existing entity for as long as that row exists. This applies to active and soft-deleted rows. Soft deletion does not release an ID for another entity. A physically absent row may be inserted under the requested entity; permanent historical reservation is not introduced.

For an incoming graph node:

| Existing entry | Required outcome |
|---|---|
| No row with that ID | Preserve normal insertion behavior. |
| Row belongs to the requested entity | Preserve normal update behavior, including existing resurrection and metadata-preservation semantics. |
| Row belongs to a different entity, active or soft-deleted | Reject the entire graph write with the error in REQ-ERROR-01. |

Check every distinct incoming node ID, including nodes later in a mixed valid/conflicting batch. Duplicate IDs within the incoming batch retain baseline processing semantics; this change neither rejects nor renames them. Ownership lookup deduplication must not change write ordering or success counts.

IDs remain opaque strings under the existing API. Do not introduce UUID validation, entity-prefix requirements, truncation, normalization, or automatic ID rewriting. Hosts can adopt entity-qualified deterministic IDs independently, but the database boundary must remain safe without relying on that convention.

## 3. Graph preflight and transaction boundary [REQ-GRAPH-01]

### Ordering

Retain the existing facade behavior:

1. Normalize and validate `sourceRef` and `sourceHash` as today.
2. Perform the existing entity-scoped source-hash probe through the supplied adapter. This probe matches **live source references only**; a soft-deleted mapping is invisible to it and falls through to step 5 as a normal write.
3. If the existing mapping is the identical `(entityId, sourceHash, sourceRef)`, return the existing zero-count no-op. Incoming nodes are not processed or ownership-checked on this path; no mutation occurs.
4. If the hash belongs to another source reference within the requested entity, preserve `WikiSourceRefHashCollision` precedence and behavior.
5. Otherwise enter `upsertGraphCore` and perform the complete node-ownership preflight **before ontology resolution or any persistent mutation**.
6. Only after ownership succeeds, continue the existing ontology validation, source supersession, source-index updates, node writes, and edge writes.

The placement before ontology resolution is mandatory: resolving a configured seed manifest can itself persist metadata. A rejected ownership preflight must not leave a seeded manifest behind.

### Shared call path

`upsertGraphCore` is shared. Placing the preflight inside it, as step 5 requires, also places it on `ingestDocument`'s full path, which reaches `upsertGraphCore` through `runFullUpsertGraph`. `ingestDocument`'s partial path does not go through `upsertGraphCore` at all — `appendPartialFacts` calls `EntryRepository.upsert` directly — and therefore inherits REQ-DAO-01 instead. This is intended, not incidental: both layers should apply to both paths.

The practical risk is near zero, because both ingestion paths mint IDs with `generateId()` rather than accepting caller-supplied ones, so a foreign collision requires a random-ID collision. The contract consequence is real regardless and must be stated rather than discovered:

- `ingestDocument` may now throw `WikiGraphNodeOwnershipConflict`. This is a public API change for `ingestDocument`, not only for `upsertGraph`, and is listed as such in §6.
- Propagation already behaves correctly. `ingestDocument`'s catch block translates only `SQLITE_CONSTRAINT_UNIQUE` into duplicate-hash handling and rethrows everything else unmodified, so the new domain error surfaces to the caller intact. Do not add it to that translation branch.
- Implement the preflight as a single helper invoked by `upsertGraphCore`, not as duplicated logic per caller. Do not add a bypass flag or an opts escape hatch that lets a caller skip it.

**The zero-write guarantee is scoped to `upsertGraph`.** Sharing the enforcement does not mean sharing the "no persistent writes before rejection" property, because `ingestDocument`'s full path already persists ontology state *before* it reaches `upsertGraphCore`: `runFullUpsertGraph` calls `getEffectiveState(entityId, tx)`, which persists a configured seed manifest on first access when a tx is supplied, and then calls `mergeEmergentUpdates(entityId, ontology_updates, tx)` inside its per-chunk loop under `emergent` mode. Both are real writes, and both precede the preflight no matter where inside `upsertGraphCore` it sits.

What each path gets is therefore:

| Path | Ownership enforcement | No writes before rejection |
|---|---|---|
| `upsertGraph` | Preflight + REQ-DAO-01 | Yes — the guarantee in "Atomicity and host obligations" below |
| `ingestDocument`, full path | Preflight + REQ-DAO-01 | No — ontology state may already be persisted; relies on host transaction rollback |
| `ingestDocument`, partial path | REQ-DAO-01 only | No — no preflight on this path at all |

This is a limit on what the preflight can promise for a caller that writes before invoking it, not a defect to fix here. Do not restate §3's zero-mutation language as an `ingestDocument` property, and do not attempt to make it true by relocating ontology resolution: that ordering exists so emergent updates are merged before facts are validated against the manifest, and moving it is a behavior change outside this scope. Test 3 asserts the guarantee against `upsertGraph` and must stay scoped that way.

### Foreign edge IDs

The zero-mutation guarantee in this section covers **node IDs only**. Caller-supplied edge IDs keep their existing late-throw behavior: `EdgeRepository.addIgnoreDuplicate` writes with `INSERT OR IGNORE` and raises a bare `Error` when a stored row with the same ID carries a different `(entity_id, source_id, target_id, edge_type)` tuple, which includes the foreign-entity case. That throw occurs in the edge-write step, after node writes have already run.

Consequences, accepted deliberately:

- **Confidentiality holds.** `INSERT OR IGNORE` never overwrites or reassigns the foreign edge row, so the isolation property this change exists to protect is not violated through edge IDs.
- **Atomicity does not hold for this case.** A batch that passes node preflight and then collides on a foreign edge ID leaves the node writes to be undone by the host's transaction rollback, exactly as any other late failure is. It is not a preflight rejection and must not be described as one.
- **The error shape is inconsistent** with REQ-ERROR-01: it is a bare `Error` and its message contains the caller's own edge ID.

Extending the preflight to edge IDs and promoting that error to a domain type would close both gaps, but §6 explicitly excludes edge-ID collision policy from this change, and widening scope to chase a case with no confidentiality impact contradicts §1. The residual is therefore documented and accepted here rather than fixed. Revisit it as separate work if caller-supplied edge IDs become a supported deterministic-ID surface.

### Lookup

Implement the preflight through the repository abstraction, using the supplied transaction adapter. Reuse `findExistingMetadataByIds` if appropriate; it already returns existing owners and chunks IDs. Do not add raw entry-table SQL to the service or perform the check through `this.db` outside the supplied transaction. Include soft-deleted rows and respect the repository's existing bind-variable batching convention.

Once any foreign owner is found, throw the generic ownership error. Never return partial counts or skip the conflicting node and continue. Do not use the import path's warning helper: that helper has different skip semantics and includes foreign-entity information.

### Atomicity and host obligations

Preserve the existing caller-owned transaction contract. `upsertGraph` does not acquire a new lock, start a nested transaction, commit, or roll back the caller's transaction. Hosts must provide the appropriate transaction adapter and propagate operation failures so their transaction wrapper rolls back partial work from failures occurring after preflight.

For a foreign **node**-owner collision visible during preflight, this operation performs **zero persistent mutations**, even if the host catches that particular error within its transaction. Preexisting writes performed by the host before calling `upsertGraph` are not this operation's writes and must not be undone by the method itself. A foreign **edge**-ID collision is not covered by that guarantee and depends on host rollback; see "Foreign edge IDs" above.

Do not claim that a sequence of statements on an arbitrary nontransactional adapter is atomic. A late repository rejection or SQLite transaction/concurrency error must propagate rather than be converted to a successful partial result. Under a correctly managed caller transaction, all writes by a failed graph operation roll back. The conditional repository write in REQ-DAO-01 prevents a foreign-row overwrite even if ownership changes between checks; it does not replace host transaction management.

## 4. Repository write invariant [REQ-DAO-01]

Enforce ownership within `EntryRepository.upsert`, independently of the graph preflight. No caller of **`upsert`** may overwrite or reassign a foreign entry by omitting the service-level check.

Scope that sentence to `upsert` and do not read it as a repository-wide invariant. `upsertForImport` retains `entity_id = excluded.entity_id` and remains safe only because `ImportExportService` performs its own ownership check before calling it. That asymmetry is deliberate and out of scope here (see below), but it means "the repository is safe for all callers" would be an overstatement of what this change delivers.

Required behavior:

- Add `entity_id` to the **existing** pre-write lookup and reject a known foreign owner before writing or constructing an outbox event. This is not a new query: `upsert` already runs a by-ID `SELECT` to classify the operation and to read OKF metadata for the outbox payload, and that statement simply omits `entity_id` from its column list today. The check costs one additional column, not one additional round trip.
- Make the SQL conflict update conditional on the existing and incoming entity IDs matching. Do not change ownership on an update.
- A foreign-owner conflict must not update **any** column, including content, timestamps, deletion state, embeddings, provenance, or verification metadata.
- Detect a conflict update suppressed by the ownership condition and throw the same domain error. Do not return success or publish an outbox event for a suppressed write. Detection rests on the adapter contract stated immediately below, plus one disambiguating read: treat `result.changes === 0` as a *trigger*, not as proof, then re-read `entity_id` for that ID inside the same transaction and throw only when the stored owner differs from the incoming entity. That read runs only on the suspicious path, reuses the lookup shape already added above, and also closes the window where ownership changes between the early check and the write.
- Emit an outbox event only after a permitted insert/update is known to have succeeded. Preserve existing insert/update/delete operation classification and metadata payload behavior for permitted writes.
- Do not turn unrelated SQL errors into ownership errors or suppress them.

### Adapter contract for affected-row counts

Adapters MUST report accurate `runAsync().changes` counts, matching SQLite's affected-row semantics. A permitted update counts the row even when every assigned value is identical to the stored value. Document this obligation on `SQLiteAdapter.runAsync`; do not license under-reporting on the shared interface.

- **Required for suppression detection:** an adapter MUST report `changes: 0` when an `INSERT … ON CONFLICT DO UPDATE` is suppressed by the conflict clause's `WHERE`, and MUST NOT report a nonzero count for a suppressed write. The same zero-count obligation applies to a suppressed `INSERT OR IGNORE`. Without this, the repository could return success and publish an outbox event for a write it did not perform — violating the bullet above. The conditional SQL still protects the foreign row in that case, so the defect is misreported success, not disclosure; it is a correctness bug regardless.
- **Local defensive behavior, not an adapter allowance:** if an adapter violates the contract by reporting a permitted write as `changes: 0`, `upsert` re-reads ownership and throws only for a foreign owner. This avoids compounding under-reporting with a spurious ownership error. Explain this defense at the repository call site; it does not make an under-reporting adapter supported or its returned count accurate.

This makes an existing, load-bearing dependency explicit. `EdgeRepository.addIgnoreDuplicate` uses the count for insertion success and `upsertGraph`'s public `edgesWritten`; metadata compare-and-set, soft-delete success reporting, and maintenance sweep counts also depend on accurate values. Both over-reporting and under-reporting can corrupt those results. The ownership detector needs the suppressed-write direction specifically, but that narrower dependency does not weaken the shared adapter contract.

Do not resolve this by verifying ownership unconditionally after every write. `upsert` runs once per node in the graph write loop and once per fact during ingestion, so an unconditional post-write `SELECT` doubles statements on the hot write path to defend against a failure mode that only misreports an outcome the conditional SQL has already made safe.

**Removing `entity_id` from the SET clause alone is insufficient:** it would still allow another entity's title, body, and other fields to be overwritten. The conflict update must have an owner-matching condition in addition to any early check.

The graph preflight supplies whole-batch rejection before side effects; the repository guard supplies per-write safety for every `upsert` caller. Neither replaces the other. Existing document ingestion, librarian, and maintenance callers of `upsert` remain subject to this invariant, even though they mint IDs with `generateId()` and therefore never expect to trip it. They must propagate an unexpected ownership failure rather than treat it as an item to skip. `appendPartialFacts` is one such caller and is the only route by which `ingestDocument`'s partial path acquires ownership enforcement — see §3 "Shared call path".

`upsertForImport` and the separate import collision policy are outside this change. Do not broaden this fix into an import behavior rewrite.

The reason is scope, not hazard. `upsertForImport` has exactly one production caller, `ImportExportService`, and that call sits downstream of the service's own `existing.entity_id !== entityId` skip, so an owner-matching predicate added there would be unreachable in the current flow — dead code rather than a break. Import's always-replace SQL and its service-level skip are a matched pair that should be revisited together, with its warning content (§5) and its skip-versus-reject policy, if they are revisited at all. Doing half of that here would add an unexercised branch to a path this change does not test.

## 5. Error and information disclosure [REQ-ERROR-01]

Add a public domain error following the existing classes in `packages/core/src/types.ts`:

- Class/name: `WikiGraphNodeOwnershipConflict`
- Stable code: `WIKI_GRAPH_NODE_OWNERSHIP_CONFLICT`
- Message: `Graph write rejected because a node ID is unavailable for this entity.`
- No required constructor arguments and no custom data fields other than the stable code.

The shape matches house convention already established by `WikiStrictOntologyViolation` and `WikiSourceRefHashCollision` in the same file: a `readonly code = '...' as const` field and an explicitly assigned `this.name`. Those classes also carry `entityId` and other context in their messages; this one deliberately does not, for the reasons below.

Use this error for both graph preflight and repository ownership rejection. Export the runtime class through **both** existing export sites, not one:

- `packages/core/src/index.ts` re-exports `* from './types'`, so a class declared in `types.ts` becomes a public runtime export automatically.
- `packages/core/src/WikiMemory.ts` separately maintains a curated named re-export list of domain errors. Consumers importing from that module do not see anything absent from that list, so the new class must be added to it explicitly.

Tests must verify the public runtime export from both entrypoints, not just a TypeScript type export.

Do not attach the foreign entity ID, conflicting node ID, source reference, source hash, stored content, provenance, verification information, database row, SQL parameters, or underlying row as `cause`. Do not log or warn with these values on the new rejection paths. Both message and enumerable error properties must remain free of stored foreign data. Standard `Error` stack behavior remains unchanged; stack sanitization at remote API boundaries belongs to the host.

A rejection necessarily indicates that some supplied ID is unavailable. This spec does not promise to hide ID occupancy or eliminate an existence oracle. It does promise not to disclose the foreign owner or record details, and not to identify which node in a batch conflicted.

### Why the import path differs

`ImportExportService._warnCrossEntityCollision` console-warns the foreign `entity_id` alongside the record ID — precisely what this section forbids on the graph path — and §6 preserves that behavior unchanged. The two paths are not in disagreement about whether an owner ID is sensitive; they have different callers:

- `importDump` is a host-driven administrative operation over a bundle the host already possesses, run by an operator who is entitled to see why rows were skipped. The warning is a diagnostic for that operator, on a path that skips rather than fails.
- `upsertGraph` is a host-facing write API whose node IDs may be derived from externally influenced data. Its rejection is reachable by whatever supplies that data, so its error and its logging must not become a channel for reading another entity's identifiers.

Anyone changing either path should preserve this distinction rather than harmonizing the two by reflex. Narrowing the import warning is legitimate separate work; it is not part of this change.

### Propagation

The error must propagate as a domain error through existing transaction wrappers. Do not convert it into `WikiTransactionError`, swallow it, or expose a lower-level database error for the normal ownership-rejection case.

This requirement is satisfied by machinery that already exists and requires no new code: the serialized transaction wrapper converts an escaping error into `WikiTransactionError` only when `extractSqliteCode` recognizes it as a driver error, and passes everything else through with `instanceof` intact. `extractSqliteCode` matches exactly two shapes — a string `code` beginning with `SQLITE_`, or a `message` beginning with `Error code <n>:`. The `WIKI_`-prefixed code and the fixed message specified above match neither, so the class passes through unwrapped by construction.

Implementation must therefore avoid *breaking* that property rather than build new machinery for it: keep the `WIKI_` code prefix, keep the message from starting with `Error code <n>:`, and do not attach a driver error as `cause`. The last of those is also required on disclosure grounds above, and test 6 covers it from that side.

## 6. Preservation and non-goals [REQ-COMPAT-01]

Preserve:

- Public `upsertGraph(entityId, params, adapter)` parameter and success-result shapes.
- Source-reference/hash validation, existing source-hash collision errors, and exact-hash no-op behavior.
- Same-entity node updates, metadata retention, source supersession, edge handling, and success counts.
- Ontology off/lenient/strict behavior after ownership preflight succeeds.
- Empty-node graph operations and caller-owned transaction behavior.
- Existing import skip policy and unrelated warnings, including `_warnCrossEntityCollision`'s current message content (§5).

### Intended behavior changes

These are the only intended deviations from current behavior. Anything else is a regression:

- `upsertGraph` throws `WikiGraphNodeOwnershipConflict` for a foreign node ID instead of overwriting or reassigning the row.
- `EntryRepository.upsert` throws the same error for a foreign-owned ID, for every caller.
- **`ingestDocument` may throw `WikiGraphNodeOwnershipConflict`.** It shares `upsertGraphCore` on its full path and `EntryRepository.upsert` on its partial path (§3 "Shared call path"), so the enforcement reaches it too. Both paths mint IDs with `generateId()`, making this unreachable in practice, but it is a public contract change for a second method and must be documented as one rather than left implicit.

No schema migration or composite-key redesign is required. Do not modify edge-ID collision policy, dangling-edge semantics, tenant authorization, global export APIs, native GraphRAG work, release workflow PR selection, or unrelated logging. Do not retroactively infer original owners or repair previously reassigned rows: reliable ownership history is not established by this change.

### Why dangling-edge semantics can stay excluded

Excluding dangling edges is safe, and the reason is verifiable rather than assumed. An entity-A edge may reference a node ID owned by entity B, but that reference cannot surface B's content: the recursive traversal scopes the edge join with `e.entity_id = ?`, scopes the neighbor-node join with `n.entity_id = ?`, and the follow-up neighborhood edge fetch filters `WHERE e.entity_id = ?`. A cross-entity target is simply an unresolvable ID in A's graph. Reconfirm this if traversal or any other graph read is ever rewritten to join entries globally, because that rewrite — not this change — is what would turn a dangling edge into a disclosure path.

Foreign **edge**-ID collisions are likewise excluded, with a residual that §3 "Foreign edge IDs" states in full: confidentiality holds because `INSERT OR IGNORE` never overwrites the foreign row, but the resulting throw is late, untyped, and relies on host rollback rather than preflight.

The new error is an intentional behavior correction for foreign-ID writes, not permission to rename valid same-entity IDs. Document it in the core README's Direct Graph Write section, including host transaction obligations, the globally shared entry-ID namespace, and the fact that `ingestDocument` shares the same enforcement.

## 7. Acceptance tests [REQ-TEST-01]

Use the repository's existing test conventions and real SQLite integration coverage for persistence assertions. Mocks alone cannot establish SQL ownership isolation or rollback. No tests are executed as part of committing this spec.

### Graph operation

1. **Mixed batch, late conflict:** seed entity B with an existing deterministic-ID fact. Submit an entity-A batch containing valid new/update nodes followed by the colliding node and edges. Assert the typed error and no partial success.
2. **Full state preservation:** seed entity A with an existing source graph that would otherwise be superseded, plus source-index rows and outbox state. Seed entity B with distinct metadata, embeddings, and timestamps. After rejection, compare pre/post state for entries in both entities, edges, source-reference indexes, ontology/entity metadata, and outbox rows. Existing outbox rows must remain unchanged; no new ones may appear.
3. **Seed-manifest side effect:** configure a not-yet-persisted seed manifest for entity A. On ownership rejection, assert the manifest was not persisted. Exercise the rejection caught inside a caller-owned transaction that then commits, proving preflight itself performed no persistent writes rather than merely relying on rollback. Drive this through `upsertGraph` only: per §3 "Shared call path", `ingestDocument` persists ontology state before reaching the preflight, so the same assertion against an ingest run would fail for reasons unrelated to ownership.
4. **Soft-deleted foreign owner:** repeat with a soft-deleted entity-B row; it remains reserved and unchanged.
5. **Batching:** place a foreign owner beyond the first ownership-lookup batch. Assert whole-call rejection and no partial writes.
6. **Error privacy:** assert exact name/code/message, public `instanceof` behavior, and absence of foreign owner, node ID, content, and metadata from the error's custom fields/serialization and new-path console output. Assert no attached cause.
7. **Compatibility:** cover fresh inserts, same-entity updates, existing same-entity resurrection behavior, preserved metadata/outbox payloads, empty nodes, and repeated incoming node IDs. Preserve baseline counts and edge behavior.
8. **Existing early returns:** unchanged source-hash no-op returns zero counts even if incoming nodes would collide; a different-source-reference hash collision keeps its existing error precedence. Neither path mutates state. Seed the probe fixtures with **live** source-ref index rows: the probe matches active references only, so a soft-deleted mapping does not produce the no-op or the collision and instead falls through to the normal write path. A test that seeds a soft-deleted ref and expects an early return is asserting behavior the code has never had.
9. **Ontology ordering:** when both ownership and ontology violations are present on a non-no-op write, ownership rejection wins without seeding metadata. For ownership-valid data, existing strict ontology behavior remains unchanged.
10. **Foreign edge-ID residual:** submit a batch whose nodes all pass ownership but whose caller-supplied edge ID is held by another entity. Assert the existing bare `Error` still surfaces, that the foreign edge row is byte-identical afterward, and that the node writes from the same call are undone by the caller's rollback rather than by preflight. This test pins the accepted residual in §3 so a later change cannot quietly alter it in either direction.

### Repository and transactions

11. **Direct repository rejection:** call `EntryRepository.upsert` with a foreign-owned ID, including a soft-deleted row. Assert no field changes, no outbox event, and the same typed error without relying on `upsertGraphCore`.
12. **Conditional-write backstop:** exercise the SQL owner predicate separately from the early lookup, using a controlled test seam or direct real-SQL repository fixture. Demonstrate that a mismatched owner suppresses all column updates and that the repository recognizes suppression without emitting an event. Do not use timing sleeps or present a mock as proof of SQL behavior.
13. **Allowed same-entity update:** include a logically unchanged same-entity update and assert it succeeds, updates normally, and emits its outbox event. This is the false-positive guard for the suppression detector in REQ-DAO-01.
14. **Suppression detector under an under-reporting adapter:** drive the detector with an adapter whose `runAsync` reports `changes: 0` for every statement while the underlying SQL executes normally. A permitted same-entity write must still succeed and emit its event — proving the implementation disambiguates by re-reading the stored owner rather than trusting the reported count — while a genuinely foreign-owned ID still throws. An implementation that treats `changes === 0` as proof of suppression fails this test, which is the point of it. This deliberately contract-violating adapter tests only `upsert`'s local defensive behavior; it does not establish support for under-reporting adapters. Accurate counts remain required by §4. Assert zero for a suppressed write and a nonzero count for a permitted value-identical update through the in-tree adapters, clearly distinguishing real SQLite execution from mocked driver-result forwarding. Those checks cannot establish compliance for an arbitrary host adapter; state that limit rather than implying broader coverage.
15. **Failure propagation/rollback:** inject a late domain failure after earlier valid mutations in a caller-managed transaction. Assert that propagating the failure rolls back the operation, with no committed outbox records. Also verify that preflight rejection does not itself end a caller-owned transaction or undo unrelated prior host work when caught.
16. **Shared-caller regression:** run existing document-ingestion, librarian/maintenance, import, ontology, and outbox tests impacted by the repository change. Existing import conflict handling must retain its current policy. Add explicit coverage for the shared call path in §3: an `ingestDocument` run whose extracted facts are forced onto a foreign-owned ID must surface `WikiGraphNodeOwnershipConflict` to the caller unmodified — not a duplicate-hash result, not a partial success — on both the full path and the partial path, confirming that the catch block's `SQLITE_CONSTRAINT_UNIQUE` translation does not intercept it.
17. **Public API checks:** typecheck/build relevant packages and verify that the error is available as a runtime export from both entrypoints named in REQ-ERROR-01 — the `types` re-export through `index.ts` and the curated list in `WikiMemory.ts` — using runtime `instanceof` and value imports, not type-only imports.

Record actual commands and outcomes with implementation; do not describe unrun tests as passing. Cross-connection scheduling tests are optional unless needed to validate the chosen implementation, but the SQL predicate and transaction contract are mandatory acceptance criteria.

## 8. Delivery and review

1. Commit this approved design on `dev/graph-entity-isolation`; retain the native GraphRAG spec on its separate branch. *(Done: `6d2925a`.)*
2. Have the user review the written specification. Implementation remains deferred until explicitly requested. *(Done: reviewed against the baseline source across two rounds. The resulting revisions are recorded in status revisions 2026-09-17-b and -c and land in a single spec-only commit on this branch, separate from the original design commit `6d2925a`, which stays untouched as the historical record. This entry deliberately does not cite that commit's own hash — a commit cannot contain its own identifier. Anything a later reader needs is in `git log` for this file.)*
3. Implement and test on this same branch, with specification and code changes in separately reviewable commits.
4. Append a status revision when implementation is complete, including verification evidence and any approved contract adjustments. Do not replace the historical design status.
5. Open the implementation PR into `main` when authorized. Use merge-commit workflow, not squash merging.

### Design alternatives considered

- **Reject the complete write (selected):** preserves the ID model, makes failure explicit, and avoids partial source/graph replacement.
- **Skip foreign nodes:** rejected because it creates partial graphs and ambiguous edge/count/supersession behavior.
- **Entity-qualified or composite identities:** deferred because it changes the global identity contract and potentially schema/consumers beyond the bounded fix. Hosts may qualify their own IDs without requiring that redesign.
