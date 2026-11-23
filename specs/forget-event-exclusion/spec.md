# Forget-event exclusion — `events.forgotten_at`, so a forgotten event stops being raw material

**Status:** Draft
**Date:** 2026-11-23
**Issue:** [#472](https://github.com/equationalapplications/expo-llm-wiki/issues/472)
(split out of #450 / PR #469, `specs/inplace-update-provenance/` §7 "Split").
**Builds on:** PR #469 (schema v18, `derived_events`, the apply-time
existence re-check `source_event_gone`). This spec's PR branches from a
`main` that already carries a published release with v18.

**Intent check.** INTENT rule 13 is the rule this spec serves: "forget wins
over re-ingest" and "exports exclude forgotten rows" must hold for the one
row the engine can still re-read after `forget({ eventId })`: the event
itself. Rule 12: the librarian "may rewrite a fact the engine inferred
earlier, in place"; it must not do so from text the host asked it to
forget. Rule 2: one nullable column and one partial index on `events`, no
drop, no semantic change to an existing column. Rule 6: the one new signal
is content-free (an event id and a reason slug); nothing new is dropped
silently. Rule 7: no model call is added; an excluded event is excluded
*before* extraction, so it costs nothing. Rule 3: every query is entity
scoped. Rule 5 is untouched (documents and document facts are not involved).
The glossary's "Event — raw material" and "Forgotten — a fact ..." entries
stop being exactly true once an event row can be forgotten; that is an
INTENT amendment and is Open question 7, not something this spec presumes.

**Two ruled decisions change.** This spec amends ruled text in two shipped
specs. The exact text and the replacement are in §Amendments below; the
owner approves them or this spec does not proceed.

## Problem

After `forget({ eventId: E })` the host has said "remove event E's traces
from this entity" (forget-by-event-id D2). PR #469 makes every fact that
rests on E findable and deletes them whole. The event row itself is
untouched (D4), so:

1. If E is still ahead of the librarian watermark, the next pass reads it
   again (`EventRepository.getAfter`, `EventRepository.ts:213-227`, called
   from `ops/extract.ts:65`) and derives new facts and new merges from it.
   The host must repeat `forget({ eventId: E })` after every pass until
   prune removes E (`pruneThrough`, watermark guarded,
   `MaintenanceService.ts:497`); the deleting-data guide says so today
   (recipe step 2, `guides/deleting-data.md:164-172`).
2. Under the `legacy` strategy there is no watermark: the pass reads the
   newest 50 events on every run (`legacy.ts:40`), so E is re-read until
   `retainEventsFor` (default 30 days) deletes it.
3. E's text keeps reaching places that are not the librarian: `read()`
   bundles (`RetrievalService.ts:857-858`), the heal prompt's recent-events
   context (`MaintenanceService.ts:1813`), and every export
   (`ImportExportService.ts:206`), including non-backup ones.
4. `erase()` keeps every event by design (forget-erasure §2 step 1,
   `retainEventsFor: null`; ruling D), so a host that has forgotten E and
   then erases still has E's text in the file, and the only engine path to
   remove one subject's events is the whole-entity wipe
   `clearAll({ includeEvents: true })`.

The host asked for one thing and the engine honours it only on the fact
side. This spec closes the event side.

## Root cause (with evidence)

- The `events` table has no tombstone column (`db/schema.ts:126-134`):
  `id, entity_id, event_type, summary, related_entry_id, created_at,
  occurred_at`. Facts and tasks have `deleted_at`; events can only be
  present or hard-deleted.
- Every event read is unconditional on the row's state. Content reads:
  `getRecent` (`EventRepository.ts:94-100`), `getRecentForEntities`
  (`:106-114`), `getByEntityId` (`:191-204`), `getAfter` (`:213-227`),
  `findExistingIds` (`:76-88`). Count reads that drive scheduling:
  `countAfter` (`:235-243`), `sumSummaryCharsAfter` (`:268-277`),
  `countHeldBack` (`:152-159`).
- `forget({ eventId })` touches only `entries`
  (`MaintenanceService.ts:1336-1343`, `softDeleteByPointerEvent`). D4 ruled
  "events table rows — untouched and never rewritten".
- Prune deletes events only by age and, under ops/deferred, only at or
  before the watermark (`MaintenanceService.ts:490-499`). `erase()` passes
  `retainEventsFor: null` and skips the event block entirely
  (`MaintenanceService.ts:614, 630`); its entity walk and its step-9 gate
  look at `entries` and `tasks` only (`MetadataRepository.ts:222-226`,
  `MaintenanceService.ts:755-757`).
- The in-flight race the issue names is real for one class of host. Inside
  one `WikiMemory` instance `forget` and the librarian exclude each other
  (`JobManager.ts:291-296`: forget is refused while the entity's librarian
  lock is held; `:232-240`: and vice versa), so an in-process forget always
  observes a finished pass. The `JobManager` is in-memory and per instance:
  a second process or a second `WikiMemory` on the same file, or host SQL,
  can forget between a pass's batch read (`extract.ts:65`) and its apply
  transaction (`apply.ts:88`). The §3 re-check of PR #469 was written so
  "gone" can become "gone or forgotten" in one predicate; today it only
  tests existence (`apply.ts:204-205`).

## Options considered

| | (a) `events.forgotten_at` marker, skipped by content reads, pruned unguarded, erased | (b) Hard-delete the event row in `forget({ eventId })` | (c) Pass-abort / pending-erasure set in memory |
|---|---|---|---|
| INTENT fit | Rule 13 direct: forgotten rows leave reads and non-backup exports; rule 12 vocabulary (forgotten → gone) applies to the row | Breaks forget-erasure's "guaranteed at erase-time, not forget-time" scoping; a hard delete is a hard delete the host cannot dry-run back | Rule 7 fine; lost on restart; useless under `'deferred'`; closes nothing already stored |
| Schema (rule 2) | One nullable column + one partial index, v19 | None | None |
| Re-consumption | Stopped at the batch read, before any spend; closed cross-process by the re-check | Stopped; but a pass in flight already read the text and the re-check sees "gone", indistinguishable from host SQL | Only in-process |
| Erase | `erase()` takes the row to gone with the forgotten facts; the step-9 gate counts it | Already gone; text recoverable from the file until the next erase anyway | n/a |
| Export/import | Backup dump carries the marker; tombstone-wins on import (rule 13) | A dump taken before the forget resurrects the event (same as today) | n/a |
| Legacy watermark seeding | Positional reads unchanged (row stays in the log) | Offsets shift under the memory checkpoint (`legacyWatermark.ts:20, 45`) | n/a |
| Semver | minor | minor | minor |

**Recommendation: (a).** It is the fact-side design (`deleted_at`) applied
to events, it reuses the prune and erase machinery the owner already ruled
on, and it is the only option that makes the deleting-data recipe's
"repeat after every pass" sentence go away honestly. (b) is rejected: it
would be the first forget path that hard-deletes, and the forget-erasure
spec's erasure scoping was ruled around soft delete. (c) was already
rejected in PR #469's options table and is listed only for completeness.

## Proposed change

### 1. Schema: `events.forgotten_at`, migration v19

`events.forgotten_at INTEGER` (nullable, epoch ms; NULL = live). Migration
**v19**, in its own exported, idempotent, PRAGMA-guarded helper
`addEventsForgottenAtColumn` (the v16/v18 pattern,
`migrations.ts:493-498`), plus `createEventsForgottenIndex`:
`CREATE INDEX IF NOT EXISTS ${prefix}events_forgotten_idx ON
${prefix}events(entity_id, forgotten_at) WHERE forgotten_at IS NOT NULL`,
created by v19 and the fresh-store path only (the `createEntriesDeletedIndex`
pattern, `migrations.ts:480-485`), so a `migrations: 'refuse'` open defers
its build. The every-open DDL in `schema.ts:126-134` gains the column.
No backfill: no row is forgotten before this release. (Open question 8 on
the index.)

Why v19: PR #469's v18 body is closed by the 2026-11-23 owner ruling
("If a published release ever contains v18 before all three land, the
later changes go in v19"); this spec lands after that release.

Rust: `crates/graphrag-core/src/schema_check.rs:20` `REQUIRED_SCHEMA_VERSION`
18 → 19 in the same PR (`tests/schema_parity.rs` fails otherwise). The
crate reads no event column (`grep -rn events crates/graphrag-core/src`
hits only `derived_events`), so nothing else changes there. `Cargo.lock`
and the toolchain pin are untouched.

Hot-path cost: the existing index `events_entity_idx(entity_id,
created_at DESC)` still drives every content read; `forgotten_at IS NULL`
is a residual filter on rows the scan already visits. No read gets a new
index.

### 2. Writer: `forget({ eventId })` sets the marker

Inside the existing forget transaction, beside the entry soft-delete
(`MaintenanceService.ts:1336-1343`):

```sql
UPDATE ${prefix}events SET forgotten_at = ?
 WHERE entity_id = ? AND id = ? AND forgotten_at IS NULL
```

`EventRepository.markForgotten(entityId, eventId, now, tx): Promise<0 | 1>`.
Entity scoped (rule 3): an event id that belongs to another entity changes
nothing. Idempotent: a second call changes nothing and reports 0. An event
already pruned changes nothing; the fact side still runs, exactly as today.
`related_entry_id` is still never rewritten. No other row is touched: the
`clearAll`, by-source, by-id and chain branches do not set the marker, and
`includeEvents` keeps its hard-delete semantics (`eventRepo.deleteByEntityId`,
`:1279`, deletes forgotten and live rows alike).

Lock semantics are unchanged: `forget` still takes the entity's forget
lock and is refused with `WikiBusyError('librarian')` while a pass holds
the librarian lock. Nothing waits on a pass; the host retries as today.

**Reporting.** `ForgetResult.deleted.events` is present for the `eventId`
selector too, as `0 | 1` (today it is present only with `includeEvents`,
`types.ts:1574-1576`). `deleted.entries` keeps its meaning. The dry run
(`forgetDryRun`, `MaintenanceService.ts:1562-1565`) reports the same shape
with `countForgettable(entityId, eventId)` (0 or 1: the row exists and is
not yet forgotten). D8 stands: no forget diagnostics. (Open question 2.)

### 3. Reads: which skip the marker and which must not

Two classes, decided by what the read is *for*.

**Content reads skip forgotten rows** (`AND forgotten_at IS NULL`). The
text of a forgotten event must not reach a model, a host read, or a
non-backup export:

| Method (`EventRepository.ts`) | Caller | Why it must skip |
|---|---|---|
| `getAfter` `:213-227` | `ops/extract.ts:65` (ops batch) | the librarian's raw material; the whole point |
| `getRecent` `:94-100` | `librarian/legacy.ts:40` (legacy batch) | same, legacy strategy |
| `getRecent` `:94-100` | `MaintenanceService.ts:1813` (heal prompt context) | heal restates facts; forgotten text must not be in its prompt |
| `getRecent` `:94-100` | `RetrievalService.ts:857` (`read()` bundle) | host read of a forgotten row (rule 13 vocabulary) |
| `getRecentForEntities` `:106-114` | `RetrievalService.ts:858` | same, multi-entity |
| `getByEntityId` `:191-204` | `ImportExportService.ts:206` (`getFullBundle`) | exports exclude forgotten rows unless `includeForgotten`; gains `opts?: { includeDeleted }`, wired from the existing `incl` at `:198` |
| `findExistingIds` `:76-88` | `ops/apply.ts:205` (re-check) | becomes `findLiveIds`: exists **and** not forgotten (§4) |
| `countAfter` `:235-243` | `MaintenanceScheduler.ts:71, 198` | pending work the pass can consume; counting forgotten rows would report work no pass can do and keep a scheduler round open |
| `sumSummaryCharsAfter` `:268-277` | `WriteService.ts:158`, `MaintenanceScheduler.ts:72` | token-threshold estimate of the prompt actually sent |
| `countHeldBack` `:152-159` | `MaintenanceService.ts:518` (`event_retention_held`) | forgotten rows are not held *for the librarian*; §5 deletes them unguarded |

`LIMIT` is applied after the filter in `getAfter`/`getRecent`, so a pass's
batch is never shrunk by forgotten rows.

**Positional and ledger reads see every row.** The memory and heal
checkpoints are counts of rows in `(created_at, id)` order
(`WriteService.ts:131-146`, `MaintenanceScheduler.ts:73, 213`,
`legacyWatermark.ts:20, 45`), and prune lowers them by rows it deletes
(`MaintenanceService.ts:505-513`). Marking a row does not move it in the
log, so these stay unfiltered: `count` (`:178-185`), `getAtOffset`
(`:252-259`), `latestCreatedAt` (`:166-172`; the strictly increasing
`created_at` must consider forgotten rows or `write()` could reuse a
timestamp). The `clearAll` dry run's `count` (`:1553`) stays unfiltered on
purpose: `includeEvents` hard-deletes forgotten rows too, and the count
must say so.

Consequence to state plainly: in legacy auto mode, `count - memoryCheckpoint
>= threshold` (`WriteService.ts:146`) can trigger a pass whose filtered
batch is empty. The ops pass returns before any model call
(`ops/index.ts:48`, `sel.batch.length === 0`); the legacy pass sees
an empty `getRecent` and returns likewise. No spend.

**Watermark.** The watermark is a `(created_at, id)` position, not a
foreign key (PR #469 §3). A forgotten event in the middle of a batch is
simply not returned; the watermark advances to the batch's last *returned*
event, past the forgotten one. If every event after the watermark is
forgotten, `getAfter` returns nothing, the watermark stays, `countAfter`
reports 0, the scheduler closes the job (`MaintenanceScheduler.ts:189`,
`!r.processedThrough`), and §5 hard-deletes the rows without needing the
watermark to pass them.

### 4. Apply-time re-check: "gone or forgotten"

`apply.ts:204-205` calls `findLiveIds` (renamed from `findExistingIds`,
old name kept as an alias for tests): `SELECT id FROM events WHERE
entity_id = ? AND id IN (...) AND forgotten_at IS NULL`. A candidate whose
`sourceEventId` is not returned is dropped whole, as today. The diagnostic
stays `source_event_gone`; its `detail` gains `reason: 'gone' |
'forgotten'` (`WikiDiagnosticDetail.reason` already exists,
`types.ts:1042`). To tell the two apart the re-check issues the existence
query without the filter only for the ids that failed the filtered one
(zero extra work on the common path). (Open question 4.)

When this fires with `reason: 'forgotten'`: never from an in-process
`forget` (lock exclusion, §Root cause); only from a second instance or
host SQL between batch read and apply. The guide says so. With
`systemOne.typeOnWrite` engaged the dropped candidate has already spent
its classify call, as PR #469 §3 discloses; unchanged.

### 5. Prune and erase: forgotten events become gone

In `_runPrune`'s soft-deleted block (`retainSoftDeletedFor !== null`,
`MaintenanceService.ts:375-470`), inside the delete transaction beside
`taskRepo.bulkDeletePruned` (`:469`):

```sql
DELETE FROM ${prefix}events
 WHERE entity_id = ? AND forgotten_at IS NOT NULL [AND forgotten_at <= ?]
```

`EventRepository.deleteForgotten(entityId, cutoff, tx, { noCutoff })`.
The cutoff is the soft-delete cutoff (`now - retainSoftDeletedFor` days,
default 7); `softDeletedCutoff: 'all'` (erase) drops the predicate so a
TEXT-valued or future `forgotten_at` from an import cannot escape (same
reasoning as `:376-382`). **No watermark guard and no `retainEventsFor`
involvement**: the guard exists so the librarian can still read a row, and
a forgotten row is never read. The count is added to the returned `events`
and to `PrunePartialFailureError.deletedEvents`. No external hook is
involved (events have no vector rows and no outbox rows), so this delete
is never held.

Checkpoints: the deleted count lowers `memory` and `heal` exactly as the
event-retention block does (`:505-513`), in the same transaction. A
forgotten row is not necessarily a prefix of the log, so this can
over-decrement; over-decrement is the safe direction (re-read or re-heal,
never skip), and it is the same direction the existing clamps take
(`WriteService.ts:142`, `MaintenanceScheduler.ts:80`).

`erase()` changes in three places, all mechanical:

- step 1 already runs `_runPrune` with `retainSoftDeletedFor: 0,
  retainEventsFor: null, softDeletedCutoff: 'all'` (`:630`), so forgotten
  events are hard-deleted by erase with no new option; the comment at
  `:614` ("events are never deleted") becomes "events the host has not
  forgotten are never deleted";
- the entity walk `getDistinctEntityIds({ softDeletedAll })`
  (`MetadataRepository.ts:216-228`) and its `softDeletedAtOrBefore` variant
  (`:230-240`) gain `UNION SELECT entity_id FROM events WHERE forgotten_at
  IS NOT NULL [AND forgotten_at <= ?]`, so an entity whose only tombstones
  are events is walked;
- the step-9 gate (`:755-757`) adds `+ (SELECT COUNT(*) FROM events WHERE
  forgotten_at IS NOT NULL)`, so erase cannot report verified while a
  forgotten event's text is in the file. The diagnostic
  `erase_tombstones_remaining` keeps its name and its `count`.

Event text has no engine-side copies beyond facts (handled by
`forget({ eventId })`) and the database file surfaces erase already
zeroes; events are not in FTS and not in the outbox (verified:
`EventRepository.ts` has no outbox write). So the erase claim for a
forgotten event rests on the same `secure_delete` + checkpoint evidence as
for a fact.

### 6. Export, import, OKF

- `WikiEvent.forgotten_at?: number | null` (`types.ts:731-740`). Mapped
  only when non-null (`mapEvent`, `EventRepository.ts:21-28`, the
  `occurred_at` pattern), so `read()` bundles and prompt bytes are
  unchanged: a live event never carries the key.
- `exportDump()` without `includeForgotten` excludes forgotten events (rule
  13). With `includeForgotten: true` it includes them with `forgotten_at`
  set: a backup dump carries the instruction.
- `importDump`: the event literal forwards `forgotten_at`
  (`ImportExportService.ts:672-682`). Tombstone-wins parity with facts and
  tasks (`:394-405, 593-603`): a dump event with `forgotten_at` marks a
  live local row (`UPDATE ... SET forgotten_at = ? WHERE id = ? AND
  entity_id = ? AND forgotten_at IS NULL` after the `INSERT OR IGNORE`);
  a live dump event never clears a local marker (`INSERT OR IGNORE` leaves
  the local row as is, which is already the behaviour). A forgotten dump
  event with no local row is inserted with its marker and waits for prune,
  as a tombstoned fact does. The value is passed through unvalidated, as
  `deleted_at` is (`:501, 547`); erase's `noCutoff` path covers a
  non-numeric value. No new import result field. (Open question 6.)
- OKF: `buildEventLogEntries` (`formatOkfBundle.ts:196-224`) skips events
  with `forgotten_at` set. The log is a readable journal with no per-entry
  frontmatter, OKF is not the backup format, and an OKF export never
  carries a forgotten fact's text either beyond its tombstone row.
  `parseOkfBundle` needs no change: no OKF document ever carries the
  marker. (Open question 5.)

### 7. Honest reporting, summarised

- `ForgetResult.deleted.events` (0 | 1) with the `eventId` selector and in
  its dry run (§2). No new forget diagnostic (D8 stands).
- `source_event_gone` `detail.reason: 'gone' | 'forgotten'` (§4).
- `event_retention_held.count` no longer counts forgotten rows (§3).
- `runPrune` `events` and `PrunePartialFailureError.deletedEvents` include
  forgotten-event hard deletes (§5).
- `erase()` walks entities with forgotten events and its step-9 gate counts
  them (§5); the report shape is unchanged.
- `getRetentionPolicy()` is unchanged; the docs state that forgotten events
  follow `retainSoftDeletedFor`, not `retainEventsFor`.

### 8. What this spec does not do

- Does not forget events on `forget({ entryId })`, `forget({ sourceRef })`
  or `clearAll` without `includeEvents` (forget-erasure §Rejected: "Erasing
  events/outbox unconditionally on `forget({entryId})` breaks the
  librarian's rebuild-from-events contract").
- Does not add a pass-abort API or a cross-process lock. The re-check is
  the cross-process guard, and it is best-effort by nature: a pass already
  spent extraction on text that was live when read.
- Does not change what `clearAll({ includeEvents: true })` does.
- Does not give forgotten events outbox rows or a `reopen`-style undo.
  Forget is an instruction; prune executes it.
- Does not touch `events.related_entry_id` or any fact column.

## Amendments to ruled text (owner approval required)

### A. `specs/forget-by-event-id/spec.md` D4 and D6

Ruled text (D4, `:192-203`): "**events table rows** — untouched and never
rewritten (the `related_entry_id` column is left as written: tombstoning a
fact does not update event rows; the column has no FK and no repository
maintains it)". The as-landed note from PR #469 already says "Event rows
are still untouched; the follow-up `forget-event-exclusion` (issue #472) is
where that changes."

Replacement (dated as-landed note): "**events table rows** — the one row
whose `id` is the selector gets `forgotten_at` set (specs/forget-event-
exclusion §2); `related_entry_id` is still never rewritten and no other
event row is touched."

Ruled text (D6, `:222-226`): "`ForgetResult` is untouched; the count
reports in `deleted.entries` ... No new result field."

Replacement: "`deleted.events` (an existing optional field) is present with
the `eventId` selector as `0 | 1`: whether the event row itself was marked
forgotten. No new field." (Falls away if Open question 2 goes the other
way.)

Why: D4 was ruled when the only alternative was hard-deleting the row,
which the forget-erasure spec forbids at forget time. A soft marker is the
fact-side design applied to the one row the host named.

### B. `specs/forget-erasure/spec.md` ruling D and §2 step 1

Ruled text (ruling D, `:804-808`): "Documented **host-step carve-out**: the
guide names the `clearAll({ includeEvents: true })` full-wipe path and
`forget({ eventId })` (#386) as the prerequisite for any host claiming GDPR
erasure; events follow the host's `retainEventsFor` — each host publishes
its own value".

Replacement (dated note under ruling D): "Events the host has not forgotten
follow `retainEventsFor` and erase keeps them. An event the host forgot
with `forget({ eventId })` carries `forgotten_at`, follows
`retainSoftDeletedFor` like a forgotten fact, is hard-deleted by erase's
step 1 and counted by its step-9 gate (specs/forget-event-exclusion §5).
The full-wipe path stays the way to delete an entity's *unforgotten*
events on request."

Ruled text (§2 step 1, `:125-135`): "events are genuinely **kept** by
erase ... events are simply never deleted."

Replacement: "unforgotten events are kept by erase (`retainEventsFor:
null`); forgotten events are deleted by the same step through the
soft-delete retention block, with no hook and so no hold." The sentence
"erase has **no event holds to report**" stays true.

Why: ruling D framed events as either kept or wiped whole because the row
had no third state. With a marker, keeping a forgotten event through
`erase()` would make the erase report claim verification over text the
host asked to remove, which is the false success rule 13 forbids.

### C. INTENT (owner's edit, Open question 7)

Glossary "Event — raw material; the librarian turns them into facts" would
gain: "An event the host forgot with `forget({ eventId })` is no longer
raw material: it leaves reads and non-backup exports, no pass consumes it,
and prune then `erase()` take it to gone." Glossary "Forgotten — a fact the
host deleted ..." would name the event row too. No rule text changes.

## Files touched

Core (`packages/core/src/`):

- `db/schema.ts` — `forgotten_at INTEGER` on events.
- `db/migrations.ts` — v19: `addEventsForgottenAtColumn`,
  `createEventsForgottenIndex`; fresh-store path creates the index.
- `types.ts` — `WikiEvent.forgotten_at?`; `ForgetResult.deleted.events`
  JSDoc; `ForgetParams.eventId` JSDoc (marks the event; stops
  re-consumption); `source_event_gone` detail doc.
- `repositories/EventRepository.ts` — `forgotten_at IS NULL` on the ten
  content reads of §3; `getByEntityId(..., { includeDeleted })`;
  `findLiveIds`; `markForgotten`; `countForgettable`; `deleteForgotten`;
  `mapEvent` drops a null `forgotten_at`.
- `repositories/MetadataRepository.ts` — `getDistinctEntityIds` unions the
  events tombstones (both variants).
- `services/MaintenanceService.ts` — forget `eventId` branch and dry run
  (§2); prune soft-deleted block (§5); erase comment at `:614` and step-9
  gate (§5).
- `services/librarian/ops/apply.ts` — §4 re-check and `reason`.
- `services/ImportExportService.ts` — event literal forwards
  `forgotten_at`; tombstone-wins update.
- `utils/formatOkfBundle.ts` — skip forgotten events in the log.
- `utils/diagnostics.ts` — `source_event_gone` message names both reasons.

Rust: `crates/graphrag-core/src/schema_check.rs` (pin 19).

Specs: this file; dated as-landed notes in `specs/forget-by-event-id/spec.md`
(D4, D6) and `specs/forget-erasure/spec.md` (ruling D, §2 step 1, §6 docs
line); `specs/inplace-update-provenance/spec.md` §7 gets one line saying
the split landed.

Docs (`apps/docs/src/content/docs/`): `guides/deleting-data.md` (Forget
section `:35-40`: the event row is marked and no pass reads it again;
copy census item 1 `:133-136`; erasure recipe step 2 `:164-172`: the
repeat-after-every-pass sentence is removed and replaced with the
cross-process caveat; wipe section `:352-355`), `guides/maintenance.md`
(prune: forgotten events follow `retainSoftDeletedFor`; `event_retention_held`
excludes them), `guides/diagnostics.md:63` (`source_event_gone` reasons),
`reference/types.md:41-52` (`WikiEvent.forgotten_at`), `reference/glossary.md`
(Forgotten/Erase lines mention the event row). `docs/ROADMAP.md`: no
step; issue-driven work, as PR #469 was.

## Test plan

New `packages/core/__tests__/forgetEventExclusion.test.ts`, plus the named
existing files where a case belongs there.

1. Migration v19 adds the column and the partial index idempotently
   (`migrations.test.ts` derivation test passes with 19); fresh store has
   both; Rust `schema_parity` passes with 19.
2. `forget({ eventId: E })` sets `forgotten_at` on E only; a second call
   returns `deleted.events: 0` and changes nothing; an id from another
   entity changes nothing (rule 3); a pruned id changes nothing and the
   fact side still soft-deletes (`forgetEventId.test.ts` tests 1-3 still
   pass unchanged).
3. Dry run reports `deleted.events: 1` before and `0` after the real call,
   and mutates nothing.
4. Ops re-consumption: write E ahead of the watermark, `forget({ eventId:
   E })`, run the librarian: `generateText` is never called with E's
   summary; no fact names E in `source_pointer` or `derived_events`.
5. Mixed batch: events E1 (live), E2 (forgotten), E3 (live) after the
   watermark; the pass's prompt carries E1 and E3 only and the watermark
   lands on E3.
6. All-forgotten tail: only forgotten events after the watermark;
   `runPendingMaintenance` makes no model call, reports no pending events,
   and terminates (scheduler round closes).
7. Legacy strategy: `getRecent(50)` omits the forgotten event; the legacy
   prompt bytes for an all-live log are unchanged
   (`librarianLegacyParity.test.ts` snapshot unchanged).
8. Heal prompt context omits the forgotten event; `read()` bundle omits it
   (single and multi-entity).
9. Counts: `countAfter`, `sumSummaryCharsAfter`, `countHeldBack` exclude
   the forgotten row; `count`, `getAtOffset`, `latestCreatedAt` include it
   (pin the positional contract). `event_retention_held.count` excludes it
   (`pruneEventGuard.test.ts` extension).
10. Apply-time re-check, cross-process shape: mark E forgotten with direct
    SQL inside the `generateText` hook (the `derivedEvents.test.ts:315-333`
    fixture); the candidate is dropped, `source_event_gone` carries
    `reason: 'forgotten'`; the existing delete-row case carries `reason:
    'gone'`; the watermark still advances.
11. In-process lock: `forget({ eventId })` during a pass throws
    `WikiBusyError` naming `librarian` (pin, so the §4 "never in-process"
    claim stays true).
12. Prune: a forgotten event older than `retainSoftDeletedFor` is
    hard-deleted regardless of watermark and `retainEventsFor` (including
    `retainEventsFor: null`); a younger one is kept; `events` in the result
    counts it; memory and heal checkpoints are lowered; a TEXT-valued
    `forgotten_at` survives `runPrune` and is removed by `erase()`.
13. Erase: a store whose only tombstone is one forgotten event is walked,
    the row is gone, the step-9 gate passes; with the §5 gate change
    reverted in a test double, the gate fails (`erase_tombstones_remaining`,
    pin the honest failure). Canary: the event summary text is absent from
    the file after erase (the forget-erasure canary harness, single-fact
    tier, with `write()` as the seeding path).
14. Export/import: a dump without `includeForgotten` omits the row; with it
    the row carries `forgotten_at`; importing that dump onto a fresh store
    inserts the marked row and the librarian never reads it; importing a
    forgotten dump event onto a live local row marks it; importing a live
    dump event onto a forgotten local row leaves the marker
    (`export.test.ts` / `importEventStamps.test.ts` neighbourhood).
15. OKF: `formatOkfBundle` of a dump with a forgotten event omits it from
    `log.md`; a live log renders byte-identically to today
    (`formatOkfBundle.test.ts`).
16. `clearAll({ includeEvents: true })` deletes forgotten and live rows and
    its dry run counts both (`forgetWipe.test.ts` pin).
17. Public surface: `publicExports.test.ts` unchanged in count (no new
    export); `WikiEvent` type test for the optional key.

## Semver and release

MINOR. Additive column and index (rule 2), an optional field on
`WikiEvent`, an existing optional result field present in one more case,
an existing diagnostic's detail gaining a field. No `BREAKING CHANGE`
footer; no `"version"` or `CHANGELOG.md` edit. Rust pin bump rides the
same PR. One PR, draft until implemented, merge commit.

## Riskiest part

The checkpoint decrement in §5. Forgotten rows are not a log prefix, so
`memory`/`heal` can be lowered by more than the rows that were really
before them. The direction is safe (redundant work, never a skip) and the
existing clamps already accept this, but a reviewer should check the
legacy-mode threshold does not oscillate: after a decrement, `count -
memoryCheckpoint` grows by the number of forgotten rows deleted, which can
trigger one extra empty pass. Test 6 and 12 pin that this costs no model
call.

## Open questions for Kurt

1. **Approve amendments A and B (forget-by-event-id D4/D6; forget-erasure
   ruling D and §2 step 1)?** Default: yes. Reason: without them the
   engine honours `forget({ eventId })` on facts and keeps re-reading the
   event, and `erase()` reports verified over text the host asked to
   remove.
2. **Report the marker via `ForgetResult.deleted.events` (0 | 1) or a new
   field?** Default: reuse `deleted.events`. Reason: `deleted.entries`
   already reports soft deletes under "deleted", and D6's "no new field"
   stays almost intact.
3. **Retention window for forgotten events: `retainSoftDeletedFor`
   (default 7 days), immediate at the next prune, or `retainEventsFor`?**
   Default: `retainSoftDeletedFor`. Reason: rule 12 says prune turns
   forgotten into gone on the host's declared schedule, and that is the
   window the host declared for forgotten rows.
4. **Distinguish "forgotten" from "gone" with `source_event_gone.detail.reason`
   or a new code `source_event_forgotten`?** Default: the `reason` field.
   Reason: one code family for "the candidate's event is unavailable at
   apply time", and `reason` is an existing detail slot.
5. **OKF export: skip forgotten events, or carry a marker in `log.md`?**
   Default: skip. Reason: the log has no per-entry frontmatter, OKF is not
   the backup format, and the JSON dump carries the marker.
6. **Import tombstone-wins for events (a dump's forgotten event marks a
   live local row)?** Default: yes. Reason: rule 13 says an import honours
   a dump's deletion tombstones over live rows; facts and tasks already do.
7. **INTENT amendment C (glossary Event and Forgotten entries) in the
   implementing PR?** Default: yes, one dated amendment, no rule text
   change. Reason: INTENT edits are the owner's, and the glossary would
   otherwise say "raw material" about a row no pass may read.
8. **Add the partial index `events_forgotten_idx`?** Default: yes. Reason:
   it mirrors #443's `entries_deleted_idx`, serves the prune and erase
   probes, and is a few bytes per forgotten row.

## Plan sketch

1. Schema, v19 helpers, Rust pin; `mapEvent`; tests 1, 17.
2. `EventRepository` content-read filters, `findLiveIds`, counts; tests 7,
   8, 9.
3. `markForgotten`, `countForgettable`, forget branch and dry run; tests 2,
   3, 11.
4. Ops/legacy exclusion end to end; tests 4, 5, 6.
5. Re-check `reason`; test 10.
6. Prune `deleteForgotten` and checkpoint decrement; erase walk and gate;
   tests 12, 13, 16.
7. Export/import/OKF; tests 14, 15.
8. Docs, as-landed notes, INTENT amendment (if approved).
9. Cleanup commit: Status → Implemented, delete `plan.md`/`LEDGER.md`,
   `gh pr ready`.
