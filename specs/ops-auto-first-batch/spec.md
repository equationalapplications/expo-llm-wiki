# ops + auto: the first auto pass skips the events that triggered it

**Status:** Implemented (PR #358). §4 (prune keeps the counter in step) was
added after the second review and ruled 2026-11-10. §5 (`created_at` strictly
increases) was added after the fourth review and CodeRabbit. Both ship in
the same PR. The §4 busy-rollback bullet, the §4 `heal_checkpoint` revision and
the §5 safe-integer guard were added after the fifth review (2026-11-11).
**Date:** 2026-11-10
**Intent check:** This is a data-loss bug fix inside the engine. It changes
no public API, no default and no prompt. INTENT's promise that memory
reflects what was written is the one being restored. The shipped default
(ops + deferred) is not affected, so this is a `fix(core)` patch release
with no rule-11 claim.

## The fix in plain words

The ops librarian keeps a **bookmark** (the watermark) of the last event it
has read. The first time ops runs on an entity, it has no bookmark, so it
makes one. On a database that used the legacy librarian before, it puts the
bookmark where the legacy counter (`memory_checkpoint`) says legacy stopped,
so ops does not re-read what legacy already read.

In `maintenance: 'auto'`, the write that crosses the threshold **moves the
legacy counter forward first** (to 20) and only then starts the pass. The
pass finds no bookmark, reads the counter, concludes "legacy already read 20
events", and puts the bookmark after event 20. Events 1–20 are never read.

**The fix:** when an auto write triggers the first ops pass, set the
bookmark *before* moving the counter. If there is legacy history, the
bookmark goes where legacy stopped, as today. If there is none, write an
explicit "start of the log" bookmark instead of leaving it empty. An empty
bookmark is what lets the pass misread the already-advanced counter.

## Problem

- **Who hits it:** any entity with no ops watermark yet, under
  `librarian.strategy: 'ops'` and `maintenance: 'auto'`. That covers both a
  fresh entity and one the legacy librarian had already processed, for
  example a pre-7.8 entity upgraded to 8.x. The 8.0.0 upgrade warning
  that suggests setting `maintenance: 'auto'` to keep the old threshold
  behaviour puts such an entity on exactly this path. (The other warning,
  which suggests pinning `strategy: 'legacy'`, keeps it on legacy, which is
  not affected.) (Corrected 2026-11-10 after the
  #358 review. The first draft said fresh entities only.) ops has been
  opt-in since 7.8.0 and the default strategy since 8.0.0. Its default
  maintenance is `'deferred'`, which is unaffected.
- **What happens:** the first triggered batch is never extracted. That is
  the first `autoLibrarianThreshold` events (default 20), counted from
  where the legacy librarian stopped if it ran before.
  - No LLM call is made, and no error or diagnostic is raised.
  - A later explicit `runLibrarian` does not recover them, because the
    bookmark is already past them.
  - Both auto triggers hit it: the event count (`WriteService.ts:115`) and
    the token threshold (`:126`).

## Root cause (with evidence)

Line numbers below refer to the code before this PR (parent of `349067e3`).

1. `WriteService.write`, inside the trigger transaction, sets
   `memory_checkpoint = count` (`packages/core/src/services/WriteService.ts:115`
   and `:126`), then starts `runLibrarianThenMaybeHeal`.
2. `runOpsLibrarianPass` calls `deps.seedWatermark(entityId)`
   (`services/librarian/ops/index.ts:31`).
3. `MaintenanceService.seedLibrarianWatermark`
   (`services/MaintenanceService.ts:760-768`) finds no watermark and
   `memory = 20`. It anchors the watermark at the 20th event.
4. `selectBatch` (`ops/extract.ts:34`) asks for events after the 20th.
   There are none, so the pass returns with no LLM call.
   `runLibrarianThenMaybeHeal` then confirms checkpoint 20.

Evidence:
- `packages/benchmarks/__tests__/promptVolume.test.ts` (PR #357), config
  ops-auto: the first extract prompt starts at event 21, and `eventsSeen`
  is 40 of 56.
- Reproduced with the real clock outside the determinism harness: after 25
  writes, no extract call was made and the watermark sat at event 20.
- Confirmed independently by both PR #357 reviewers.

Why no test caught it:
- `librarianWatermark.test.ts` tests seeding with a hand-set checkpoint,
  never through an auto-triggered write.
- No core test runs ops with auto maintenance end to end.

## Proposed change

### §1 Anchor the bookmark before the trigger moves the counter

- **Where:** in `WriteService.write`, inside the trigger transaction.
- **When:** only when the resolved librarian strategy is `'ops'` and no
  watermark exists. On the count path, the anchor runs only when a pass is
  about to be triggered. On the token path, it runs before the character
  sum, on every non-blocked write that reaches that path, whether or not
  the write triggers a pass. Without a watermark the sum would count
  events legacy already read and fire a pass early. An anchor written by a
  non-triggering write is the same one the trigger would write later, so
  the outcome is unchanged.
- **What:** anchor the watermark *before* `updateCheckpoint(memory: count)`:
  - **The pre-trigger `memory_checkpoint` is > 0** (legacy history): anchor
    exactly as `seedLibrarianWatermark` does today, at the event at offset
    `min(checkpoint, total) - 1`.
  - **It is 0** (no history): write the start-of-log marker
    `START_OF_LOG_WATERMARK = { at: Number.MIN_SAFE_INTEGER, id: '' }`.
  - A checkpoint above the event count is clamped to 0 by `WriteService`,
    for example one an older version's prune left behind (§4). It
    therefore gets the
    marker: the first pass re-reads the log, and the gate dedups what
    already exists. It re-reads; it never skips.
- **Why the marker is safe:** `AFTER_SQL` treats it exactly like "no
  watermark" for every `created_at`. That includes the zero or negative
  values that an import or an OKF bundle with pre-1970 dates can carry;
  `write()` itself only produces positive values. `sumSummaryCharsAfter`,
  `countAfter`, `pruneThrough` and `countHeldBack` all read it the same
  way. (Revised 2026-11-10 after the #358 review. The first draft used
  `at: 0`, which skipped, and could prune, events at or below 0.)
- **Token trigger.** Under ops, the token path anchors *before* summing
  characters after the watermark. Otherwise, with legacy history and no
  watermark yet, the sum would include events legacy had already read and
  fire a pass early.
- **Transaction:** the anchor's reads and write run on the trigger's
  transaction, so they commit or roll back with the counter move.
- **Implementation:** a new package-internal method, e.g.
  `MaintenanceService.anchorWatermarkBeforeTrigger(entityId, preCheckpoint, tx)`,
  or the same logic inline. The builder chooses; neither is public.

### §2 Leave everything else as it is

- `seedLibrarianWatermark` keeps its contract: it is still a no-op at
  checkpoint 0, and the existing tests stay valid. It still covers explicit
  `runLibrarian` calls and deferred drains, where the counter is not moved
  before the pass.
- The pass's own `seedWatermark` call becomes a no-op on the auto path,
  because a watermark now exists.
- Rollback on a failed pass is unchanged. The checkpoint returns to its
  pre-trigger value, and the anchored bookmark stays where it was put. That
  is correct, because nothing past it was processed.
- The read path does not change. Legacy and deferred maintenance change
  only as §4 describes: prune now lowers a non-zero `memory_checkpoint`.

### §3 Already-affected entities

The fix cannot tell a bookmark this bug misplaced from a correct
legacy-migration bookmark, so it repairs nothing automatically. Affected
entities (running ops + auto on 7.8.0 or later, both new entities and
entities upgraded from legacy) have lost their first
`autoLibrarianThreshold` events from memory. The raw events are still in
the event log unless pruning has removed them.

**Ruled 2026-11-10 (owner): document only.** No reset API and no automatic
repair. Affected users are told what happened and what to do:

- **The `fix(core)` commit body** states the impact: which configs are
  affected, since 7.8.0, which events are lost, and that they remain in
  the event log unless pruned. semantic-release carries the body into the
  release notes; nobody edits `CHANGELOG.md` by hand.
- **`apps/docs/src/content/docs/guides/maintenance.md` gains a short
  "Known issue fixed in <next patch>" note** with the same facts and the
  remedy: call `write()` again for the affected events after upgrading.
  Re-ingesting does not help, because `ingest()` writes no events. The heading names the version
  generically ("the release that fixes this"), because the number is
  computed at release time.

### §4 Prune keeps the counter in step

**Found by the second #358 review; ruled 2026-11-10 (owner): fix at the
source.**

`memory_checkpoint` is a count: "the oldest N events in the log are
accounted for." Prune deletes the oldest events but never lowers it, so
afterwards the count points past events no pass has read. Two things read
that count as an offset into the log, and both then skip events:

- the §1 anchor, on the first auto trigger after a switch to ops;
- `seedLibrarianWatermark`, on an explicit `runLibrarian` or a deferred
  drain after the switch.

Example: legacy + auto, 20 events, checkpoint 20. Prune deletes the 5
oldest. The checkpoint stays at 20 while the log holds 15. Switch to ops
and write 5 more. The anchor lands on offset 19, which is now the 5th new
event, so those 5 events are never extracted. With §1 alone, events lost
in this case equal the number pruned. Before §1 the whole batch was lost.

**The change.** `runPrune` deletes events and lowers the checkpoint in one
transaction:

- `memory_checkpoint` becomes `max(0, checkpoint - deleted)`. Both prune
  queries (`prune` and the watermark-guarded `pruneThrough`) delete a
  prefix of the log in `(created_at, id)` order, and the checkpoint counts
  a prefix of the same order, so every deleted event was inside it, up to
  the checkpoint itself.
- This applies on both prune branches. On the guarded branch (ops, or
  deferred) it keeps the ops + auto trigger on time after a prune;
  without it, the next pass waits for one extra event per pruned event.
- The watermark read and the delete move into the same transaction, so a
  concurrent write's trigger cannot interleave between them.
- `heal_checkpoint` is also a count and drifts the same way, but drift
  there only delays or advances a heal pass; no events are lost. It is
  left unchanged and noted as a follow-up. (Revised 2026-11-11 after the
  fifth review: drift above the event count reads as 0 and starts a full
  re-heal after every prune, so prune now lowers `heal_checkpoint` the
  same way, `max(0, heal - deleted)`, in the same transaction. An unset
  `heal_checkpoint` stays unset.)
- **The busy rollback undoes a delta, not a value** (added 2026-11-11
  after the fifth review). When the trigger's lock is busy, `write()` used
  to restore the absolute pre-trigger checkpoint. A prune that took its
  lock first can lower the counter in between, and the absolute restore
  overwrote that. The rollback now subtracts only what the trigger added,
  `max(0, current - (count - preTrigger))`, in one transaction.

**Behaviour change for legacy.** Before, a prune under legacy + auto left
the checkpoint above the event count, so `WriteService` read it as 0 and
the next pass re-read the newest events. Now the next pass reads only
events written after the prune. The re-read was redundant: legacy had
already processed those events.

### §5 `created_at` strictly increases per entity

**Found by the fourth #358 review and by CodeRabbit, 2026-11-10. The bug is
on main too.**

The ops watermark and every ops read order events by `(created_at, id)`.
`write()` stamped `created_at = Date.now()`, and ids are random, so a new
event could sort at or before an event that already exists:

- **Two events in the same millisecond.** A pass's watermark is its
  batch's newest event. An event written in the same millisecond, after
  the batch was selected, with a smaller id, sorts behind that watermark
  and is never extracted. The reviewer lost 0–16 of 40 events this way
  with back-to-back writes during a pass, every loss a same-millisecond
  tie. main loses them too.
- **The clock steps back** (NTP, or a phone's clock being changed). The new
  event sorts before events already read.
- **The §1 anchor** (CodeRabbit). On an entity with legacy history and no
  watermark, a triggering event that sorts at or before the legacy
  boundary takes that boundary's offset. The anchor then lands on the new
  event itself, and the event is skipped.

**The change.** `write()` reads the entity's newest `created_at` inside its
transaction and stamps the new event at `max(Date.now(), newest + 1)`. The
deferred path now runs its insert in a transaction for the same read. Every
written event then sorts after every event already in the log, which
settles all three cases. The anchor needs no special case for the new event.

- `created_at` stays wall-clock time unless writes outrun the clock or the
  clock steps back. Then it runs ahead by at most one millisecond per
  event. `occurred_at` is untouched.
- Imported events keep their own `created_at`. An import with
  `created_at` values in the future pushes later writes past them. This is
  accepted: it keeps the ordering correct.
- At `Number.MAX_SAFE_INTEGER`, `newest + 1` no longer increases, so the
  tie would return. Only an imported value can reach it. `write()` then
  throws a `RangeError` and stores nothing, rather than tie silently.
  (Added 2026-11-11 after the fifth review. Range-checking imported
  `created_at` is a separate issue.)
- Events already stored with tied timestamps are not repaired.

## Files touched

- `packages/core/src/services/WriteService.ts`: anchor before the counter
  move on both trigger paths.
- `packages/core/src/services/MaintenanceService.ts`: the anchor helper,
  if the builder extracts one.
- Possibly `packages/core/src/repositories/EventRepository.ts`:
  transaction-aware `getAtOffset`/`count` if they lack a `tx` parameter.
- `packages/core/__tests__/`: new tests (see below).
- §4: `MaintenanceService.runPrune` and `EventRepository.prune` /
  `pruneThrough` (transaction-aware).
- §5: `WriteService.write` and `EventRepository.latestCreatedAt`.
- `apps/docs/src/content/docs/guides/maintenance.md`: the known-issue note
  (§3).
- `packages/benchmarks/fixtures/promptVolume/baseline.json`: ops-auto
  `eventsSeen` moves from 40 to 56, with calls and characters rising
  accordingly. Regenerate it with `BENCH_UPDATE_BASELINE=1`. This needs
  PR #357 merged first; if it is not, this file is left for #357's rebase.

## Test plan

Each test must fail before the fix:
1. **Fresh entity, ops + auto, count trigger.**
   - Setup: `autoLibrarianThreshold: 5`, 5 writes, a scripted provider.
   - Assert: the first extract prompt contains event 1, all 5 events are
     extracted, and the watermark ends at event 5.
2. **Same, token trigger.** Set `autoLibrarianTokenThreshold` low enough
   that the token path fires before the count path.
3. **Legacy history preserved.**
   - Setup: an entity with `memory_checkpoint = 3` and 3 prior events, then
     switch to ops + auto and write until a trigger fires.
   - Assert: the first ops prompt starts at event 4, so legacy-read events
     are not re-read.
4. **Failure leaves the log re-readable.**
   - Setup: the first triggered pass throws.
   - Assert: the checkpoint is rolled back and the watermark is the
     start-of-log marker. The next trigger extracts events from 1.
5. **Marker semantics.** `START_OF_LOG_WATERMARK` returns the same rows as
   `null` from `getAfter`, `countAfter` and `sumSummaryCharsAfter`, and
   prunes nothing. This holds even with events at `created_at` -5000 and 0.
5b. **Added after the #358 review.**
   - The token trigger with legacy history fires only on characters written
     after the legacy checkpoint.
   - A checkpoint above the event count re-reads the whole log.
   - The fresh-entity token test asserts exactly one pass, containing
     events 1 and 2.
6. **Benchmarks.** Once #357 has merged, the prompt-volume suite shows
   ops-auto `eventsSeen` at 56 against the regenerated baseline. Done in
   `0ef428c6`: extract goes from 2 calls to 3, and resolve now runs (3
   calls), because the first batch's candidates now reach it. `entries`
   rises from 40 to 59 for the same reason.
7. **Unaffected configurations, added after the second #358 review.**
   - ops + deferred leaves the watermark unset after writes that cross
     both thresholds.
   - Under legacy + auto, a below-threshold write on the token path leaves
     the watermark unset, where ops sets the start-of-log marker. Legacy
     passes still advance the watermark themselves (§10.3 of the 2026-09-29
     spec), so the test stays below both thresholds.
   - A failed first pass on the token path leaves the log re-readable from
     the start.

8. **Prune keeps the counter in step (§4).**
   - Legacy + auto with checkpoint 20, prune of the 5 oldest: the
     checkpoint becomes 15. After a switch to ops + auto, the next 5
     writes trigger a pass that extracts exactly those 5 events.
   - Guarded prune under ops: the checkpoint drops by the number deleted.
   - A checkpoint below the number deleted floors at 0.
   - A guarded prune that deletes nothing (deferred, no watermark) leaves
     the checkpoint unchanged.

9. **`created_at` strictly increases (§5).**
   - With `Date.now()` frozen, 30 events across two passes are all
     extracted, and their `created_at` values are distinct.
   - A clock that steps back stamps `newest + 1`.
10. **Trigger lock busy.** When the trigger's `acquireLock` throws
    `WikiBusyError`, the checkpoint is restored, the anchor is kept, and the
    next trigger extracts from event 1.

Then run the core suite, root `pnpm test` and `pnpm -r typecheck`.
