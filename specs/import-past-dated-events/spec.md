# Import: past-dated events behind the watermark are never read

**Status:** Reviewed (owner, 2026-11-11). Revision 2 was written after
the Opus spec review and Fable's decision memo; the owner then ruled on the
three §6 decisions and the open questions. Second half of #361. Depends on
#362 (`import-clamp-created-at`) and #358 (`ops-auto-first-batch`); both
must merge first, and the plan and ledger follow after they do.
**Date:** 2026-11-11
**Intent check:**
- **Charter rule 12** ("Your events become lasting memory") says events are
  "never deleted unconsolidated". Today a guarded prune deletes an
  imported event the librarian never read, which breaks that rule directly.
- **INTENT rule 6** (nothing dropped silently): today the event is lost
  with no diagnostic. The fix adds one.
- **INTENT rule 7** (no invisible spend): reading these events costs LLM
  calls. Under `deferred` that spend is budgeted by
  `runPendingMaintenance`; under `auto` it runs in the background like any
  other pass. §1's source-watermark rule keeps the spend to events that
  were never consolidated.
- **INTENT rule 11:** this changes maintenance behaviour (what the
  librarian reads and what prune keeps). It makes no accuracy or cost
  claim, so no benchmark is needed to ship it.

(Revision 2 corrects revision 1, which cited a "memory reflects what was
written" promise that INTENT does not contain, misquoted rule 6, and
claimed "no extra LLM cost".)

## The fix in plain words

The librarian keeps a **bookmark** (the watermark) of the last event it has
read. Events are read in `(created_at, id)` order, so anything at or before
the bookmark counts as already read.

A `merge: true` import adds events to an entity that already has a
bookmark. An imported event dated *before* the bookmark lands behind it and
is never read. The next prune then deletes it, because prune also treats
"behind the bookmark" as "already read".

The fix has two parts.
- **The bundle says what the source already read.** An export carries each
  entity's source bookmark. Events at or before it were consolidated on the
  source device, and their facts travel in the same bundle, so they need no
  second read.
- **Only events nobody has read are moved.** Those are the events after
  the source bookmark, or every event when the bundle has no bookmark.
  When such an event would land behind this store's bookmark, it is stored
  just after it, the same way #362 stores future-dated events. Its
  original date is kept in `occurred_at` (§1 step 4).

## Problem

- **Who hits it:**
  - Any `importDump(dump, { merge: true })` into an entity whose librarian
    has already run, when the bundle has events older than this store's
    bookmark. Examples: syncing from a second device, or restoring a
    partial backup into a live store.
  - **OKF merge imports, almost always.** `parseOkfBundle` dates every log
    event at midnight UTC of its log date
    (`packages/core/src/utils/parseOkfBundle.ts:529`) and sets no
    `occurred_at`. A same-day import therefore usually lands behind a
    bookmark set earlier that day. `okf.md` documents
    `importDump(dump, { merge: true })` as the OKF path.
- **Not affected:** `merge: false`. It deletes the checkpoint row, which
  holds the watermark, so the next pass re-reads the whole log.
- **What happens:**
  - The event is never extracted. There is no LLM call, no error and no
    diagnostic.
  - The next `runPrune` deletes it once it is older than the retention
    window. Under ops or deferred, the guarded prune deletes events at or
    behind the watermark. Under legacy + auto, the unguarded prune deletes
    by age alone. Either way the raw event is then gone.
- **Both strategies:** ops reads strictly after the watermark. Legacy
  reads the newest 50 events, so an old imported event is outside its
  window as well.

## Root cause (with evidence)

Line numbers are on `origin/main`.

1. `ImportExportService.doImportEntity` inserts each bundle event with its
   own `created_at` (`packages/core/src/services/ImportExportService.ts:415-426`).
2. Ops `selectBatch` reads `getAfter(entityId, wm)`
   (`packages/core/src/services/librarian/ops/extract.ts:40`), which uses
   `AFTER_SQL = (created_at > ?) OR (created_at = ? AND id > ?)`
   (`packages/core/src/repositories/EventRepository.ts:9`). An event at or
   before `wm` is never returned.
3. Legacy reads `getRecent(entityId, 50)`, newest first
   (`packages/core/src/services/librarian/legacy.ts:35`).
4. Under ops or deferred, `runPrune` uses `pruneThrough`, which deletes
   `created_at <= cutoff AND NOT AFTER wm`
   (`packages/core/src/repositories/EventRepository.ts:113-119`).
5. Export carries no watermark (`MemoryBundle`,
   `packages/core/src/types.ts`), so an importer cannot tell a
   consolidated event from an unread one.

**Reproduced on main (2026-11-11)** with a throwaway probe, then confirmed
independently by the Opus reviewer: 60 local writes, two `runLibrarian`
passes, a merge import of one event dated 2023, two more passes, then
`runPrune({ retainEventsFor: 30 })`.

| strategy | prompts after import | imported event extracted | prune deleted it |
|---|---|---|---|
| ops | 0 | no | yes |
| legacy | 2 | no (not in the newest 50) | yes |

## Options considered

**A. Re-stamp every inserted event behind this store's watermark.** This
was revision 1's recommendation; it is now §1's fallback only.
- *Against, as a default:* a full-store sync carries the source's facts as
  well as its events. A re-extracts every event the source had already
  consolidated, which costs LLM calls and creates duplicate candidates for
  the gate to resolve. Events that one device pruned also bounce: the
  other device sends them back, A re-stamps them, and they are extracted
  again. (Found by the Opus review.)

**B. Rewind the watermark** to just before the earliest imported event.
Every later local event is re-read: one import of a 2-year-old event
re-extracts two years of log. Rejected (rule 7).

**C. A pending-events side table** read alongside the watermark. This
needs a schema migration, a second read path for both strategies and a
prune rule for it. Too large.

**D. Export the source watermark; re-stamp only events the source never
read (recommended).** With A as the fallback when the bundle has no
watermark.
- *For:*
  - The LLM cost matches the work actually missing: only events that
    nobody consolidated are read.
  - Pruned events that bounce back are consolidated at their source and
    are inserted unchanged, so they are not read again.
  - No schema change. The bundle gains one optional field.
- *Against:*
  - Export shape grows (`MemoryBundle.librarian_watermark?`).
  - Old bundles and OKF fall back to A, with A's cost.

## Proposed change (option D)

### §1 Which events are re-stamped

In `doImportEntity`, merge mode only. The watermark read and seed happen
inside the import transaction, before the event loop.

1. **Local watermark.** Read it (#362 already does). If the entity has
   none but `memory_checkpoint > 0` (legacy history from before 7.8, never
   seeded), seed it now with the same rule as `seedLibrarianWatermark`,
   on the log *before* inserting.
   - This uses #358's version of the rule: a checkpoint above the event
     count writes the start-of-log marker, never the newest event.
   - It is not strategy-gated. Legacy stores need the watermark too, or
     the rest of §1 never applies.
   - *Ruled 2026-11-11 (§6, decision 2).*
2. **Source watermark.** `bundle.librarian_watermark`, when present and
   valid.
3. **Candidates:** inserted events that are
   - *after* the source watermark, or every inserted event when the bundle
     has none, **and**
   - *not after* the local watermark, under `(created_at, id)`.

   The start-of-log marker is not exempt. It goes through the same
   comparison, so an event below it would also be a candidate.
4. **Original date.** For a candidate with `occurred_at` null and an
   original `created_at` that passes `assertEpochMs` (a finite number
   >= 0), copy that value into `occurred_at` before re-stamping.
   - The ops event date is `occurred_at ?? created_at`
     (`ops/text.ts:12`). It becomes a fact's `valid_from`
     (`ops/extract.ts:85`). Without the copy, a fact from an old event is
     dated at import time.
   - Not done for #362's future-dated events, whose date is the bad one.
   - *Ruled 2026-11-11 (§6, decision 3).*
5. **Invalid dates.** Every inserted event whose `created_at` is
   non-numeric or non-finite is a candidate too, whether or not either
   watermark exists. This includes `-Infinity`, which #362 §3 handed to
   this spec. On main, `-Infinity` is stored as-is. It sorts first, and
   every ops pass then throws in `PromptService.ts:277`
   (`new Date(at).toISOString()`), so the entity's librarian stalls for
   good (Opus probe).
6. **Stamping.** Candidates and #362's future-dated events form one run,
   sorted by `(created_at, id)` with #362's `createdAtValue` comparator.
   It is stamped from #362's `floor + 1`, so no two tie and none
   interleave.
   - Invalid values sort first in the run.
   - Comparisons run in JS on that comparator, never in SQLite's ordering,
     where TEXT sorts after every number.

`merge: false` clears the local watermark, so only steps 5 and 6, and
#362's rule, apply.

### §2 Export

`getFullBundle` adds `librarian_watermark: { at, id }` per entity when one
exists, and omits it otherwise. `importDump` validates the field: `at`
must be a finite number and `id` a string. An invalid field is ignored,
and the importer falls back to A for that entity.

### §3 Prune

No change. A re-stamped event is after the local watermark, so
`pruneThrough` holds it until a pass reads it. Retention then counts from
its new `created_at`.

### §4 Legacy

- Re-stamped events sort among the newest, so the next legacy pass reads
  them, **up to its 50-event window**.
- A run larger than 50, plus any writes made before that pass, still loses
  the rest under legacy: the pass advances the watermark to the newest
  event, and the remainder is never read. This is legacy's general
  burst-loss limit (Opus probe: 120 re-stamped, 50 read, 70 pruned), and
  this spec does not fix it.
- Under ops the same run is read in full (120 of 120).
- The legacy prompt serializes raw event JSON, so it shows both the
  re-stamped `created_at` and `occurred_at`.

### §5 Diagnostic

New code `event_created_at_restamped`, severity `info`, operation
`importDump`, trigger `call`, `detail: { count, reason }` with `reason`
`'behind_watermark'` or `'invalid'` (§6, decision 1). #362's
`event_created_at_clamped` stays as it is for future dates. Adding a code is
a minor release (`feat`).
- it is emitted once per entity after the import transaction commits;
- it carries `count`, and `reason` where the code is shared;
- a duplicate id that is ignored is not counted;
- the future-dated, behind-watermark and invalid-date cases can be told
  apart.

## §6 Decisions (ruled by the owner 2026-11-11)

The options and reasons are kept below as the record.

**Rulings:**
1. **(b) A new code `event_created_at_restamped`, severity `info`.** A
   behind-watermark re-stamp is a normal part of multi-device sync. Putting
   it under #362's `warn` code, which flags real anomalies such as a broken
   clock, would cause alarm fatigue.
2. **Seed the watermark during import: approved.** It prevents the offset
   drift for legacy histories. Doing it inside the import lock is safe and
   follows #358's precedent.
3. **Copy the original `created_at` into a missing `occurred_at`:
   approved.** Losing the historical date in a routine re-stamp would make
   the resulting facts' `valid_from` useless.

**The options as presented:**

1. **Diagnostic code.** The two reviews disagree.
   - **(b) A new code `event_created_at_restamped`, severity `info`**
     (Fable). Severity and message are fixed per code, and hosts route on
     code and severity. A behind-watermark re-stamp happens on every
     ordinary sync, so under #362's `warn` code each sync would log a
     warning. #362's message ("dated in the future... stored with the
     current time") is also false here. This works in either merge order.
     It is a `feat` (minor).
   - **(c) Rename #362's code inside #362, before it merges** (Opus), for
     example `event_created_at_adjusted` with a direction-neutral message
     and `detail.reason: 'future' | 'behind_watermark' | 'invalid'`. One
     code covers one mechanism. The cost is one severity for both a bad
     clock and a routine sync, and the rename must land before #362 does.
   - (a), reusing `event_created_at_clamped` unchanged, is ruled out: its
     fixed message is wrong for this case.
2. **Seed the watermark during import** for legacy history with no
   watermark (§1 step 1). Both reviews recommend it.
   - Today, k past-dated imports into such an entity lose up to k events
     and re-read the same number of already-read ones: the seed offset
     shifts by k (Fable probe: 1→1, 3→3, 25→20 re-read).
   - #358 §1 set the precedent: anchor before the insert that would shift
     the offset. Import locks exclude librarian and prune, so there is no
     race.
3. **Copy the original `created_at` into a missing `occurred_at`** for
   behind-watermark re-stamps (§1 step 4). Both reviews recommend it.
   - It changes `valid_from` on the resulting facts, not just the display.
   - It matches the documented meaning of `occurred_at`, real-world time.
   - It keeps the real date across the next sync hop.
   - Cost: a filled-in `occurred_at` cannot be told from a caller-supplied
     one.

## Open questions

**Ruled 2026-11-11 (owner):**
- Question 1: OKF must derive deterministic ids. Fast-follow, tracked as
  #365.
- Question 2: the default `valid_from` becomes the newest date in the
  batch. Separate fix, tracked as #366.
- Question 3: #358 is a hard prerequisite, as stated.

The questions as raised:

1. **OKF logs without id comments** get a fresh id on every parse
   (`parseOkfBundle.ts:533`, `generateId('evt_')`). Re-importing the same
   hand-written log therefore inserts duplicate events, as it does today.
   Under the A fallback, each duplicate would also be re-stamped and
   extracted. Should OKF derive deterministic ids, for example from date
   plus summary, as a prerequisite, or should id-less OKF events be
   excluded from re-stamping?
2. **Default `valid_from` in an ops batch.** `extract.ts:74` uses the last
   event's date for facts without a `source_event` label. With a re-stamped
   run at the end of a batch, that is an old real date, applied even to
   facts drawn from today's local events. Should the default become the
   maximum date in the batch? This is a separate fix, but this spec makes
   it more likely.
3. **The `write()` window before #358.** Without #358, a `write()` within N
   ms of a stamped run can sort inside it. N is now the size of the run,
   potentially thousands of events. With #358 as a hard prerequisite this
   case disappears, which is one reason the dependency is required.

## Files touched (expected)

- `packages/core/src/services/ImportExportService.ts`: §1, §2.
- `packages/core/src/types.ts`: `MemoryBundle.librarian_watermark?` and
  the `event_created_at_restamped` code.
- `packages/core/src/utils/diagnostics.ts`: its severity (`info`) and
  message.
- `packages/core/src/services/MaintenanceService.ts`: expose the seed rule
  to `ImportExportService` (today it is private).
- Docs: `apps/docs/src/content/docs/guides/diagnostics.md`, the
  maintenance guide's import notes, and the import/export or OKF guide for
  the new bundle field.
- `packages/core/__tests__/importPastDatedEvents.test.ts`.

## Test plan

1. Merge import of an event older than the local watermark, bundle with no
   source watermark: ops extracts it on the next pass (the probe,
   inverted).
2. The same under legacy, with 50 or fewer events.
3. A prune after the import does not delete it before a pass reads it.
4. **Source watermark:**
   - a full-store sync from device A to device B re-stamps only A's
     unconsolidated events;
   - the LLM extract-call count covers only those;
   - no duplicate facts result.
5. **Bounce:** an event pruned on A and sent back from B is inserted
   unchanged and not re-extracted.
6. **OKF-parsed merge bundle:** midnight-UTC dates and null `occurred_at`;
   the event is read and `occurred_at` holds the original date.
7. `-Infinity`, `NaN` and non-numeric `created_at`, with no watermark: the
   value is re-stamped and counted, and the librarian does not throw.
8. **Legacy history, no watermark** (`memory_checkpoint > 0`): the seed
   during import means no import is lost and no read event is re-read.
9. A repeated identical merge import re-stamps nothing, and the
   diagnostic count is 0.
10. Past, future and invalid dates in one bundle: one ordered run, no ties.
11. `merge: false`, and the start-of-log marker: only steps 5 and 6 and
    #362's rule apply.
12. An event after the local watermark but before now is stored unchanged.
13. Legacy with more than 50 re-stamped events: document the loss (§4),
    asserting today's behaviour.
14. `event_created_at_restamped` fires once per entity, `info`, with the
    right `count` and `reason`. #362's `event_created_at_clamped` still
    covers only future dates.
