# forget({ eventId }) — delete librarian facts by their source-pointer event id

**Status: Draft v4 — design ratified by the owner 2026-11-18 ("422 ratified"); Opus T3 spec review folds applied (3 MAJOR + 7 minor, verdict REQUEST CHANGES → folded); delta + Fable T4 spec gate pending**  
**Intent check:** INTENT rule 2 — this change adds one optional selector
(`eventId`) to `ForgetParams` (`packages/core/src/types.ts`) and three
`EntryRepository` methods; it adds no columns, drops nothing, and changes no
existing selector's semantics (rule-2 clean: pure additive surface). The
`forget()` removal pipeline is the one INTENT **Rule 7** already governs
(with its 2026-11-11/12 amendments recording the drain contract and
`specs/durable-vector-removal/`) — the new selector feeds that pipeline
unchanged. Named follow-up of the ruled source-pointers spec (§forget
boundary, §Non-goals); the 2026-11-14 owner ruling requires this deletion
path to exist because it is the first-class removal path for retained
quotes.

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
only through `parseStoredSourcePointer` → `validateSourcePointerValue`
(`sourcePointer.ts:40-88`). Slots: `event_id`, `ref`, `quote`, `position`.
The ruled scope of the #377 release was persist / return-on-reads /
carry-through-export-import; deletion by pointer was deliberately deferred
to this issue (new deletion semantics on a JSON column).

## Decisions (owner-gated design, ratified 2026-11-18; review folds applied)

### D1 — Match predicate: slot-typed, planner-safe JSON match

A fact matches when, entity-scoped:

```sql
json_extract(
  CASE WHEN json_valid(source_pointer) THEN source_pointer END,
  '$.event_id'
) = ?
  AND json_type(source_pointer, '$.event_id') = 'text'
```

- The `CASE WHEN json_valid(...)` wrapper is **required for correctness**,
  not style: SQLite does not promise AND-term evaluation order, so a bare
  `json_valid(source_pointer) AND json_extract(...)` can still raise on
  malformed text if the planner reorders terms. This is the repo's existing
  pattern (`fts5Sql.ts:40`, `LintRepository.ts:11`).
- `json_type(..., '$.event_id') = 'text'` pins the slot to a string — the
  only shape producers write (`validateSourcePointerValue:50`).
- **Read-side asymmetry, stated on purpose:** deletion matches the
  `event_id` **slot** of any syntactically valid JSON object; read-side
  pointer *validity* (slot-key sets, field types, `position` shape —
  `validateSourcePointerValue`) is deliberately ignored. A fact whose
  pointer is shape-broken but still names event E1 **is deleted** by
  `forget({ eventId: 'E1' })` — that is the selector's intent (remove
  everything naming event X), and the same row reads back as pointerless
  only because reads are stricter than deletion. Duplicate-key JSON is out
  of contract: producers write via `serializeSourcePointer` (controlled
  shape) and imports validate (`parseOkfBundle`), so the SQLite-takes-first
  vs `JSON.parse`-takes-last divergence is unreachable in practice; this
  spec pins it as out-of-contract rather than paying a
  slot-canonicalization mechanism to fix it.
- **No JSON1 availability assumption without a canary:** JSON1 functions
  ship in every supported driver build (expo-sqlite / better-sqlite3 /
  node:sqlite bundle standard SQLite ≥ 3.38); a probe test pins
  availability so a build without JSON1 fails loudly in CI, not on a
  device.

**Canary scope, stated honestly:** the probe runs in vitest against the CI
adapters (better-sqlite3 and node:sqlite). This repo has no native Expo
device-runner harness, so the canary cannot itself execute a device SQLite
binary. On-device coverage rests on a dependency already in production:
the FTS5 index strategy requires JSON1 on every runtime —
`createIndexStrategy.ts:39` probes `SELECT json_valid('[]')` at index
creation and degrades explicitly on "no such function" — so any device
whose SQLite can build the search index (all expo-sqlite peer versions
bundle SQLite where JSON1 is unconditional, ≥ 3.38) can run this selector.
D1 introduces no new class of driver requirement; the canary formalizes an
existing one.

**Count semantics under tombstones:** the mutator carries the same
`deleted_at IS NULL` guard as `softDeleteBySource`
(`EntryRepository.ts:600`) — a row already tombstoned by a previous
operation is a no-op hit and does **not** increment `deleted.entries`
(the count comes from the UPDATE's transition result, matching the
by-source branch exactly). The `deletedEntryIds` enumeration stays
`includeDeleted = true` — deliberately a superset, feeding index sync and
the ledger backstop for ids tombstoned before the ledger existed, same as
by-source today.

### Performance envelope

`entries_entity_idx` (`schema.ts:43`) narrows every match query to one
entity's rows before any JSON evaluation — the scan is bounded by
facts-per-entity, never store-wide. Within one entity the `json_extract`
predicate is an unindexable scan of that entity's rows: accepted for
on-device latencies at realistic fact counts. The escape hatch — a
generated column promoting `event_id` with a standard index — is recorded
here and deliberately **deferred**: no consumer has demonstrated a
high-frequency `forget({ eventId })` workload, and a performance path
without a demonstrated need is untested weight. Revisit only on a measured
latency complaint.

### D2 — Selector grouping: its own exclusive group

`eventId` composes with nothing: mutually exclusive with
`entryId`/`taskId`/`sourceRef`/`sourceHash` and excluded by `clearAll`.
`includeChain` still composes only with `entryId`; `includeEvents` still
requires `clearAll`. Rationale: a quote-hygiene call is "remove event X's
traces from this entity" — a distinct intent from ingest-ownership or
id-targeted deletion; composition would force this spec to rule on
untested intersections.

### D3 — Repository trio, shared predicate constant, outbox parity

`EntryRepository` gains **three** methods (not two — the dry-run count is
its own method, see D7):

- `findIdsByPointerEvent(entityId, eventId, tx, includeDeleted)` —
  enumeration for `deletedEntryIds` (live + tombstoned, per the count
  semantics above);
- `softDeleteByPointerEvent(entityId, eventId, tx)` — the mutator;
- `countLiveByPointerEvent(entityId, eventId, tx?)` — live-only count for
  dry-run.

All three share **one match-predicate constant** (the SQL from D1 minus the
tombstone guard). The tombstone guard (`AND deleted_at IS NULL`) is added
only inside the mutator — the enumeration and the dry-run count must see
their stated row populations, so the methods are intentionally not
predicate-identical end to end; what is shared verbatim is the JSON match.

**Outbox parity is mandatory:** `softDeleteByPointerEvent` copies
`softDeleteBySource`'s select-ids → guarded-UPDATE → **one outbox `DELETE`
row per changed row** shape in the same transaction
(`EntryRepository.ts:585-637`; payload `{ id, entity_id, deleted_at }`,
`tx` required). A bare UPDATE would tombstone locally while synced replicas
never learn of the removal — the exact failure this selector exists to
prevent. This is not an implementation detail; it is the acceptance surface
(test 10).

### D4 — Deletion scope: entries only

The selector soft-deletes **entries** (librarian facts, the only rows that
carry `source_pointer`). Explicit non-touches:

- **events table rows** — untouched and never rewritten (the
  `related_entry_id` column is left as written: tombstoning a fact does not
  update event rows; the column has no FK and no repository maintains it);
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
`WikiExternalDeletionError` on unconfirmed removals — the same pipeline
every other selector uses (INTENT Rule 7 amendments;
`specs/durable-vector-removal/` drain/deferred contract). Nothing new is
invented for vector removal or FTS.

### D6 — Result shape unchanged

`ForgetResult` is untouched; the count reports in `deleted.entries` (the
selector deletes entries, so the existing field is the truthful name). No
new result field.

### D7 — dryRun parity, with its exclusivity checks up front

`forgetDryRun` runs outside any transaction and does not re-run the
in-transaction selector-group checks (`MaintenanceService.ts:1443-1445`) —
so **all `eventId` exclusivity validation lives in public `forget()` beside
the existing checks (~:1155-1163), before the dry-run dispatch**. Without
this, a naive `eventId` + `sourceRef` dry run would fall through to the
source-count branch. The dry run reports the live-only count through
`countLiveByPointerEvent` (D3) in its existing reporting shape.

### D8 — Reporting: the return value and the outbox — no new diagnostics

**`forget()` emits no diagnostics today and this selector adds none.**
There is no `'forget'` member in `WikiDiagnosticOperation`
(`types.ts:912-913`) and no `emitDiagnostic` call anywhere in `forget()`
— the issue's acceptance item 3 ("reported through the existing forget
diagnostics") rests on a mechanism that does not exist, and this spec
corrects the premise rather than silently widening a public union. Removal
is reported through:

1. the `ForgetResult` return value (`deleted.entries`, D6), and
2. the per-row outbox `DELETE` events (D3) — the surface sync consumers
   already subscribe to for every other tombstone.

Adding `forget` diagnostics would widen `WikiDiagnosticOperation` (new
public surface + new code families) for no consumer need named in the
issue; it stays out, per INTENT rule 6 (honest reporting — the spec says
what the code does). If a consumer later needs deletion diagnostics, that
is a separate additive ruling.

### Input validation

`eventId` must be a non-empty string; anything else throws
`Invalid eventId` (same message family as `Invalid sourceRef`, which is
normalized+validated at `MaintenanceService.ts:1226-1227`). This matters
because the branch dispatch uses truthiness gates — an empty string must
be rejected up front, not silently match nothing.

## Rejected alternatives

- **`LIKE '%"event_id":"<id>"%'` string matching.** Fragile against
  serialization (key order, whitespace, escaping) and blind to JSON
  semantics; `json_extract` is exact and typed.
- **Matching on read-side pointer validity** (pre-validating the whole
  pointer shape before deletion). Rejected with the D1 asymmetry: a
  shape-broken pointer still names its event, and quote hygiene wants it
  gone; paying validation in SQL to refuse deletion of a row reads would
  not surface is backwards.
- **Deleting the event row itself.** Event retention is ruled by
  `retainEventsFor` / `clearAll + includeEvents`; a selector that deletes
  the event would break the librarian watermark story. The pointer is
  fact→event provenance.
- **Hard delete.** Forget's semantics are soft-delete + prune; erasure
  depth is the #401 epic's domain (secure-delete, supersession-chain
  option, `compact()`). This selector composes with that epic: rows it
  tombstones are exactly the rows the epic's mechanisms erase.
- **Composing `eventId` with `taskId` or `sourceRef`** (filter-style, like
  the sourceRef×sourceHash AND). No consumer names two selector kinds for
  one hygiene sweep; shipping unused intersections means every future
  ruling must re-derive their semantics.

## Acceptance tests (maps to the issue sketch, as corrected by D8)

1. **Selective removal**: facts whose pointer names event E1 are
   soft-deleted; sibling facts pointing at E2, and facts with no pointer,
   are untouched (sketch 1).
2. **Entity isolation (INTENT rule 3)**: a fact in entity B pointing at E1
   survives `forget(A, { eventId: 'E1' })`.
3. **No dangling pointers within the entity**: after the call, zero live
   rows carry a pointer naming the event (sketch 2 — asserted by re-running
   the match query and expecting 0).
4. **Contract parity**: the removed ids flow through ledger backstop, FTS
   sync, and vector drain exactly as a `sourceRef` call's ids do; unconfirmed
   removal raises `WikiExternalDeletionError` (sketch 3, re-mapped per D8:
   "reporting" is the return value + outbox, not diagnostics — reuse the
   existing by-source contract tests' harness).
5. **Frozen selectors**: existing `sourceRef`/`sourceHash` tests pass
   unchanged; new explicit pins assert a `forget({ eventId })` call touches
   no `source_ref_index` row and no `source_passages` row (sketch 4).
6. **Malformed-pointer tolerance**: a row with corrupted `source_pointer`
   text neither matches nor errors the call (`CASE json_valid` guard).
7. **Shape-broken pointer is still deleted** (D1 asymmetry pin): a row
   whose pointer passes `json_valid` but fails `validateSourcePointerValue`
   (e.g. `position` numbers out of range) with `event_id: 'E1'` IS
   soft-deleted by `forget({ eventId: 'E1' })`.
8. **JSON1 availability probe** (CI canary for D1 — scope per §Canary
   scope: CI adapters; on-device covered by the existing index-strategy
   JSON1 dependency).
9. **Exclusivity + validation**: every forbidden composition throws with
   the existing error-message style (`clearAll` + `eventId` included);
   `eventId: ''` and non-strings throw `Invalid eventId`.
10. **Tombstone idempotence**: a second `forget({ eventId })` call on the
    same entity reports `deleted.entries: 0` (the `IS NULL` guard counts
    transitions, not matches).
11. **Outbox parity** (D3): one outbox `DELETE` row per changed row inside
    the transaction; zero on the idempotent second call.
12. **dryRun**: reports the live-only count without mutating — and counts
    zero for an event whose facts were tombstoned earlier, while the real
    call still reports the tombstone idempotence semantics of test 10.

## Non-goals / #401 boundary

- Erasure *depth* (FTS5 secure-delete, supersession-chain removal,
  `compact()`, forensic canary) stays with **issue #401**; this spec adds a
  *selector* on existing soft-delete semantics and must not be re-surfaced
  by that epic.
- Bulk deletion across entities (INTENT rule 3 keeps every selector
  entity-scoped) stays out.
- Pointer mutation/rewrite paths stay closed (source-pointers spec: "a
  pointer is provenance, not an edit path").
- `forget` diagnostics stay nonexistent (D8); adding them is a separate
  additive ruling, not a rider on this selector.

## Release surface

Additive public API → **MINOR release** (same class as `erase()`, which
shipped as MINOR per the forget-erasure spec ruling F). Next minor after the
current one; no migration, no schema change.
