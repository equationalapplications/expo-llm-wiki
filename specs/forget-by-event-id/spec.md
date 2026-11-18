# forget({ eventId }) — delete librarian facts by their source-pointer event id

**Status: Draft — awaiting owner gate (issue #386)**  
**Intent check:** INTENT rule 2 — this change adds one optional selector
(`eventId`) to `ForgetParams` (`packages/core/src/types.ts`) and two
`EntryRepository` methods; it adds no columns, drops nothing, and changes no
existing selector's semantics (rule-2 clean: pure additive surface). The
`forget()` contract amendments of INTENT rule 8 (`specs/durable-vector-removal/`)
apply unchanged — the new selector feeds the same id-enumeration → ledger
backstop → FTS sync → vector drain pipeline every other selector uses. Named
follow-up of the ruled source-pointers spec (§forget boundary, §Non-goals); the
2026-11-14 owner ruling requires this deletion path to exist because it is the
first-class removal path for retained quotes.

## Problem

A host cannot remove "everything that came from event X". Today:

- `forget({ sourceRef })` / `forget({ sourceHash })`
  (`MaintenanceService.ts` `forget`, ~:1150) ignore the pointer entirely —
  by design (ruled: their semantics are frozen).
- `forget({ entryId })` removes one fact at a time; the host must already
  know the ids.
- Verified quotes survive prune, export, and the outbox inside their fact's
  record (2026-11-14 ruling), so removal of everything tied to an event must
  be a named, supported operation — not merely "possible via per-entry
  forget".

## Where the pointer lives

`entries.source_pointer` is a nullable JSON TEXT column (source-pointers
spec §The pointer), written only through `serializeSourcePointer` and read
only through `parseStoredSourcePointer` (`EntryRepository.ts`). Slots:
`event_id`, `ref`, `quote`, `position`. The ruled scope of the #377 release
was persist / return-on-reads / carry-through-export-import; deletion by
pointer was deliberately deferred to this issue (new deletion semantics on a
JSON column).

## Decisions (owner gates these)

### D1 — Match predicate: `json_valid` + `json_extract`

A fact matches when, entity-scoped and on live-or-tombstoned rows selected
by the existing forget id conventions:

```sql
json_valid(source_pointer) AND json_extract(source_pointer, '$.event_id') = ?
```

The `json_valid` guard is load-bearing: `json_extract` **raises** on
malformed JSON text, and the column's tolerance contract (parse-side drops
with `dropped_pointer_values`) means a malformed value must exclude a row,
never fail the call. JSON1 functions ship in every supported driver build
(expo-sqlite / better-sqlite3 / node:sqlite bundle standard SQLite ≥ 3.38);
a probe test pins availability so a build without JSON1 fails loudly in CI,
not on a device.

### D2 — Selector grouping: its own exclusive group

`eventId` composes with nothing: mutually exclusive with
`entryId`/`taskId`/`sourceRef`/`sourceHash` and excluded by `clearAll`,
matching the existing selector-group validation style (same error-message
family). `includeChain` still composes only with `entryId`; `includeEvents`
still requires `clearAll`. Rationale: a quote-hygiene call is "remove event
X's traces from this entity" — a distinct intent from ingest-ownership or
id-targeted deletion; composition would force this spec to rule on
untested intersections.

### D3 — Repository pair with identical predicates

`EntryRepository` gains:

- `findIdsByPointerEvent(entityId, eventId, tx, includeDeleted)` —
  enumeration for `deletedEntryIds`;
- `softDeleteByPointerEvent(entityId, eventId, tx)` — the mutator.

The two predicates MUST be character-identical (the by-source branch already
documents this invariant: the enumeration is what makes the post-transaction
index update O(deleted), not O(entity)). Both use `parseStoredSourcePointer`-compatible
row shapes only via SQL; no JS-side filtering.

### D4 — Deletion scope: entries only

The selector soft-deletes **entries** (librarian facts, the only rows that
carry `source_pointer`). Explicit non-touches:

- **events table rows** — untouched (only `clearAll + includeEvents` deletes
  events; unchanged);
- **tasks** — no pointer, untouched;
- **`source_ref_index`** — pointer is provenance, not ingest ownership
  (source-pointers spec §Rejected alternatives already rules event ids out
  of that column);
- **`source_passages` / `source_documents`** — keyed by
  sourceRef/sourceHash, orthogonal to pointers; their removal stays on the
  by-source selectors.

### D5 — Removal contract reused unchanged

After the transaction: enumerated ids → ledger `backstopEnqueue` (when the
gate is `hook`) → `searchService.syncEntries` → `vectorRemoval.drain` →
`WikiExternalDeletionError` on unconfirmed removals — byte-identical to the
existing selectors (INTENT rule 8 amendments; drain/deferred contract).
Nothing new is invented for vector removal or FTS.

### D6 — Result shape unchanged

`ForgetResult` is untouched; the count reports in `deleted.entries` (the
selector deletes entries, so the existing field is the truthful name). No
new result field.

### D7 — dryRun parity

`forgetDryRun` accepts `eventId` under the same exclusivity validation and
reports the match count through its existing reporting shape — a host can
preview an event-hygiene sweep before running it.

### D8 — Diagnostics unchanged

Existing forget diagnostic codes report the operation; **no new code** is
added. (The issue's acceptance item 3 is satisfied by the existing
forget-diagnostics flow, same as `sourceRef`/`sourceHash` today.)

## Rejected alternatives

- **`LIKE '%"event_id":"<id>"%'` string matching.** Fragile against
  serialization (key order, whitespace, escaping) and blind to JSON
  semantics; `json_extract` is exact and typed.
- **Deleting the event row itself.** Event retention is ruled by
  `retainEventsFor` / `clearAll + includeEvents`; a selector that deletes
  the event would also break the librarian watermark story. The pointer is
  fact→event provenance; deleting the fact does not orphan the event (the
  reverse direction is `events.related_entry_id`, which points at the
  *current* fact and is nulled by row removal, not by tombstoning — see
  below).
- **Hard delete.** Forget's semantics are soft-delete + prune; erasure
  depth is the #401 epic's domain (secure-delete, supersession-chain
  option, `compact()`). This selector composes with that epic: rows it
  tombstones are exactly the rows the epic's mechanisms erase.
- **Composing `eventId` with `taskId` or `sourceRef`** (filter-style, like
  the sourceRef×sourceHash AND). No consumer names two selector kinds for
  one hygiene sweep; shipping unused intersections means every future
  ruling must re-derive their semantics.

## Acceptance tests (maps to the issue sketch)

1. **Selective removal**: facts whose pointer names event E1 are
   soft-deleted; sibling facts pointing at E2, and facts with no pointer,
   are untouched (sketch 1).
2. **No dangling pointers within the entity**: after the call, zero live
   rows carry a pointer naming the event (sketch 2 — asserted by re-running
   the match query and expecting 0).
3. **Contract parity**: the removed ids flow through ledger backstop, FTS
   sync, and vector drain exactly as a `sourceRef` call's ids do; unconfirmed
   removal raises `WikiExternalDeletionError` (sketch 3 — reuse the existing
   by-source contract tests' harness).
4. **Frozen selectors**: existing `sourceRef`/`sourceHash` tests pass
   unchanged; new explicit pins assert a `forget({ eventId })` call touches
   no `source_ref_index` row and no `source_passages` row (sketch 4).
5. **Malformed-pointer tolerance**: a row with corrupted `source_pointer`
   text neither matches nor errors the call (`json_valid` guard probe).
6. **JSON1 availability probe** (CI canary for D1).
7. **dryRun** reports the match count without mutating.
8. **Exclusivity**: every forbidden composition throws with the existing
   error-message style; `clearAll` + `eventId` throws.

## Non-goals / #401 boundary

- Erasure *depth* (FTS5 secure-delete, supersession-chain removal,
  `compact()`, forensic canary) stays with **issue #401**; this spec adds a
  *selector* on existing soft-delete semantics and must not be re-surfaced
  by that epic.
- Bulk deletion across entities (charter rule 3 keeps every selector
  entity-scoped) stays out.
- Pointer mutation/rewrite paths stay closed (source-pointers spec: "a
  pointer is provenance, not an edit path").

## Release surface

Additive public API → **MINOR release** (same class as `erase()`, which
shipped as MINOR per the forget-erasure spec ruling F). Next minor after the
current one; no migration, no schema change.
