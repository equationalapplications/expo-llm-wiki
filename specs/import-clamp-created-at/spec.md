# Import clamps future-dated event `created_at`

**Status:** Implemented (PR #362). The owner ruled the approach in chat
on 2026-11-11: clamp, don't reject, in its own spec and PR. Issue #361.
§1 and §3 were revised after the Fable review the same day.
The legacy-history seed (§1) and the message template (§2) were revised
after CodeRabbit the same day.
The Sonnet review (same day) found no correctness bug; it narrowed numeric
strings to decimal, added the safe-integer guard and the facts-only seed
gate, and corrected the stale post-#358 text.
**Date:** 2026-11-11
**Intent check:** This is a data-integrity fix on the import path. It
honours rule 6 (honest reporting): every clamped event is counted in a new
typed, content-free diagnostic, so nothing changes silently. It touches no
retrieval or maintenance logic, so rule 11 does not apply. The only public
surface added is one diagnostic code. `WikiDiagnosticCode` says new codes
arrive in minor versions, so this ships as `feat(core)`. (Corrected
2026-11-11 after the Sonnet review: the §1 legacy-history seed does touch
maintenance state. An events-bearing merge import into an entity with
`memory_checkpoint > 0` and no watermark now writes the watermark, so a
later guarded prune may delete events the legacy checkpoint already counted
as read, and `getPendingMaintenance` stops reporting them. Those events
were consolidated by legacy, so this is the intended reading of the
checkpoint, as #364 ruled. It makes no accuracy or cost claim, so rule 11
still needs no benchmark.)

## The fix in plain words

An event's `created_at` means "when this event was stored." `importDump`
copies it from the bundle as-is. A bundle made on a device whose clock ran
ahead, or a crafted one, can carry a `created_at` far in the future.

The fix: when an import brings in an event whose `created_at` is later
than now, store it at now instead. If several are clamped, they get now,
now + 1 ms, and so on, in their original order. One diagnostic per entity
reports how many were clamped. `occurred_at` ("when it happened") is never
touched.

## Problem

Both effects come from the ordering every ops read uses: `(created_at, id)`.

- **On main before #358:** after the ops watermark passes a future-dated
  imported event, every later `write()` is stamped `Date.now()`. That sorts *before*
  the watermark, so every event written afterwards is never extracted. No
  error and no diagnostic.
- **With #358** (spec `ops-auto-first-batch` §5): `write()` stamps
  `max(Date.now(), newest + 1)`, so later writes are ordered correctly but
  pinned to the future date. Retention prune (`created_at <= now - N days`)
  never deletes them, and `created_at` stops reflecting real time. That
  spec accepted this and left import validation to #361. (#358 is merged
  as of 2026-11-11, so this is now the behaviour on main, and the clamp's
  remaining job is to keep later writes on the real clock.)

## Root cause (with evidence)

`ImportExportService.doImportEntity` inserts events with
`created_at: event.created_at` and no range check
(`packages/core/src/services/ImportExportService.ts:415-426`). `importDump`
is the only path that inserts events from outside `write()` (checked with
`grep addIgnoreDuplicate` and `eventRepo.add(` across `packages/*/src`).

## Proposed change

### §1 Clamp in `doImportEntity`

- Read `now = Date.now()` once per entity import, before the event loop.
- Select the bundle's events whose `created_at` is a finite number and
  `> now`.
- Sort that subset by `(created_at, id)`, the same order the ops reads use,
  and assign `now + i` to the i-th. Their relative order stays the same,
  and no two clamped events share a timestamp.
- Events at or before now, and non-finite values, are inserted unchanged,
  as today.
- Nothing else in the event changes.

**Revised 2026-11-11 after the Fable review** (the bullets above are the
first draft; these replace them where they differ):

- **Floor.** Read the entity's ops watermark in the import transaction,
  after a non-merge import has cleared it. `floor` is the watermark's `at`
  when it is finite and later than `now`, otherwise `now`. An older
  version can leave the watermark in the future. Clamping to `now` there
  would put new imports behind it, never extracted, where main extracts
  them.
- **Stamps start at `floor + 1`**, not `floor`: the i-th clamped event gets
  `floor + 1 + i`. Starting at `floor` could tie with a row already there,
  or with an unclamped bundle event at `now`, and the tie is broken by id.
- **What counts as future.** `created_at` is read the way SQLite's INTEGER
  column reads it: numbers as-is, numeric strings parsed. (Narrowed
  2026-11-11 after the Sonnet review: decimal strings only. SQLite keeps
  hex, binary and octal text such as `"0x10"` as TEXT, so it is not read
  as a number here either. Such values are #364's invalid-date case.) A
  string such as
  `"4102444800000"` is stored as that integer, so it is clamped too.
  `Infinity` (JSON `1e999`) is `> now` and is clamped; stored as-is it
  makes the librarian prompt throw. `NaN` and other values are left alone.
- **Only for imports that bring events** (added 2026-11-11 after the
  Sonnet review). A facts-only merge import leaves the event log, and so
  the librarian state, as it was.
- **A floor near the safe-integer limit throws** (added 2026-11-11 after
  the Sonnet review). Past `2^53 - 1`, `floor + 1 + i` rounds, and the
  stamps would tie with each other and the watermark and sort behind it
  silently. The import throws `RangeError` and rolls that entity back, as
  `write()` does at the same limit.
- **Legacy history is resolved first** (added 2026-11-11 after CodeRabbit).
  When the entity has no watermark but `memory_checkpoint > 0`, the import
  seeds the watermark inside its transaction, on the log *before* inserting
  any event. It uses the same rule as `seedLibrarianWatermark`, shared in
  `services/legacyWatermark.ts`, including #358's drift rule (checkpoint
  above the count gives the start-of-log marker). Without this, seeding at
  pass time reads offset `memory_checkpoint - 1` of the modified log. A
  clamped event stored before a covered future-dated event can become that
  anchor, and is then skipped. This also delivers
  `import-past-dated-events` §1 step 1 (ruled 2026-11-11).

### §2 Report it

- New diagnostic code `event_created_at_clamped`, severity `warn`,
  operation `importDump`, trigger `call`, with `detail: { count }`.
- Message template: "Imported events dated in the future were stored with
  the current time." (Revised 2026-11-11 after CodeRabbit: with the §1
  watermark floor, events can stay dated after a future watermark, so the
  template now reads "Imported events dated in the future were re-dated
  just after the current time, or after the librarian position if that is
  later, keeping their order.")
- `count` is the number of clamped events actually inserted.
  `EventRepository.addIgnoreDuplicate` returns whether the row was
  inserted, so a clamped event that is skipped as a duplicate is not
  counted.
- Emitted once per entity, after that entity's import transaction commits,
  and only if `count > 0`.

### §3 Out of scope

- **Past-dated imported events behind an existing ops watermark** are not
  extracted. This is the second item on #361 and needs a different fix.
  (Corrected 2026-11-11 after the Fable review. The first draft said
  clamping "can only move dates later". It moves future dates earlier,
  which could put them behind a future watermark; the floor in §1 is what
  keeps them after it.)
- **Chunked merge imports of one entity** each take their own `now`. If a
  chunk holds more clamped events than milliseconds pass before the next
  chunk, the two chunks' clamped events interleave. No event is lost; only
  their relative order across chunks changes. Accepted.
- **A `write()` inside the clamped run.** Clamped stamps can run up to N ms
  ahead of the clock. On main, `write()` stamps `Date.now()`, so a write in
  that window can sort among them and, if a pass already read past it, be
  skipped. #358 (`ops-auto-first-batch` §5) stamps writes at
  `max(Date.now(), newest + 1)`, which closes this. Accepted until then.
  (Closed 2026-11-11: #358 is merged, and a write after a clamped run is
  stamped after it. Confirmed by the Sonnet review's probe.)
- **`-Infinity` and other non-numeric values** are left as they are; they
  are past-dated, the other half of #361.
- **Diagnostics when a later entity throws.** `importDump` commits each
  entity separately, so an entity that committed has delivered its
  diagnostic even if a later entity throws. The docs' "an operation that
  throws delivers no diagnostics" now names this exception.
  `embedding_failed` already behaved this way.
- **Facts, tasks and edges** keep their timestamps. Their `created_at` and
  `updated_at` drive merge decisions, not event ordering.
- **Rows already stored** with future dates are not repaired.
- **No skew tolerance.** Anything later than now is clamped. A device a few
  seconds fast loses only those seconds.

### Trade-off accepted

Exporting the data again no longer reproduces the bundle exactly for
clamped events. The diagnostic is the signal that this happened.

## Files touched

- `packages/core/src/services/ImportExportService.ts`: the clamp and the
  diagnostic.
- `packages/core/src/repositories/EventRepository.ts`: `addIgnoreDuplicate`
  returns `boolean`.
- `packages/core/src/types.ts`, `packages/core/src/utils/diagnostics.ts`:
  the new code, its severity and its message.
- `apps/docs/src/content/docs/guides/diagnostics.md`: one table row.
- `packages/core/__tests__/importClampCreatedAt.test.ts`: new tests.
- Added after CodeRabbit: `packages/core/src/services/legacyWatermark.ts`,
  the shared seed rule; `MaintenanceService.ts`, where
  `seedLibrarianWatermark` delegates to it; `WikiMemory.ts`, which passes
  `options` through; and the `ImportExportService.test.ts` mocks.

## Test plan

1. A future-dated event is stored at `Date.now() + 1` (clock mocked); a
   past-dated one is unchanged; `occurred_at` is unchanged.
2. Several future events keep their `(created_at, id)` order and get
   distinct consecutive timestamps.
3. The diagnostic fires once with the right `count`, and does not fire
   when nothing was clamped.
4. In merge mode, a clamped event whose id already exists is not counted.
5. Under ops, a future-dated import followed by `runLibrarian` and
   further writes still extracts the later writes, *and* those writes are
   stamped near the real clock, not pinned to the future date. With #358
   merged, extraction alone no longer proves the clamp (Sonnet review).
6. A clamped event never sorts before an unclamped bundle event at `now`.
7. Numeric-string and `Infinity` values are clamped and counted.
8. With a watermark already in the future, a clamped event lands after it
   and is extracted.
9. Legacy history is seeded before the import: checkpoint 1 with a covered
   future event; drift (checkpoint above the count) gives the start-of-log
   marker; `merge: false` seeds nothing; a facts-only merge import seeds
   nothing; strategy `legacy` seeds too.
10. A floor too close to `Number.MAX_SAFE_INTEGER` makes the import throw
    `RangeError` and store nothing. A hex string is not read as a number.
