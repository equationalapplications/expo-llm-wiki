# Import past-dated events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `merge: true` import no longer strands events behind the
librarian watermark. Events the source never consolidated are re-dated
just after it, invalid dates are made safe, bundles carry the source
watermark, and OKF keeps real dates.

**Architecture:**
- One pure planner, `planEventStamps`, decides every bundle event's
  stored `created_at` and `occurred_at` and its counted reason. It extends
  #362's `clampFutureCreatedAt`.
- `doImportEntity` applies the plan and emits one diagnostic per non-zero
  reason.
- `getFullBundle` exports the watermark, and OKF dates log entries by
  `occurred_at ?? created_at`.

**Tech Stack:** TypeScript, vitest, SQLite via the `SQLiteAdapter`, pnpm
workspace (`packages/core`).

**Spec:** `specs/import-past-dated-events/spec.md`. Read §1, §7 and §8 in
full. §7 and §8 supersede earlier wording where they differ.

## Global Constraints

- pnpm only. Never `npm install`, and never commit a `package-lock.json`.
- Never edit `CHANGELOG.md` or any `"version"` field. No commit-body line
  may start with `BREAKING CHANGE`, and no `!` after the type.
- Commits use conventional types with scope `core`, and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Diagnostics are content-free: `count` and `reason` only. Never put
  summaries, ids of other entities or dates in them.
- Run tests with `cd packages/core && pnpm exec vitest run <file>`, and
  typecheck with `pnpm run typecheck` from the repo root.
- New diagnostic code: `event_created_at_restamped`, severity `info`.
- Message, exactly: `Imported events that would have sorted behind the
  librarian position, or had an unusable date, were re-dated just after the
  current time, or after the librarian position if that is later, keeping
  their order.`
- Reasons: `'future' | 'behind_watermark' | 'invalid'`. `future` keeps
  #362's `event_created_at_clamped` (`warn`) unchanged.
- JS Date range bound: `8.64e15`. A value `v` is a usable date iff
  `Number.isFinite(v) && v >= -8.64e15 && v <= 8.64e15`.
- No docs or changelog text makes an accuracy or cost claim.

## Review Focus

1. **Re-importing a bundle this same store exported** (a self round
   trip). Nothing should be re-stamped and no diagnostic emitted. Task 3
   covers it.
2. **The same event id twice in one bundle, with different dates.** The
   first insert wins and the second is ignored and not counted. Task 2
   covers it.
3. **A bundle from `getMemoryBundle`** (10 newest events) merged into a
   peer. Each event is classified by the watermark and none is lost.
   Task 3 covers it.
4. **A decimal-string `created_at` behind the watermark**, e.g.
   `'1700000000000'`. It is re-stamped, and `occurred_at` gets the number.
   Task 2 covers it.
5. **A source watermark that is the start-of-log marker.** Every event is
   eligible for re-stamping, as if there were no source watermark. Task 3
   covers it.

---

### Task 1: The stamp planner

**Files:**
- Create: `packages/core/src/services/importEventStamps.ts`
- Modify: `packages/core/src/services/ImportExportService.ts`. Move
  `DECIMAL_TEXT`, `createdAtValue` and `clampFutureCreatedAt` (lines ~18-50)
  out of it. Its event loop keeps working through a thin call (Task 2
  rewires it fully).
- Test: `packages/core/__tests__/importEventStamps.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StampReason = 'future' | 'behind_watermark' | 'invalid';
  export interface PlannedStamp { createdAt: number; occurredAt: number | null; reason: StampReason | null }
  export function createdAtValue(v: unknown): number;               // unchanged #362 semantics
  export function isUsableDate(v: number): boolean;                 // finite and within ±8.64e15
  export function parseSourceWatermark(raw: unknown): LibrarianWatermark | null; // at finite number, id string, else null
  export function planEventStamps(
    events: readonly WikiEvent[],
    ctx: { now: number; floor: number; merge: boolean; localWm: LibrarianWatermark | null; sourceWm: LibrarianWatermark | null },
  ): Map<WikiEvent, PlannedStamp>;
  ```
  `LibrarianWatermark` is imported as a type from
  `../repositories/MetadataRepository`.

**Algorithm (spec §7 and §8.1). Every event gets an entry:**
- `v = createdAtValue(e.created_at)`; `o = createdAtValue(e.occurred_at)`.
- `occurredAt`:
  - `e.occurred_at == null` gives `null`;
  - `isUsableDate(o)` gives `Math.trunc(o)`;
  - anything else gives `null`, which counts as an `invalid` flag.
- Reason, first match wins:
  - `invalid` when `!(Number.isFinite(v) && v >= -8.64e15)`. NaN, -Infinity
    and values below the Date range land here. +Infinity is handled by the
    future rule, which catches it before this check matters, so order the
    check after `v > now`.
  - `future` when `v > now`.
  - `behind_watermark` when all of these hold: `merge`; `localWm` is
    non-null with a finite `at`; the event is not after `localWm`
    (`v < wm.at || (v === wm.at && id <= wm.id)`); and either `sourceWm`
    is null or the event is after it.
  - Otherwise `null`. If the `occurred_at` flag is set, the reason becomes
    `invalid`, but `createdAt` stays `v`.
- Re-stamped set: reasons `invalid` (created_at), `future` and
  `behind_watermark`.
  - Sort it by key `invalidCreatedAt ? -Infinity : v`, ties by id (`<`
    string compare).
  - Assign `floor + 1 + i`.
  - Throw `RangeError` if `floor + n > Number.MAX_SAFE_INTEGER`, keeping
    #362's message.
- Events that are not re-stamped keep `createdAt = v`.
- `behind_watermark` only: when `occurredAt === null` and `e.occurred_at`
  was `null`/absent, and `v` is finite and `v >= 0`, set
  `occurredAt = Math.trunc(v)`.

- [ ] **Step 1: Write the failing tests** in `importEventStamps.test.ts`,
  calling `planEventStamps` directly (no DB). One `it` per case:
  - future event → `{ createdAt: floor+1, reason: 'future' }`, and
    `occurredAt` keeps the event's value;
  - a past event behind `localWm` with `merge: true` and `sourceWm: null`
    → `reason: 'behind_watermark'`, `createdAt: floor+1`,
    `occurredAt: <original created_at>`;
  - the same event with `merge: false` → `reason: null`, unchanged;
  - an event exactly at `localWm` (same `at`, same id) → `behind_watermark`;
    the same `at` with an id greater than `wm.id` → `null`;
  - `sourceWm` set and the event at or before it → `null`; after it →
    `behind_watermark`;
  - `localWm` with `at: Infinity` → no `behind_watermark`;
  - `localWm: null` → no `behind_watermark`;
  - invalid `created_at` (`null`, `undefined`, `NaN`, `'abc'`, `'0x10'`,
    `-Infinity`, `-9e15`, `-1e300`, `true`, `{}`) → `reason: 'invalid'`,
    `createdAt` a finite number, `occurredAt` not copied;
  - `occurred_at: 'abc'` with a valid past `created_at` → `reason: 'invalid'`,
    `occurredAt: null`, `createdAt` unchanged;
  - `occurred_at: Infinity` on a behind-watermark event → `occurredAt` is
    the copied original `created_at`, `reason: 'behind_watermark'`;
  - a supplied valid `occurred_at` is kept on a behind-watermark event;
  - a negative `created_at` (`-5000`) behind the watermark → re-stamped,
    `occurredAt` stays `null`;
  - `'1700000000000'` behind the watermark → `occurredAt: 1700000000000`;
  - run order: invalid (by id), then behind (by v, id), then future (by v,
    id), stamped consecutively from `floor + 1`;
  - `floor` near `MAX_SAFE_INTEGER` → throws `RangeError`;
  - `parseSourceWatermark`: `{at:5,id:'x'}` → same; `{at:'5',id:'x'}`,
    `{at:NaN,id:'x'}`, `{at:null,id:'x'}`, `{at:5,id:3}`, `null`, `[]` →
    `null`; the start-of-log marker → the marker.
- [ ] **Step 2:** Run the file. Expected: FAIL, because the module does not
  exist.
- [ ] **Step 3:** Implement `importEventStamps.ts`, then remove the moved
  helpers from `ImportExportService.ts` and import them. For now, keep the
  loop's current behaviour by calling
  `planEventStamps(bundle.events, { now, floor, merge: false, localWm: null, sourceWm: null })`
  and using `createdAt`/`occurredAt`. The `clampedEvents` count is
  `reason === 'future'`. Task 2 replaces the context.
- [ ] **Step 4:** Run `importEventStamps.test.ts`,
  `importClampCreatedAt.test.ts` and
  `services/ImportExportService.test.ts`. Expected: all PASS.
- [ ] **Step 5:** Commit as
  `refactor(core): one import stamp planner for future, behind-watermark and invalid dates`.

### Task 2: Apply the plan on import, and the restamped diagnostic

**Files:**
- Modify: `packages/core/src/services/ImportExportService.ts` (the
  `doImportEntity` event loop and the post-commit emit).
- Modify: `packages/core/src/types.ts` (`WikiDiagnosticCode` gains
  `'event_created_at_restamped'`).
- Modify: `packages/core/src/utils/diagnostics.ts` (`SEVERITY: 'info'`;
  `MESSAGE` exactly as in Global Constraints).
- Modify: `apps/docs/src/content/docs/guides/diagnostics.md` (one table
  row: `` `event_created_at_restamped` | `importDump` re-dated events that
  would have sorted behind the librarian position, or had an unusable
  date (`detail.count`, `detail.reason`) ``).
- Test: `packages/core/__tests__/importPastDatedEvents.test.ts`

**Interfaces:**
- Consumes: `planEventStamps` and `parseSourceWatermark` from Task 1.
  Pass `sourceWm: parseSourceWatermark((bundle as { librarian_watermark?: unknown }).librarian_watermark)`.
  The typed field arrives in Task 3; the cast is removed there.
- Produces: diagnostics `{ code: 'event_created_at_restamped', operation: 'importDump', trigger: 'call', entityId, detail: { count, reason } }`.
  There is at most one per non-zero reason (`behind_watermark`,
  `invalid`), emitted after commit, next to #362's `clamped` emission.

- [ ] **Step 1: Write the failing integration tests** in
  `importPastDatedEvents.test.ts`. Use `WikiMemory` + `openTestDatabase`,
  with a scripted provider as in `__tests__/importClampCreatedAt.test.ts`
  (copy its `scriptedProvider`, `ev` and `dump` helpers). Mock `Date.now`
  where stated:
  - ops + deferred: 60 writes, 2 `runLibrarian`, then a merge import of an
    event dated 2023 → the next pass's extract prompt contains it, and
    `runPrune({ retainEventsFor: 30 })` deletes 0 events (spec tests 1
    and 3);
  - legacy + deferred, same setup with ≤ 50 events → the legacy prompt
    contains the import (spec test 2);
  - one bundle with past, future and invalid events → stored
    `created_at` values are consecutive from `floor + 1` in the specified
    run order (spec test 10);
  - `merge: false` → only future/invalid are re-dated (spec test 11);
  - an event after the local watermark and before now → unchanged (spec
    test 12);
  - invalid values stored with real numbers, and `runLibrarian` does not
    throw (spec test 22);
  - diagnostics: one `restamped` per non-zero reason with the right
    `count`. A repeated identical merge import emits no `restamped`. The
    same id twice in a bundle is counted once (spec tests 9 and 14,
    Review Focus 2);
  - a decimal-string `created_at` behind the watermark → re-stamped,
    `occurred_at` holds the number (Review Focus 4);
  - a combined run that throws `RangeError` stores nothing and emits
    nothing (spec test 20).
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement:
  - in `doImportEntity`, pass `{ now, floor, merge, localWm: wm, sourceWm }`;
  - insert `created_at: plan.createdAt` and `occurred_at: plan.occurredAt`;
  - count inserted rows per reason;
  - after the transaction, emit `clamped` for `future` (as today) and one
    `restamped` per non-zero `behind_watermark` / `invalid` count;
  - add the code, severity, message and docs row.
- [ ] **Step 4:** Run `importPastDatedEvents.test.ts`,
  `importClampCreatedAt.test.ts`, `importDump.test.ts`,
  `importDumpMerge.test.ts`, `services/ImportExportService.test.ts`, then
  `pnpm run typecheck`. Expected: all PASS.
- [ ] **Step 5:** Commit as
  `feat(core): merge import re-dates events behind the watermark and unusable dates`.
  The body states the effect and names spec §1/§7/§8, with no cost claim.

### Task 3: Export the source watermark

**Files:**
- Modify: `packages/core/src/types.ts`. `MemoryBundle` gains
  `librarian_watermark?: { at: number; id: string };`, with a doc comment:
  set by export only; the importer trusts events at or before it as
  consolidated at the source.
- Modify: `packages/core/src/services/ImportExportService.ts`:
  - `getFullBundle` reads `this.metadataRepo.getLibrarianWatermark(entityId, this.db)`
    first and awaits it before the existing `Promise.all`, then spreads
    `...(wm ? { librarian_watermark: wm } : {})`;
  - drop Task 2's cast.
- Modify: `apps/docs/src/content/docs/reference/types.md` (document the
  field) and `apps/docs/src/content/docs/guides/maintenance.md` (a short
  paragraph: merge imports re-date unread past events and stamp invalid
  dates; bundles carry the source watermark; splitting a bundle must copy
  it to each chunk).
- Test: `packages/core/__tests__/importPastDatedEvents.test.ts` (append).

**Interfaces:**
- Consumes: Task 2's import behaviour.
- Produces: `exportDump()` and `getMemoryBundle()` bundles carry
  `librarian_watermark` when the entity has one.

- [ ] **Step 1: Write the failing tests** (append):
  - `exportDump` and `getMemoryBundle` carry the field when a watermark
    exists and omit it when none does. `JSON.parse(JSON.stringify(dump))`
    round-trips it, the start-of-log marker included (spec test 15);
  - `getFullBundle` reads the watermark before the facts: spy on
    `metadataRepo.getLibrarianWatermark` and `entryRepo.findAllByEntityId`
    and assert the call order;
  - a malformed field (`at` as a string, `NaN`, `null`; `id` as a number;
    the field `null`; `[]`) takes the fallback (spec test 16);
  - device sync. Store A: 5 writes, consolidated by `runLibrarian`, then
    export. Store B: its own writes, a pass, and its watermark later than
    all of A's events. Merge-import A's bundle into B. A's events are not
    re-stamped, no `restamped` is emitted, and the next pass on B makes no
    extract call for them (spec test 4, with its precondition);
  - bounce: an event E pruned on A comes back from B, where B's watermark
    has passed E. It is inserted unchanged and not re-extracted (spec test
    5, with its precondition);
  - a source-consolidated event behind the local watermark keeps
    `created_at` and `occurred_at` (spec test 21);
  - a source watermark with no local watermark re-stamps nothing (spec
    test 18);
  - a self round trip (export, then merge-import into the same store)
    re-stamps nothing and emits no `restamped` (Review Focus 1);
  - a `getMemoryBundle` bundle merged into a peer classifies each of its
    10 events correctly (Review Focus 3);
  - a start-of-log source watermark makes every event behind the local
    watermark eligible (Review Focus 5);
  - legacy with more than 50 re-stamped events: assert today's §4
    behaviour (50 read, the rest not) and comment that it is the
    documented limit (spec test 13).
- [ ] **Step 2:** Run. Expected: FAIL on the export and device-sync tests.
- [ ] **Step 3:** Implement the type, the `getFullBundle` change and the
  docs.
- [ ] **Step 4:** Run the import/export suites from Task 2's Step 4 plus
  `WikiMemory.test.ts`, then `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit as
  `feat(core): bundles carry the source librarian watermark`.

### Task 4: OKF dates log entries by real-world time

**Files:**
- Modify: `packages/core/src/utils/formatOkfBundle.ts:179`. Use
  `formatLogDate(e.occurred_at ?? e.created_at)`.
- Modify: `apps/docs/src/content/docs/guides/okf.md`. Log entries are
  dated by `occurred_at` when set. A merge import re-dates old log entries
  after the librarian position and keeps the original date in
  `occurred_at`. OKF bundles carry no source watermark, so they take the
  fallback.
- Test: `packages/core/__tests__/importPastDatedEvents.test.ts` (append),
  plus any existing OKF format test whose expected output changes.

**Interfaces:**
- Consumes: Task 2's import behaviour. `parseOkfBundle` is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `formatOkfBundle` renders an event with `created_at` 2026-11-11 and
    `occurred_at` 2023-01-05 under `## 2023-01-05`;
  - an OKF-parsed merge bundle (midnight-UTC dates, no `occurred_at`) into
    an entity whose watermark is later that day → the event is re-stamped
    and read on the next pass, and `occurred_at` holds the original
    midnight value (spec test 6).
- [ ] **Step 2:** Run. Expected: FAIL on the format test.
- [ ] **Step 3:** Implement the one-line change and the docs. Update any
  existing OKF test expectations that now differ, only where the event has
  `occurred_at`.
- [ ] **Step 4:** Run the whole core suite
  (`cd packages/core && pnpm exec vitest run`) and `pnpm run typecheck`.
  Expected: all PASS.
- [ ] **Step 5:** Commit as
  `fix(core): OKF log entries are dated by occurred_at when set`.
