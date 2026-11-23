# Import diagnostics are emitted only after the transaction commits

**Status:** Reviewed (owner-approved as written 2026-11-23). Issue #473.
**Date:** 2026-11-23
**Intent check:** This is a honest-reporting fix (`INTENT.md` rule 6,
"Honest reporting"). A diagnostic is a report to the host that something
happened. When `importDump` throws and the transaction rolls back, nothing
happened, and a diagnostic that was already emitted says otherwise. The fix
moves one emit to the place where the other import refusals already emit. It
adds no code, no option and no public type, touches no retrieval or
maintenance logic (rule 11 does not apply), and makes no accuracy or cost
claim. It ships as `fix(core)`, a patch. No `INTENT.md` amendment is needed.

## Problem

`importDump` runs each entity inside `db.withTransactionAsync`. The rule
already followed by the stored-source refusals is "buffer during the
transaction, emit after the commit, so a failed commit emits nothing."
`source_pointer_invalid` breaks that rule: it is emitted at the moment it is
found, inside the transaction. If a later fact in the same dump throws (for
example an invalid stored source), the transaction rolls back and no fact is
written, but the host's `onDiagnostic` has already been told that fact a had
an invalid pointer. The host sees a refusal report for an import that never
happened.

## Root cause (evidence on main, `dd6e2a4c`; line numbers below are from that commit. Re-audited 2026-11-23 on main `b70247ee` after PR #469 landed: the inline `source_pointer_invalid` emit moved to `:458`, the buffer to `:255`, the flush to `:706`; no other inline emit is reachable inside the transaction, and the audit table is unchanged)

`packages/core/src/services/ImportExportService.ts`:

- `:254` declares `refusalDiagnostics`, the buffer.
- `:271` opens `withTransactionAsync(async (tx) => { ... })`.
- `:457-464` emits `source_pointer_invalid` directly with `emitDiagnostic`
  inside the callback, in the per-fact loop.
- `:679` passes `refusalDiagnostics` to `importStoredSources`, which pushes
  its refusals (`source_too_large` and the other `upsertStoredSource` codes,
  `:153`, `:187`) into the buffer instead of emitting.
- `:680-682` is the single flush, after the transaction callback returns:
  `for (const d of refusalDiagnostics) emitDiagnostic(this.options, d)`.
- `:684-702` emit the count diagnostics after the commit too.

Nothing buffers the pointer diagnostic, so it is the one emit that escapes
the rule.

## Audit of every `emitDiagnostic` reachable from the import path

Entry points. `WikiMemory.importDump` (`WikiMemory.ts:1122`) calls
`ImportExportService.importDump`, which is the only caller of
`doImportEntity`. There is no `importOkf` method anywhere in `packages/`.
`parseOkfBundle` is a pure parser: it returns a `MemoryDump` that the host
passes to `importDump`, so it has no import transaction of its own. No other
service or repository called from inside the transaction emits (checked:
`db/`, `legacyWatermark.ts`, `importEventStamps.ts`, `sourcePointer.ts`,
`SourceStoreService.ts` all have no `emitDiagnostic` call reachable from
`doImportEntity`; `SourceStoreService.refuse` is the `storeSource` API, not
the import path).

| # | Code | Location (main) | Where it runs | Today |
|---|---|---|---|---|
| 1 | `source_pointer_invalid` | `:457` | inside the transaction | **inline** (the bug) |
| 2 | stored-source refusals (`source_too_large` and the other codes `upsertStoredSource` reports) | `:187` via the `onRefused` callback, in `importStoredSources` | inside the transaction | buffered, flushed `:682` |
| 3 | `import_tombstone_skipped` | `:685` | after commit | after commit |
| 4 | `event_created_at_clamped` | `:691` | after commit | after commit |
| 5 | `event_created_at_restamped` | `:698` | after commit | after commit |
| 6 | `derived_events_invalid` | added by PR #469 (now on main, `:477`) | inside the transaction | already buffered in #469 |

So exactly one emit is inline today: row 1. The brief asked for every inline
one, and the audit finds one. Two non-diagnostic observations, out of scope
here: `_warnCrossEntityCollision` (`:385`, `:887`) writes `console.warn`
inside the transaction, which is not an `onDiagnostic` event and is not
changed; and the `throw` at `:130` (the invalid stored source) is what makes
the rollback case reachable.

### Interaction with PR #469

PR #469 (open, stacked, branch `spec/inplace-update-provenance`) changes
`ImportExportService.ts` in four places (checked with
`git diff origin/main origin/spec/inplace-update-provenance -- packages/core/src/services/ImportExportService.ts`):
an import of `validateDerivedEventsValue`; a new block directly after the
`sourcePointer` lines (about `:466-485`) that validates `derived_events` and
pushes `derived_events_invalid` into `refusalDiagnostics`; a spread of
`derived_events` into `factObj`; and a fourth argument
(`hasDerivedEventsKey`) to `upsertForImport`. #469 does not touch the
`source_pointer_invalid` emit, the buffer declaration, or the flush. It
already uses the buffer correctly, so it is the pattern this spec follows,
and it adds no inline emit. This change edits only the lines at `:457-464`,
which #469 leaves as context lines directly above its new block. The two
edits do not overlap, so this merges cleanly after #469, with at most
adjacent-hunk context shifting. #469 has landed (v18 stack, on main); implementation is on top of it. Ordering of the buffered diagnostics: `source_pointer_invalid`
and `derived_events_invalid` for one fact are pushed in that order, before
that entity's stored-source refusals.

## Proposed change

1. Replace the inline `emitDiagnostic` at `:457-464` with
   `refusalDiagnostics.push({ ... })`, same fields (`code`,
   `operation: 'importDump'`, `trigger: 'call'`, `entityId`,
   `detail: { factId }`), plus a comment "Buffered: emitted only after the
   import transaction commits," matching #469's wording.
2. Nothing else moves. The flush at `:682` already emits the buffer.
3. Multi-entity dumps. `refusalDiagnostics` is per `doImportEntity` call, and
   `importDump` commits one transaction per entity. If entity 2 throws,
   entity 1 has already committed and has already flushed its diagnostics,
   which is correct: they describe committed work. Entity 2's buffered
   diagnostics are discarded with its rollback. This per-entity atomicity is
   existing behavior and is not changed here.
4. Diagnostic payload and order for a successful import are unchanged except
   that `source_pointer_invalid` now arrives with the other refusals after
   commit rather than before the commit-time count diagnostics. Hosts keyed
   on code are unaffected. The diagnostics guide and `WikiDiagnosticCode`
   docs need no change; if either states "emitted during import" the
   implementation PR corrects it.

## Test plan

Add to `packages/core/__tests__/sourcePointers.test.ts` (the file that
covers pointer validation) or a new `importDiagnosticsAfterCommit.test.ts`:

1. **Rollback emits nothing.** A dump for one entity where fact `a` has a
   malformed `source_pointer` and fact `b` carries a stored source with an
   invalid `sourceRef` (the case that throws at `:130`). Assert
   `importDump` rejects, `onDiagnostic` was never called (no
   `source_pointer_invalid`, no other code), and neither fact exists in the
   store. This test fails on main (it sees one `source_pointer_invalid`).
2. **Success still emits after commit.** A dump with a malformed pointer that
   imports cleanly: assert `source_pointer_invalid` is emitted exactly once
   with `detail.factId`, and that at emit time the fact is already readable
   (the `onDiagnostic` callback reads it back and finds it committed).
3. **Mixed success.** One entity with a malformed pointer and an over-limit
   stored source: both diagnostics arrive, after commit, in the order
   pointer then source refusal.
4. **Multi-entity.** Entity 1 clean with a malformed pointer, entity 2
   throws: entity 1's diagnostic is emitted (it committed), entity 2 emits
   nothing.
5. After #469 lands, the same rollback test with a malformed `derived_events`
   in fact `a` confirms both buffered codes are suppressed together.

Existing import and pointer tests must pass unchanged.

## Files touched

- `packages/core/src/services/ImportExportService.ts` (one emit becomes a
  buffer push, plus a comment)
- `packages/core/__tests__/` (new or extended test file)
- This spec's Status line flips to Implemented in the implementing PR.

## Versioning

`fix(core): import diagnostics are emitted only after the transaction
commits (#473)`. Patch. No `BREAKING CHANGE` footer; no new code or type.
