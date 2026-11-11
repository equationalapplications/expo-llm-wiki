# ops + auto: the first auto pass skips the events that triggered it

**Status:** Draft
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

- **Who hits it:** an entity on a fresh database (no legacy history) with
  `librarian.strategy: 'ops'` and `maintenance: 'auto'`. ops has been
  opt-in since 7.8.0 and the default strategy since 8.0.0. Its default
  maintenance is `'deferred'`, which is unaffected.
- **What happens:** the first `autoLibrarianThreshold` events (default 20)
  are never extracted.
  - No LLM call is made, and no error or diagnostic is raised.
  - A later explicit `runLibrarian` does not recover them, because the
    bookmark is already past them.
  - Both auto triggers hit it: the event count (`WriteService.ts:115`) and
    the token threshold (`:126`).

## Root cause (with evidence)

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
- **When:** only when the resolved librarian strategy is `'ops'`, no
  watermark exists, and a librarian pass is about to be triggered. This
  covers both the count path and the token path.
- **What:** anchor the watermark *before* `updateCheckpoint(memory: count)`:
  - **The pre-trigger `memory_checkpoint` is > 0** (legacy history): anchor
    exactly as `seedLibrarianWatermark` does today, at the event at offset
    `min(checkpoint, total) - 1`.
  - **It is 0** (no history): write the start-of-log marker
    `{ at: 0, id: '' }`.
- **Why the marker is safe:** `AFTER_SQL` treats it exactly like "no
  watermark". It selects every event with `created_at > 0`, and core
  requires `created_at` to be positive epoch ms. `sumSummaryCharsAfter`,
  `countAfter`, `pruneThrough` and `countHeldBack` all read it the same
  way.
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
- Legacy strategy, deferred maintenance and the read path do not change.

### §3 Already-affected entities

The fix cannot tell a bookmark this bug misplaced from a correct
legacy-migration bookmark, so it repairs nothing automatically. Affected
entities (ops + auto, created on 7.8.0 or later) have lost their first
`autoLibrarianThreshold` events from memory. The raw events are still in
the event log unless pruning has removed them.

**Open question for the owner:** ship a remedy, or document only?
- Document only: a changelog/README note telling affected users to re-run
  ingestion.
- Remedy: a package-internal or public way to reset an entity's watermark
  to the start-of-log marker, so the next pass re-reads the log. This adds
  API surface and risks re-extracting facts that do exist. Ops dedups them
  through the gate, at the cost of LLM calls.

## Files touched

- `packages/core/src/services/WriteService.ts`: anchor before the counter
  move on both trigger paths.
- `packages/core/src/services/MaintenanceService.ts`: the anchor helper,
  if the builder extracts one.
- Possibly `packages/core/src/repositories/EventRepository.ts`:
  transaction-aware `getAtOffset`/`count` if they lack a `tx` parameter.
- `packages/core/__tests__/`: new tests (see below).
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
5. **Marker semantics.** `{ at: 0, id: '' }` returns the same rows as
   `null` from `getAfter`, `countAfter` and `sumSummaryCharsAfter`, and
   prunes nothing.
6. **Benchmarks.** Once #357 has merged, the prompt-volume suite shows
   ops-auto `eventsSeen` at 56 against the regenerated baseline.

Then run the core suite, root `pnpm test` and `pnpm -r typecheck`.
