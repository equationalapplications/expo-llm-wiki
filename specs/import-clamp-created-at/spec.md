# Import clamps future-dated event `created_at`

**Status:** Reviewed. The owner ruled the approach in chat on 2026-11-11:
clamp, don't reject, in its own spec and PR. Issue #361.
**Date:** 2026-11-11
**Intent check:** This is a data-integrity fix on the import path. It
honours rule 6 (honest reporting): every clamped event is counted in a new
typed, content-free diagnostic, so nothing changes silently. It touches no
retrieval or maintenance logic, so rule 11 does not apply. The only public
surface added is one diagnostic code. `WikiDiagnosticCode` says new codes
arrive in minor versions, so this ships as `feat(core)`.

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

- **On main:** after the ops watermark passes a future-dated imported
  event, every later `write()` is stamped `Date.now()`. That sorts *before*
  the watermark, so every event written afterwards is never extracted. No
  error and no diagnostic.
- **With #358** (spec `ops-auto-first-batch` §5): `write()` stamps
  `max(Date.now(), newest + 1)`, so later writes are ordered correctly but
  pinned to the future date. Retention prune (`created_at <= now - N days`)
  never deletes them, and `created_at` stops reflecting real time. That
  spec accepted this and left import validation to #361.

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

### §2 Report it

- New diagnostic code `event_created_at_clamped`, severity `warn`,
  operation `importDump`, trigger `call`, with `detail: { count }`.
- Message template: "Imported events dated in the future were stored with
  the current time."
- `count` is the number of clamped events actually inserted.
  `EventRepository.addIgnoreDuplicate` returns whether the row was
  inserted, so a clamped event that is skipped as a duplicate is not
  counted.
- Emitted once per entity, after that entity's import transaction commits,
  and only if `count > 0`.

### §3 Out of scope

- **Past-dated imported events behind an existing ops watermark** are not
  extracted. This is the second item on #361 and needs a different fix.
  Clamping can only move dates later, never earlier, so it neither helps
  nor worsens it.
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

## Test plan

1. A future-dated event is stored at `Date.now()` (clock mocked); a
   past-dated one is unchanged; `occurred_at` is unchanged.
2. Several future events keep their `(created_at, id)` order and get
   distinct consecutive timestamps.
3. The diagnostic fires once with the right `count`, and does not fire
   when nothing was clamped.
4. In merge mode, a clamped event whose id already exists is not counted.
5. The regression on main: under ops, a future-dated import followed by
   `runLibrarian` and further writes still extracts the later writes.
