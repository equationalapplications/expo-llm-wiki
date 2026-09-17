# Graph Write Entity Isolation

**Date:** 2026-09-17

**Status:** Design approved in conversation; specification recorded for review; implementation not started

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

- `packages/core/src/WikiMemory.ts`, `upsertGraph`: accepts caller-supplied node IDs and performs an entity-scoped source-hash check before forwarding to `upsertGraphCore`.
- `packages/core/src/services/IngestionService.ts`, `upsertGraphCore`: constructs facts using the incoming node ID and requested entity, then calls `EntryRepository.upsert`. Ontology resolution precedes source supersession and can persist seeded manifest metadata.
- `packages/core/src/repositories/EntryRepository.ts`, `upsert`: looks up an existing row globally by ID and uses `ON CONFLICT(id) DO UPDATE SET entity_id = excluded.entity_id`. Its update preserves existing OKF metadata and includes that metadata in an outbox payload under the incoming entity.
- `packages/core/src/services/ImportExportService.ts`: the separate import path checks foreign ownership and skips conflicting entries. That existing policy is not the desired policy for graph writes and is not changed here.

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
2. Perform the existing entity-scoped source-hash probe through the supplied adapter.
3. If the existing mapping is the identical `(entityId, sourceHash, sourceRef)`, return the existing zero-count no-op. Incoming nodes are not processed or ownership-checked on this path; no mutation occurs.
4. If the hash belongs to another source reference within the requested entity, preserve `WikiSourceRefHashCollision` precedence and behavior.
5. Otherwise enter `upsertGraphCore` and perform the complete node-ownership preflight **before ontology resolution or any persistent mutation**.
6. Only after ownership succeeds, continue the existing ontology validation, source supersession, source-index updates, node writes, and edge writes.

The placement before ontology resolution is mandatory: resolving a configured seed manifest can itself persist metadata. A rejected ownership preflight must not leave a seeded manifest behind.

### Lookup

Implement the preflight through the repository abstraction, using the supplied transaction adapter. Reuse `findExistingMetadataByIds` if appropriate; it already returns existing owners and chunks IDs. Do not add raw entry-table SQL to the service or perform the check through `this.db` outside the supplied transaction. Include soft-deleted rows and respect the repository's existing bind-variable batching convention.

Once any foreign owner is found, throw the generic ownership error. Never return partial counts or skip the conflicting node and continue. Do not use the import path's warning helper: that helper has different skip semantics and includes foreign-entity information.

### Atomicity and host obligations

Preserve the existing caller-owned transaction contract. `upsertGraph` does not acquire a new lock, start a nested transaction, commit, or roll back the caller's transaction. Hosts must provide the appropriate transaction adapter and propagate operation failures so their transaction wrapper rolls back partial work from failures occurring after preflight.

For a foreign-owner collision visible during preflight, this operation performs **zero persistent mutations**, even if the host catches that particular error within its transaction. Preexisting writes performed by the host before calling `upsertGraph` are not this operation's writes and must not be undone by the method itself.

Do not claim that a sequence of statements on an arbitrary nontransactional adapter is atomic. A late repository rejection or SQLite transaction/concurrency error must propagate rather than be converted to a successful partial result. Under a correctly managed caller transaction, all writes by a failed graph operation roll back. The conditional repository write in REQ-DAO-01 prevents a foreign-row overwrite even if ownership changes between checks; it does not replace host transaction management.

## 4. Repository write invariant [REQ-DAO-01]

Enforce ownership within `EntryRepository.upsert`, independently of the graph preflight. Other callers must not be able to overwrite or reassign a foreign entry by omitting the service-level check.

Required behavior:

- Include the existing row's `entity_id` in the lookup and reject a known foreign owner before writing or constructing an outbox event.
- Make the SQL conflict update conditional on the existing and incoming entity IDs matching. Do not change ownership on an update.
- A foreign-owner conflict must not update **any** column, including content, timestamps, deletion state, embeddings, provenance, or verification metadata.
- Detect a conflict update suppressed by the ownership condition and throw the same domain error. Do not return success or publish an outbox event for a suppressed write. Verify the supported adapters' affected-row semantics during implementation; distinguish an allowed same-entity update from an ownership-rejected no-op.
- Emit an outbox event only after a permitted insert/update is known to have succeeded. Preserve existing insert/update/delete operation classification and metadata payload behavior for permitted writes.
- Do not turn unrelated SQL errors into ownership errors or suppress them.

**Removing `entity_id` from the SET clause alone is insufficient:** it would still allow another entity's title, body, and other fields to be overwritten. The conflict update must have an owner-matching condition in addition to any early check.

The graph preflight supplies whole-batch rejection before side effects; the repository guard supplies per-write safety for all callers. Neither replaces the other. Existing document ingestion, librarian, and maintenance callers of `upsert` remain subject to this invariant, even though they normally generate new IDs. They must propagate an unexpected ownership failure rather than treat it as an item to skip.

`upsertForImport` and the separate import collision policy are outside this change. Do not broaden this fix into an import behavior rewrite.

## 5. Error and information disclosure [REQ-ERROR-01]

Add a public domain error following the existing classes in `packages/core/src/types.ts`:

- Class/name: `WikiGraphNodeOwnershipConflict`
- Stable code: `WIKI_GRAPH_NODE_OWNERSHIP_CONFLICT`
- Message: `Graph write rejected because a node ID is unavailable for this entity.`
- No required constructor arguments and no custom data fields other than the stable code.

Use this error for both graph preflight and repository ownership rejection. Export the runtime class through the normal core public entrypoint and preserve the package's existing re-export conventions so consumers can catch it without importing internal modules. Tests must verify the public runtime export, not just a TypeScript type export.

Do not attach the foreign entity ID, conflicting node ID, source reference, source hash, stored content, provenance, verification information, database row, SQL parameters, or underlying row as `cause`. Do not log or warn with these values on the new rejection paths. Both message and enumerable error properties must remain free of stored foreign data. Standard `Error` stack behavior remains unchanged; stack sanitization at remote API boundaries belongs to the host.

A rejection necessarily indicates that some supplied ID is unavailable. This spec does not promise to hide ID occupancy or eliminate an existence oracle. It does promise not to disclose the foreign owner or record details, and not to identify which node in a batch conflicted.

The error must propagate as a domain error through existing transaction wrappers. Do not convert it into `WikiTransactionError`, swallow it, or expose a lower-level database error for the normal ownership-rejection case.

## 6. Preservation and non-goals [REQ-COMPAT-01]

Preserve:

- Public `upsertGraph(entityId, params, adapter)` parameter and success-result shapes.
- Source-reference/hash validation, existing source-hash collision errors, and exact-hash no-op behavior.
- Same-entity node updates, metadata retention, source supersession, edge handling, and success counts.
- Ontology off/lenient/strict behavior after ownership preflight succeeds.
- Empty-node graph operations and caller-owned transaction behavior.
- Existing import skip policy and unrelated warnings.

No schema migration or composite-key redesign is required. Do not modify edge-ID collision policy, dangling-edge semantics, tenant authorization, global export APIs, native GraphRAG work, release workflow PR selection, or unrelated logging. Do not retroactively infer original owners or repair previously reassigned rows: reliable ownership history is not established by this change.

The new error is an intentional behavior correction for foreign-ID writes, not permission to rename valid same-entity IDs. Document it in the core README's Direct Graph Write section, including host transaction obligations and the globally shared entry-ID namespace.

## 7. Acceptance tests [REQ-TEST-01]

Use the repository's existing test conventions and real SQLite integration coverage for persistence assertions. Mocks alone cannot establish SQL ownership isolation or rollback. No tests are executed as part of committing this spec.

### Graph operation

1. **Mixed batch, late conflict:** seed entity B with an existing deterministic-ID fact. Submit an entity-A batch containing valid new/update nodes followed by the colliding node and edges. Assert the typed error and no partial success.
2. **Full state preservation:** seed entity A with an existing source graph that would otherwise be superseded, plus source-index rows and outbox state. Seed entity B with distinct metadata, embeddings, and timestamps. After rejection, compare pre/post state for entries in both entities, edges, source-reference indexes, ontology/entity metadata, and outbox rows. Existing outbox rows must remain unchanged; no new ones may appear.
3. **Seed-manifest side effect:** configure a not-yet-persisted seed manifest for entity A. On ownership rejection, assert the manifest was not persisted. Exercise the rejection caught inside a caller-owned transaction that then commits, proving preflight itself performed no persistent writes rather than merely relying on rollback.
4. **Soft-deleted foreign owner:** repeat with a soft-deleted entity-B row; it remains reserved and unchanged.
5. **Batching:** place a foreign owner beyond the first ownership-lookup batch. Assert whole-call rejection and no partial writes.
6. **Error privacy:** assert exact name/code/message, public `instanceof` behavior, and absence of foreign owner, node ID, content, and metadata from the error's custom fields/serialization and new-path console output. Assert no attached cause.
7. **Compatibility:** cover fresh inserts, same-entity updates, existing same-entity resurrection behavior, preserved metadata/outbox payloads, empty nodes, and repeated incoming node IDs. Preserve baseline counts and edge behavior.
8. **Existing early returns:** unchanged source-hash no-op returns zero counts even if incoming nodes would collide; a different-source-reference hash collision keeps its existing error precedence. Neither path mutates state.
9. **Ontology ordering:** when both ownership and ontology violations are present on a non-no-op write, ownership rejection wins without seeding metadata. For ownership-valid data, existing strict ontology behavior remains unchanged.

### Repository and transactions

10. **Direct repository rejection:** call `EntryRepository.upsert` with a foreign-owned ID, including a soft-deleted row. Assert no field changes, no outbox event, and the same typed error without relying on `upsertGraphCore`.
11. **Conditional-write backstop:** exercise the SQL owner predicate separately from the early lookup, using a controlled test seam or direct real-SQL repository fixture. Demonstrate that a mismatched owner suppresses all column updates and that the repository recognizes suppression without emitting an event. Do not use timing sleeps or present a mock as proof of SQL behavior.
12. **Allowed same-entity update:** include a logically unchanged update to verify that supported affected-row behavior is not misclassified as an ownership conflict.
13. **Failure propagation/rollback:** inject a late domain failure after earlier valid mutations in a caller-managed transaction. Assert that propagating the failure rolls back the operation, with no committed outbox records. Also verify that preflight rejection does not itself end a caller-owned transaction or undo unrelated prior host work when caught.
14. **Shared-caller regression:** run existing document-ingestion, librarian/maintenance, import, ontology, and outbox tests impacted by the repository change. Existing import conflict handling must retain its current policy.
15. **Public API checks:** typecheck/build relevant packages and verify that the error is available as a runtime export through supported package entrypoints.

Record actual commands and outcomes with implementation; do not describe unrun tests as passing. Cross-connection scheduling tests are optional unless needed to validate the chosen implementation, but the SQL predicate and transaction contract are mandatory acceptance criteria.

## 8. Delivery and review

1. Commit this approved design on `dev/graph-entity-isolation`; retain the native GraphRAG spec on its separate branch.
2. Have the user review the written specification. Implementation remains deferred until explicitly requested.
3. Implement and test on this same branch, with specification and code changes in separately reviewable commits.
4. Append a status revision when implementation is complete, including verification evidence and any approved contract adjustments. Do not replace the historical design status.
5. Open the implementation PR into `main` when authorized. Use merge-commit workflow, not squash merging.

### Design alternatives considered

- **Reject the complete write (selected):** preserves the ID model, makes failure explicit, and avoids partial source/graph replacement.
- **Skip foreign nodes:** rejected because it creates partial graphs and ambiguous edge/count/supersession behavior.
- **Entity-qualified or composite identities:** deferred because it changes the global identity contract and potentially schema/consumers beyond the bounded fix. Hosts may qualify their own IDs without requiring that redesign.
