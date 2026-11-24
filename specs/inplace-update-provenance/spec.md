# In-place update provenance — `derived_events` on librarian facts

**Status:** Implemented (2026-11-23, PR #469; owner-approved 2026-11-23, with the per-update receipt deferred to roadmap step 13)
**Date:** 2026-11-23
**Intent check:** INTENT rule 12 (the librarian "may rewrite a fact the
engine inferred earlier, in place, without keeping the old text"; "per-fact
pass reports are planned") and rule 13 (erasure is verifiable; "forget wins
over re-ingest") are the rules this spec serves: a host cannot honor an
erasure request against wording it cannot find. Rule 2 (additive schema:
one nullable column, no drop, no semantic change to an existing column).
Rule 6 (honest reporting: two new content-free diagnostics; a merge of an unattributable candidate stops being silent).
Rule 5 is untouched (document facts are never rewritten; the UPDATE path
already refuses them, `apply.ts:194`). Rule 7: no new model call. Rule 10:
this spec's Status flips in the implementing PR; the two specs whose
as-landed text this changes (`specs/forget-by-event-id/spec.md` §D1/§D4,
`specs/source-pointers/spec.md` §One pointer) get a dated as-landed note in
the same PR. The INTENT glossary entry "Source pointer" ("the pointer is not
re-attributed") stays true; whether it gains one sentence naming the list is
an open question below, because INTENT edits are the owner's.

Issue: [#450](https://github.com/equationalapplications/expo-llm-wiki/issues/450).

## Owner rulings (2026-11-23)

These bind the sections below; where a section's text still names a
superseded design, this block wins.

1. **No per-update receipt here.** This spec's proposed
   `librarian_updated` receipt (old §6) is dropped. Roadmap step 13
   (`specs/type-on-write/`, PR #471) ships `librarian_rewritten
   { factId }` and `librarian_superseded { factId, replacementId }` at the
   same `apply.ts` branches; this spec defers to those. This spec keeps
   `source_event_gone` and `source_pointer_unresolved`. Test 2's receipt
   assertion and old Open question 5 are void.
2. **One schema version, v18, three pending changes.** PR #468 (#443,
   partial index; merges first and creates v18), PR #470 (#451,
   `prior_valid_to`) and this PR share v18. This PR implements its column
   as v18 now, with the DDL in its own named, exported, idempotent
   (PRAGMA-guarded) helper (`addDerivedEventsColumn`) called from the v18
   migration body, so a later rebase reduces to adding one helper call.
   Rust `REQUIRED_SCHEMA_VERSION` 17 to 18 in this PR.
   Landing rule (orchestrator decision): `release.yml` auto-merges release PRs,
   so the three v18 PRs land in ONE push to main, stacked #468 <- #470 <- #469;
   this PR is never merged alone. If a published release ever contains v18
   before all three land, the later changes go in v19.
3. **Open question 7:** the follow-up issue for `forget-event-exclusion`
   is filed: [#472](https://github.com/equationalapplications/expo-llm-wiki/issues/472).
4. **Open question 6:** the INTENT dated amendment (glossary sentence plus
   a rule-12 note, no rule text change) lands in this PR, citing PR #469.

## Problem

A host that erases event E must also remove every fact whose wording came
from E. Today it can find only the facts whose `source_pointer.event_id`
names E (`forget({ eventId })`, `specs/forget-by-event-id/`). The ops
librarian also merges new event text into an existing fact's title and body
*in place*, keeping that fact's original pointer; nothing records which
events contributed to the merge. Wording derived from E can therefore
survive, invisibly, inside a fact that points at some other event, and
`forget({ eventId: E })` leaves it live. SynapseTree records this as a known
limit of its host-side erasure (issue #450).

## Root cause (with evidence)

### The one in-place wording rewrite in the engine

`packages/core/src/services/librarian/ops/apply.ts:193-210`. When the
resolve step returns `UPDATE` and the target is `librarian_inferred`, the
code re-reads the target and upserts `{ ...existing, title, body,
updated_at: now }`. Everything else is spread from the old row:
`created_at`, `source_pointer` (the first event), `confidence`, trust. The
candidate's own `sourceEventId` (`extract.ts:296-306`, resolved from the
model's `source_event` label before any write) is not written anywhere on
this path. `updatedIds` is collected only for search sync and re-embedding
(`ops/index.ts:102-115`); the pass result reports a count
(`factsWritten: written.length + updatedIds.length`, `ops/index.ts:121`),
never the ids or the events.

The merged body is the model's "merged title and body for that existing
fact" (`prompts.ts:204`): by contract it rests on both the target's old text
and the candidate's event text.

### The second-order gap on the same write seam

`apply.ts:213-234`. An `UPDATE` whose target is not `librarian_inferred`
(and every `SUPERSEDE`) inserts a *new* fact through `insert()` with the
candidate's pointer (`buildSourcePointer`, `apply.ts:40-61`). When the op
was `UPDATE`, the new fact's text is the model's merged text
(`overrides = { title: op.title, body: op.body }`, `apply.ts:218`), so it
rests on the superseded target's wording too, yet its pointer names only
the candidate's event. The INTENT glossary already discloses this ("the
stored body may rest on more than the named event; the pointer is not
re-attributed"). A later `forget({ eventId })` for the target's event
tombstones the (already superseded) target and leaves the replacement
live.

### What `forget({ eventId })` does and misses today

`MaintenanceService.ts:1339-1346, 1382-1386` enumerates and soft-deletes
the entity's entries matching `EntryRepository.POINTER_EVENT_MATCH_SQL`
(`EntryRepository.ts:648-651`): the `event_id` slot of a valid
`source_pointer` JSON object, nothing else. Decision D4 of its spec: event
rows are untouched. So after `forget({ eventId: E })`:

- facts whose pointer names E are tombstoned and flow through the removal
  contract (outbox DELETE rows, ledger backstop, search sync, vector drain);
- a fact that *absorbed* E through an in-place UPDATE stays live (no
  record exists to match);
- a replacement fact that absorbed a superseded target's text stays live
  (same reason);
- event E itself stays in `events`. If E is still ahead of the librarian
  watermark, the next pass reads it again (`EventRepository.getAfter`,
  `:194-208`) and re-derives from it: new facts (pointer E, findable) and
  new merges (not findable). A host must repeat `forget({ eventId: E })`
  after every pass until prune removes E (`pruneThrough`, watermark-guarded,
  `MaintenanceService.ts:500`).

### Paths that are not in scope, and why

- **Legacy strategy** (`librarian/legacy.ts`): insert-only ("The
  transaction only inserts", `legacy.ts:243-245`), writes no pointer
  (`legacy.ts:196`). No in-place rewrite exists; the no-pointer gap is the
  accepted one (`specs/source-pointers/` §Legacy path). Unchanged here.
- **Heal** (`MaintenanceService.doRunHeal`): never rewrites wording in
  place. It lowers confidence (`downgradeStaleInferred` `:1772`,
  `downgradeByIds` `:2035`), soft-deletes (`softDeleteByIds` `:2036`,
  `markOrphaned`), and restates as *new* facts with a fresh id and
  `source_pointer: null` (`:2075-2083`). Its restatements derive from
  facts, not events, and the response does not pair a delete with its
  restate (`specs/heal-screening-system-one/` §4 disclosure), so there is
  no attribution signal to persist. Heal provenance remains the named
  follow-up of `specs/source-pointers/` §Non-goals. Steps 11 and 12
  (`resolution-system-one`, `heal-screening-system-one`) changed which
  candidates reach the UPDATE path and added heal receipts; they added no
  write path. Out of scope, stated here so nobody reads this spec as
  covering heal.
- **Host verbs** `supersede()`, `remember()`, `expire()`, `promoteDraft`:
  the host supplies the text or changes status only; no event provenance
  to record.
- **Ontology backfill**: writes `okf_type` only (`:3077`).

### The in-flight race, precisely

Inside the engine, `forget` and `librarian` exclude each other
(`JobManager.ts:291`: forget is blocked while a librarian pass holds the
entity's lock; `:232-240`: and vice versa). A pass reads its batch outside
any transaction, spends seconds to minutes on model calls, then applies in
one transaction (`apply.ts:88`). A host's `forget({ eventId })` during
that window gets `WikiBusyError('librarian')` and waits, so an in-engine
forget always sees the pass's output. The race the issue describes is a
host that deletes event rows **directly in SQL** during the window (the
deleting-data guide acknowledges hosts that write to the wiki tables): the
pass then merges text from an event that no longer exists, and no engine
lock can see that write.

## Options considered

| | (a) Record contributing events on the fact | (a') Same, as a new slot inside `source_pointer` JSON | (a'') Update-log table | (b) Pending-erasure set / pass-abort API |
|---|---|---|---|---|
| INTENT fit | Rule 12/13 direct: erasure becomes findable; per-fact report | Same, but reopens the ruled "one pointer, not a list" shape | Same | Rule 7 fine; abort mid-call wastes metered spend; exclusion needs event state the engine does not have |
| Schema (rule 2) | One nullable column, migration v18 | No migration | New table, v18 | Table or event column, v18; or in-memory only (lost on restart, useless in deferred mode) |
| Erasure completeness | Complete for UPDATE and UPDATE-as-SUPERSEDE, retroactively for anything that landed; `forget({ eventId })` matches it | Same | Same | Prevents future consumption only; nothing for merges already stored; abort cannot un-merge |
| Race (events erased mid-pass) | Not by itself; closed by the apply-time existence re-check below | Same | Same | Abort closes it only if the host notices in time; exclusion set closes it only if `applyOps` re-checks it |
| Export/import | Dump: automatic once the type carries it + import literal and `upsertForImport` (pointer precedent); OKF: one optional frontmatter list | Older engines' import predicate rejects unknown keys (`validateSourcePointerValue`): a dump from a newer engine nulls the pointer on downgrade | New dump table and `MemoryDump` widening; no OKF home | Not exported (operational state) |
| Cost | No model call; one `SELECT` per UPDATE already exists; `forget` adds a `json_each` scan per entity row (D1 envelope) | Same | Join, indexable | New API, lock semantics, tests; no model call |
| Semver | minor | minor | minor | minor |
| Rust pin | `REQUIRED_SCHEMA_VERSION` 17 to 18 (parity test forces it) | none | 18 | 18 or none |

**Recommendation: (a), as a separate nullable JSON column `derived_events`,
plus a cheap apply-time re-check that closes the host-side deletion race
without new API.** (a') is rejected because the import predicate on three
shipped releases treats extra pointer keys as malformed, so the first
cross-version dump would strip provenance, and because §One pointer was
ruled. (a'') buys indexability nobody has asked for at the price of a new
dump table. (b) is deferred, not rejected: an event the host has forgotten
should stop being raw material, which neither (a) nor the race check gives;
that needs an event-side marker and changes two ruled decisions
(forget-by-event-id D4 "event rows untouched", forget-erasure ruling D on
event retention), so it is its own spec. See §Split.

## Proposed change

### 1. The column

`entries.derived_events TEXT` (nullable; JSON array of event id strings,
deduplicated, insertion order). Migration **v18**, `ALTER TABLE ... ADD
COLUMN` with the same PRAGMA idempotence guard as v16
(`migrations.ts:373-386`); the every-open DDL in `schema.ts` gains the
column. No backfill: facts updated before this release have no record to
restore; null is the honest value. `crates/graphrag-core/src/schema_check.rs:20`
`REQUIRED_SCHEMA_VERSION` becomes 18 in the same PR
(`tests/schema_parity.rs` fails otherwise). The crate's `hydrate_facts`
selects named columns (`hydrate.rs:42`), so the added column does not
change its reads.

As landed disclosure: `derived_events` is complete only for attributable merges. An in-place UPDATE whose candidate has no resolvable `source_event` merges wording without recording it (reported via `source_pointer_unresolved`), and a candidate labelled E2 whose text drew on E1 from the same batch records only E2. A partly valid stored list keeps its string ids on read (non-strings are dropped), so the next merge extends it.

Semantics: "the stored wording of this fact also rests on these events,
beyond the one named by `source_pointer`." It is a contribution ledger,
not a second pointer: no quote, no position. `source_pointer` keeps its
meaning and is never re-attributed.

### 2. Writers (all in `apply.ts`, the single write seam)

- **UPDATE in place** (`:194-210`): when `g.candidate.sourceEventId !==
  null`, `derived_events = dedupe([...(existing.derived_events ?? []),
  sourceEventId])`; an id equal to `existing.source_pointer?.event_id` is
  not added (it is already the pointer). When the candidate's pointer is
  unresolved (`pointerUnresolved !== null`), the list is unchanged and the
  pass emits `source_pointer_unresolved` with `factId` = the target id and
  the candidate's `itemIndex` and reason: today this merge is silent
  (`apply.ts:154-156` comments that merged candidates "emit nothing"),
  which is the rule-6 hole this spec closes. A UPDATE whose candidate names
  an event already in the list (re-merge from the same event) writes
  nothing new.
- **UPDATE converted to SUPERSEDE** (`:213-234`, `overrides` present): the
  new fact's `derived_events = dedupe([target.source_pointer?.event_id,
  ...(target.derived_events ?? [])])` minus the new fact's own pointer
  event. The merged text rests on the target; the list says so.
- **Plain SUPERSEDE** (no overrides): no inheritance. The new text is the
  candidate's own extraction; the superseded target keeps its pointer and
  list and is matched by `forget({ eventId })` itself. (Open question 2.)
- **insert() for ADD**: `derived_events: null`.
- **`upsert`** (`EntryRepository.ts`, both the ordinary and the import
  variant): add the column to the INSERT list and the ON CONFLICT SET
  list; the import variant uses the same per-row presence flag pattern as
  `source_pointer` (`:524, 552`): a dump without the key leaves a stored
  list untouched. The ordinary `upsert` serializes the whole fact into the
  outbox payload (`:383`), so the list reaches outbox consumers with
  no further change. As landed: the ordinary `upsert` writes `derived_events` on
  conflict only when the caller supplies the key (`CASE WHEN ? THEN
  excluded.derived_events ELSE derived_events END`), so a re-upsert without the
  key never nulls an erasure trace; consequently the outbox payload overlays the
  stored list when the key is absent.

### 3. Apply-time re-check (closes the host-side deletion race)

Inside the `applyOps` transaction, before the op loop, one query:
`SELECT id FROM events WHERE entity_id = ? AND id IN (<batch event ids>)`.
Any candidate whose `sourceEventId` is not returned is **dropped whole**:
no insert, no UPDATE, no SUPERSEDE, no NOOP bookkeeping, and the pass emits
a new content-free diagnostic `source_event_gone` `{ itemIndex, sourceRef:
<eventId> }` per dropped candidate (`sourceRef` already carries an event
id in `context_overflow_skipped`, `extract.ts:223`). As landed: the check is per-label by design: it tests only the candidates' own
`sourceEventId`s (`IN (<those ids>)`), not every event of the batch, because a
candidate is attributed only to the event it names and the engine cannot know
which other batch events its text drew on. With `systemOne.typeOnWrite` engaged, a candidate dropped by this re-check has
already spent its classify call (counted in `typing.asked`; disclosed in
`specs/type-on-write/` §3). Candidates with an
unresolved pointer cannot be attributed and are not dropped; the spec and
the guide say so. The watermark is unaffected: it is a `(created_at, id)`
position, not a foreign key, and the batch's last event may legitimately
be gone. In-engine prune and forget cannot interleave with a pass (lock
exclusion above), so a missing event here is always a host-side delete,
which is exactly the signal the host wants honored. Cost: one indexed
`SELECT` per pass. (Open question 3.)

### 4. `forget({ eventId })` matches the list

`EntryRepository.POINTER_EVENT_MATCH_SQL` is widened to one shared
predicate:

```sql
(CASE WHEN json_valid(source_pointer)
      THEN json_type(source_pointer, '$.event_id') = 'text'
           AND json_extract(source_pointer, '$.event_id') = ?
      ELSE 0 END)
OR
(CASE WHEN json_valid(derived_events) AND json_type(derived_events) = 'array'
      THEN EXISTS (SELECT 1 FROM json_each(derived_events)
                   WHERE json_each.type = 'text' AND json_each.value = ?)
      ELSE 0 END)
```

Every JSON call stays under its own `json_valid` guard (the D1 discipline:
unguarded JSON functions raise on malformed text, and three-valued logic
makes a two-term form planner-dependent). The event id binds twice. The
three repository methods (`findIdsByPointerEvent`,
`countLiveByPointerEvent`, `softDeleteByPointerEvent`) and the dry run
inherit the widening with no signature change; `ForgetResult` is
unchanged (`deleted.entries` is still the truthful name). D2 selector
exclusivity, D3 outbox parity, D5 removal contract and D8 (no forget
diagnostics) all stand.

The behavior this buys, stated plainly: a fact whose pointer names E1 and
whose list names E2 **is soft-deleted whole** by `forget({ eventId: 'E2'
})`. The engine cannot un-merge text; deleting the fact is the only honest
erasure, and `dryRun` shows the count first. (Open question 1.)

### 5. Reads, export, import, OKF

- `WikiFact.derived_events?: string[]`, present on mapped facts only when
  non-empty (mirrors `source_pointer`, `EntryRepository.ts:71, 112`); a
  malformed stored value reads as absent without throwing
  (`parseStoredDerivedEvents`, beside `parseStoredSourcePointer`).
- `exportDump` round-trips the column once the type carries it;
  `importDump`'s fact literal forwards it (`ImportExportService.ts:484`
  pattern); import validates a present key: `null` or an array of
  non-empty strings; anything else imports as null and emits a new
  diagnostic `derived_events_invalid` `{ factId }` (buffered and emitted only after the import transaction commits; a rolled-back import emits none). Absent key: untouched
  (pre-release dump). `exportDump({ includeForgotten })` semantics are
  unchanged.
- OKF: `formatOkfBundle` emits an optional `derived_events` frontmatter
  list from both fact builders, only when non-empty; `parseOkfBundle`
  restores a well-formed list, omits the property otherwise, and reports a
  dropped value on the existing `dropped_pointer_values` list with reason
  slug `derived_events_malformed` (ids and a slug only; no values).
  (Open question 4.)

### 6. No per-update receipt (owner ruling 2026-11-23)

This spec ships no `librarian_updated` receipt. Roadmap step 13
(`specs/type-on-write/`, PR #471) ships `librarian_rewritten { factId }` and
`librarian_superseded { factId, replacementId }` at the in-place UPDATE and
the UPDATE-as-SUPERSEDE branches of `apply.ts`; the live per-update signal
is theirs. The column is the durable record. This spec's diagnostics are
`source_pointer_unresolved` (§2, unattributable merge) and
`source_event_gone` (§3).

### 7. What this spec does not do (and the split)

- Does not tombstone or exclude event rows. After `forget({ eventId: E })`
  a pass can still consume E until prune removes it, and the host must
  repeat the forget after each pass; with this spec every such re-derivation
  is at least findable. The guide's erasure recipe says so.
- Does not add a pass-abort API.
- Does not give heal restatements provenance.
- Does not cap the list. One UPDATE adds at most one id; the plan's test
  pins that a fact updated 200 times from 200 events reads and exports
  correctly.

**Split.** This spec is one PR. A second spec, suggested name
`specs/forget-event-exclusion/`, should carry option (b)'s real content: a
forgotten-event marker (`events.forgotten_at`, additive) set by
`forget({ eventId })`, skipped by `getAfter`/`getRecent` and by the
apply-time re-check above, excluded from reads and non-backup exports,
hard-deleted by the existing prune path. It changes forget-by-event-id D4
and touches forget-erasure ruling D, so it needs its own owner stop; the
re-check in §3 is written so that spec can extend the "gone" test with
"or forgotten" in one line.

> **Landed 2026-11-24 (PR #481):** the split shipped as `specs/forget-event-exclusion/` (issue #472).

## Files touched

Core (`packages/core/src/`):

- `db/schema.ts` — `derived_events TEXT` on entries.
- `db/migrations.ts` — v18 (`CURRENT_SCHEMA_VERSION` derives to 18).
- `types.ts` — `WikiFact.derived_events?`, diagnostic codes
  `source_event_gone`, `derived_events_invalid`;
  `ForgetParams.eventId` JSDoc gains the derived sentence.
- `utils/sourcePointer.ts` (or a sibling `derivedEvents.ts`) —
  serialize/parse/validate helpers.
- `utils/diagnostics.ts` — message templates and severities for the two
  new codes.
- `repositories/EntryRepository.ts` — column in both upserts and the row
  mapper; widened `POINTER_EVENT_MATCH_SQL` (rename to
  `EVENT_MATCH_SQL` with the old name kept as an alias for tests).
- `services/librarian/ops/apply.ts` — §2 writers, §3 re-check,
  unresolved-merge diagnostic.
- `services/ImportExportService.ts` — import literal and validation.
- `utils/formatOkfBundle.ts`, `utils/parseOkfBundle.ts` — frontmatter key.
- `services/MaintenanceService.ts` — no logic change expected; comment at
  `:1382-1386` updated to name the widened predicate.

Rust: `crates/graphrag-core/src/schema_check.rs` (pin 18).

Specs: this file; as-landed notes in `specs/forget-by-event-id/spec.md`
(§D1, §D4), `specs/source-pointers/spec.md` (§One pointer). The 2026-09-29
`fact_updated` note is step 13's, not this spec's.

Docs (`apps/docs/src/content/docs/`): `guides/deleting-data.md` (Forget
section: `forget({ eventId })` matches derived facts; erasure recipe step 2:
the repeat-after-pass caveat and the direct-SQL race), `guides/maintenance.md`
(Librarian strategies: UPDATE records contributing events),
`guides/diagnostics.md` (two codes), `guides/okf.md` (frontmatter key),
`reference/types.md` (`WikiFact.derived_events`), `reference/glossary.md`
(one line under Source pointer), `README.md` provenance bullet (one clause).
`docs/ROADMAP.md`: no step; the roadmap carries order, and this is
issue-driven work.

## Test plan

New `packages/core/__tests__/derivedEvents.test.ts` unless a case fits an
existing file better (`forgetEventId.test.ts`, `opsLibrarian.test.ts`,
`sourcePointers.test.ts`, `migrations.test.ts`, `export.test.ts`,
`okfReimport.test.ts`).

1. Migration v18 adds the column idempotently; `CURRENT_SCHEMA_VERSION`
   is 18; existing `migrations.test.ts` derivation test passes; Rust
   `schema_parity` passes.
2. UPDATE in place: fact F (pointer E1) merged with a candidate from E2
   reads back `derived_events: ['E2']`; pointer and `created_at` unchanged;
   `updated_at` advanced. (No receipt assertion: see Owner rulings 1.)
3. Dedupe: a second merge from E2 leaves `['E2']`; a merge from E1 (the
   pointer's event) adds nothing.
4. Unresolved candidate merged in place: list unchanged,
   `source_pointer_unresolved` emitted with `factId` = F.
5. UPDATE-as-SUPERSEDE of a `user_stated` target with pointer E0 and list
   `['E3']`: the replacement reads `derived_events: ['E0','E3']` (its own
   pointer event excluded), target superseded.
6. Plain SUPERSEDE: replacement has no list.
7. `forget({ eventId: 'E2' })` soft-deletes F from test 2 and its outbox
   DELETE row exists; a sibling with pointer E2 and a sibling with neither
   behave as in forgetEventId tests 1-3; `dryRun` counts F.
8. Malformed `derived_events` text neither matches nor throws; a JSON
   object (not array) neither matches nor throws (guard pin).
9. Entity isolation: entity B's fact listing E2 survives
   `forget(A, { eventId: 'E2' })`.
10. Apply-time re-check: delete event E2's row between batch read and
    apply (hook the provider's `generateText`); the candidate from E2 is
    dropped, `source_event_gone` emitted, no fact or merge lands, the
    watermark still advances past the batch.
11. Dump round-trip: export → import on a fresh store restores the list;
    a pre-release dump (no key) leaves a stored list untouched; a malformed
    key imports null and emits `derived_events_invalid` with the fact id
    only.
12. OKF round-trip: frontmatter list emitted only when non-empty; parsed
    back exactly; a malformed value is dropped and reported with the
    `derived_events_malformed` slug and no raw value.
13. Outbox UPSERT payload of an in-place UPDATE carries the list.
14. Legacy parity: `librarianLegacyParity.test.ts` snapshot unchanged.
15. Growth: 200 merges from 200 events read, export and match correctly.
16. Public exports: new codes appear in `WikiDiagnosticCode`;
    `publicExports.test.ts` updated. (As landed: `publicExports.test.ts` was not
    touched; the vocabulary assertion is in `derivedEvents.test.ts`.)

## Open questions for Kurt
1. **Should `forget({ eventId })` delete facts that merely absorbed the
   event, by default?** Default: yes, same selector, no flag. Reason:
   D2 ruled the selector means "remove event X's traces from this entity",
   a merged fact is a trace, the engine cannot un-merge, and `dryRun`
   shows the count first.
   **Answer: yes (default accepted 2026-11-23).**
2. **Should a plain SUPERSEDE (no merged text) inherit the target's
   provenance?** Default: no. Reason: the replacement's text is the
   candidate's own extraction; the superseded target stays in the store
   with its own pointer and list and is matched directly.
   **Answer: no (default accepted 2026-11-23).**
3. **Keep the apply-time existence re-check (§3) in this PR?** Default:
   yes. Reason: it is one indexed `SELECT` and one diagnostic, closes the
   only race the engine's locks cannot, and is the seam the follow-up
   exclusion spec extends.
   **Answer: yes, keep the re-check (default accepted 2026-11-23).**
4. **Report dropped OKF `derived_events` values on the existing
   `dropped_pointer_values` list (with a reason slug) or a new field?**
   Default: reuse with slug. Reason: no second widening of `MemoryDump`
   for a content-free id list.
   **Answer: reuse the list with the slug (default accepted 2026-11-23).**
5. **Receipt name `librarian_updated` (heal-style) or the 2026-09-29
   spec's `fact_updated`?** Default: `librarian_updated`. Reason: the
   shipped heal receipts set the `<pass>_<verb>` convention; the older
   name was never built.
   **Answer: void. The receipt is not shipped here; step 13's `librarian_rewritten` / `librarian_superseded` cover it (Owner rulings 1).**


6. **INTENT edits in the implementing PR?** Default: one dated amendment
   noting (i) the glossary "Source pointer" entry gains a sentence naming
   `derived_events`, and (ii) a rule-12 note that the durable record
   of which events a rewritten fact absorbed now exists, with the live
   per-update receipts landing in roadmap step 13; no rule text changes. Reason: INTENT is the top authority and only the owner
   edits it; the spec does not presume.
   **Answer: yes (default accepted 2026-11-23); the amendment lands in this PR, citing PR #469.**


7. **Open the follow-up `forget-event-exclusion` spec now (as an issue)
   or wait for this PR to land?** Default: file the issue now, spec after
   this merges. Reason: it changes two ruled decisions and deserves its
   own stop; this PR's §3 seam is designed for it.
   **Answer: filed now as [#472](https://github.com/equationalapplications/expo-llm-wiki/issues/472); the spec follows after this merges.**


## Plan sketch

1. Schema + migration v18 + Rust pin + `parseStoredDerivedEvents` helpers;
   tests 1, 8 (helper-level).
2. `WikiFact.derived_events`, row mapper, both `upsert` paths (presence
   flag on import), outbox payload check; test 13.
3. `apply.ts` UPDATE-in-place writer + dedupe + unresolved-merge
   diagnostic; tests 2, 3, 4.
4. `apply.ts` UPDATE-as-SUPERSEDE inheritance; plain SUPERSEDE untouched;
   tests 5, 6.
5. Widened `EVENT_MATCH_SQL`; `forget` and dry-run inherit; tests 7, 9;
   re-run `forgetEventId.test.ts` unchanged.
6. Apply-time re-check + `source_event_gone`; test 10.
7. Dump export/import + `derived_events_invalid`; test 11.
8. OKF frontmatter emit/parse + dropped-value report; test 12.
9. Diagnostics guide, deleting-data, maintenance, okf, types, glossary,
   README; spec as-landed notes in the three referenced specs; tests 14,
   15, 16.
10. Cleanup commit: Status → Implemented, delete `plan.md`/`LEDGER.md`,
    `gh pr ready`.
