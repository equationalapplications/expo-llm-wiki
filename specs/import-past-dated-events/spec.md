# Import: past-dated events behind the watermark are never read

**Status:** Draft. Second half of #361. Builds on #362
(`import-clamp-created-at`), which must merge first.
**Date:** 2026-11-11
**Intent check:** This is a data-loss fix. INTENT's promise that memory
reflects what was written covers imported events too, and rule 6 (honest
reporting) requires a diagnostic for every changed row. No retrieval or
ranking logic changes, so rule 11 does not apply. Whether this ships as
`fix` or `feat` depends on the diagnostic decision in §4.

## The fix in plain words

The librarian keeps a **bookmark** (the watermark) of the last event it has
read. Events are read in `(created_at, id)` order, so anything that sorts
at or before the bookmark counts as already read.

A `merge: true` import adds events to an entity that already has a
bookmark. An imported event dated *before* the bookmark lands behind it,
so it is never read. The next prune then deletes it, because prune also
treats "behind the bookmark" as "already read".

The proposed fix: when a merge import inserts an event that would sort at
or before the bookmark, store it just after the bookmark instead, the same
way #362 stores future-dated events. Its `occurred_at` (when it really
happened) is kept, and the librarian prompt shows that date.

## Problem

- **Who hits it:** any `importDump(dump, { merge: true })` into an entity
  whose librarian has already run, when the bundle has events older than
  the newest event that was read. Syncing from a second device and
  restoring a partial backup into a live store both do this.
- **Not affected:** `merge: false`. It deletes the checkpoint row, which
  holds the watermark, so the next pass re-reads the whole log.
- **What happens:**
  - The event is never extracted. There is no LLM call for it, no error
    and no diagnostic.
  - The next `runPrune` deletes it once it is older than the retention
    window. The guarded prune deletes events at or behind the watermark,
    so it treats the unread import as read. The raw event is then gone
    too.
- **Both strategies:** ops reads strictly after the watermark. Legacy
  reads the newest 50 events (`getRecent(entityId, 50)`), so an old
  imported event is outside its window as well.

## Root cause (with evidence)

1. `ImportExportService.doImportEntity` inserts each bundle event with its
   own `created_at` (`ImportExportService.ts:415-426` on main).
2. Ops `selectBatch` reads `getAfter(entityId, wm)`, which is
   `AFTER_SQL = (created_at > ?) OR (created_at = ? AND id > ?)`
   (`EventRepository.ts:9`, `ops/extract.ts:40`). An event at or before
   `wm` is never returned.
3. Legacy `runLegacyLibrarianPass` reads `getRecent(entityId, 50)`
   (`librarian/legacy.ts:35`), ordered `created_at DESC`.
4. Under ops or deferred, `runPrune` uses `pruneThrough`: `created_at <=
   cutoff AND NOT AFTER wm` (`EventRepository.ts:115-121`). The import is
   behind `wm`, so it is deleted.

**Reproduced on main (2026-11-11)** with a throwaway probe: 60 local
writes, two `runLibrarian` passes, then a merge import of one event dated
2023 and two more passes, then `runPrune({ retainEventsFor: 30 })`.

| strategy | prompts after import | imported event extracted | prune deleted it |
|---|---|---|---|
| ops | 0 | no | yes |
| legacy | 2 | no (not in the newest 50) | yes |

## Options considered

**A. Re-stamp on import (recommended).** In merge mode, an inserted event
that sorts at or before the watermark is stored at `floor + 1 + i`, using
#362's `floor` (`max(now, watermark)`) and the same `(created_at, id)`
order. #362's helper already computes this for future-dated events; this
widens the set it applies to.
- *For:* one code path, no schema change, no extra LLM cost. The event is
  read on the next pass under both strategies, and prune keeps it until
  it ages out from its new `created_at`.
- *Against:* `created_at` no longer matches the bundle. This fits its
  meaning, "when this store received the event", and `occurred_at` keeps
  the real date. Re-export is not byte-identical, which #362 already
  accepts for future dates.

**B. Rewind the watermark** to just before the earliest imported event.
- *For:* stored data is untouched.
- *Against:* every event after that point is re-read. One import of a
  2-year-old event re-extracts two years of log: real LLM spend
  (INTENT rule 7), with the gate deduplicating the results. Rejected.

**C. A pending-events side table** that the librarian reads alongside the
watermark.
- *For:* precise, and timestamps stay untouched.
- *Against:* a schema migration, a second read path for both strategies,
  and a prune rule that must also respect it. Too large for the problem.

## Proposed change (option A)

### §1 Which events are re-stamped

In `doImportEntity`, after the watermark read that #362 adds:

- **Merge mode with a watermark:** every inserted event that is *not*
  `AFTER wm` under `(created_at, id)`. These are the events behind the
  bookmark.
- Together with #362's future-dated set, one sorted run is stamped from
  `floor + 1`. Past and future imports never tie or interleave.
- **No watermark, or the start-of-log marker (#358):** nothing behind the
  bookmark exists, so only #362's rule applies.
- **`merge: false`:** the watermark has been cleared, so this is a no-op.

### §2 Prune

No change. A re-stamped event is after the watermark, so `pruneThrough`
holds it until a pass reads it. Retention then counts from the new
`created_at`.

### §3 Legacy

Re-stamping puts the event among the newest, so the next legacy pass
(newest 50) reads it. No legacy code change.

### §4 Diagnostic (open decision)

Options:
- **(a) Reuse `event_created_at_clamped`** from #362, adding
  `detail.reason: 'future' | 'behind_watermark'`.
  `WikiDiagnosticDetail.reason` already exists as a machine-readable
  sub-reason.
- **(b) A new code `event_created_at_restamped`.** This is a `feat`.
- **(c) Rename #362's code to something general** such as
  `event_created_at_adjusted` before #362 is released, and use `reason`
  for both. This is only possible while #362 is unreleased.

Recommendation: (a) if #362 has shipped, otherwise (c). Either way, one
code covers one idea: "import changed `created_at`, here is why".

## Open questions

1. **Legacy history with no watermark yet.** An entity that legacy
   processed before 7.8 and that no pass has seeded since has
   `memory_checkpoint > 0` and no watermark. The first ops pass seeds at
   offset `memory_checkpoint - 1`. A past-dated import shifts that offset
   by one: the seed lands one event earlier, and the import sorts before
   it, so it is skipped. Should §1 also re-stamp events that sort inside
   the first `memory_checkpoint` events when there is no watermark? Or is
   seeding the watermark during import (as `seedLibrarianWatermark` would)
   cleaner?
2. **Duplicates.** A bundle event whose id already exists is ignored as
   today and is not re-stamped or counted.
3. **`occurred_at` missing.** For an event without `occurred_at`, the
   prompt shows the re-stamped time. Should import copy the original
   `created_at` into `occurred_at` when it is null, so the real date is
   kept?

## Files touched (expected)

- `packages/core/src/services/ImportExportService.ts`: widen the stamped
  set.
- `packages/core/src/types.ts`, `utils/diagnostics.ts`: per §4.
- `apps/docs/src/content/docs/guides/diagnostics.md`, and the maintenance
  guide's import notes.
- `packages/core/__tests__/importPastDatedEvents.test.ts`.

## Test plan

1. Merge import of an event older than the watermark: ops extracts it on
   the next pass. This is the probe above, inverted.
2. The same under legacy.
3. A prune after the import does not delete it before a pass reads it.
4. Past and future events in one bundle: one ordered run, no ties.
5. `merge: false`, no watermark, and the start-of-log marker: nothing is
   re-stamped beyond #362's rule.
6. An event after the watermark but before now is stored unchanged.
7. Diagnostic count and reason per §4.
