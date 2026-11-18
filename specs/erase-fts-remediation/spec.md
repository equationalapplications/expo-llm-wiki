# erase() on module-less runtimes: clear orphaned FTS5 content so erasure completes verified

**Status: Draft (2026-11-17)**  
**Issue:** equationalapplications/expo-llm-wiki#407 (second half — the remediation; the honesty half shipped in PR #404).  
**Investigation:** read-only evidence report 2026-11-17 (subagent, 14 calls, citations below are from `packages/core` @ `1d388b3f`).

## Problem

On a runtime whose SQLite lacks the FTS5 module — or one configured to
`indexStrategy: 'minisearch'` — `wiki.erase()` currently **cannot complete**
whenever orphaned FTS5 tables exist. `_eraseDrainPassages`
(`packages/core/src/services/MaintenanceService.ts:781-807`) probes
`entries_fts_content` / `source_passages_fts_content` when the strategy has
no strict drains and throws `erase_orphaned_fts_content`
(failedStep `index_sync`, `verified: false`). Erasure stays permanently
unverified on that class of runtime even though the orphaned tables are
fully clearable: a DB created on an FTS5-capable host and later opened
module-less keeps the virtual table plus all five shadow tables, and the
shadow tables are plain tables holding the forgotten text.

The honesty half is correct behavior — we ship it deliberately (rev
F-MAJOR-1, #404). But "we detect surviving text and refuse to lie about it"
is not "forget erases": on these runtimes erasure never completes, so the
GDPR posture (INTENT rule 13, "erasure is verifiable") fails for a whole
class of legal deployments (iOS system SQLite without FTS5, custom
Android builds).

Orphans arise by design: on module-less open, `detachFts5`
(`packages/core/src/services/search/createIndexStrategy.ts:59-85`) drops
triggers/map/ledger, then `DROP TABLE IF EXISTS entries_fts` fails without
the module and is **swallowed** (`:84`), and state is set `'detached'`
(`:82`). The vtab row and its five shadow tables
(`_content _data _idx _docsize _config`) survive.

## Root cause (with evidence)

1. Module-less detach cannot DROP the vtab — proven swallowed:
   `createIndexStrategy.ts:75,84` ("/* no fts5 module */"). **This is how
   live vtabs + five shadow tables survive as orphans.**
2. The tables are **regular (content-bearing) FTS5**, not
   external-content/contentless — `fts5Sql.ts:51` (entries) and
   `:215` (passages) — so the `_content` shadows hold the full text.
3. The only orphan handling is the probe-and-fail added in #404;
   nothing ever clears the shadows (`MaintenanceService.ts:781-807`).
4. The retired-table path already proves the clear pattern is safe on a
   module-less runtime: `_eraseReclaimRetired`'s module-less branch
   (`MaintenanceService.ts:845-853`) DELETEs all five suffixes per retired
   table under the pragma and records the name as `retiredUndroppable`.

## The decisions

**D1 — two remediation paths, gated by whether the vtab is queryable.**
Before any clear, probe the live table:
`SELECT 1 FROM ${prefix}entries_fts LIMIT 1`.

- **Path A — module-less (`no such module`):** the vtab is inert. DELETE
  FROM every existing shadow suffix (`_content _data _idx _docsize
  _config`) of `entries_fts` and `source_passages_fts`, plus the plain
  companions that can hold text and are undrainable here:
  `fts_pending`, `source_passages_fts_pending`, and the map/ledger tables
  `fts5_map` + passage equivalents (exact names from `fts5Sql.ts`). Then
  ensure `FTS5_STATE_KEY = 'detached'` in metadata (idempotent; normally
  already set by `detachFts5`) so the next capable open takes the
  **deterministic** rename-retire + rebuild path
  (`Fts5IndexStrategy.ts:245` `resetAndRearm`), not a corruption-driven
  one.
- **Path B — vtab queryable (capable runtime, strategy is
  MiniSearch/Unavailable by config):** `DELETE FROM` a live FTS5 vtab's
  shadows is corruption territory (investigation landmine 1) — but the
  module is present, so **DROP the orphaned vtabs outright**
  (`DROP TABLE IF EXISTS ${prefix}entries_fts`, same for passages) and
  clear the plain companions as in Path A. A capable open later recreates
  nothing (strategy is not fts5); if the host ever switches back to fts5,
  init recreates the tables fresh (`fts5Sql.ts` `CREATE ... IF NOT
  EXISTS`).
- **Probe error of any other class:** fail erase honestly with a new
  `erase_fts_orphan_probe_failed` (failedStep `index_sync`), unchanged
  honesty posture.

**D2 — exact-name allowlist, never a pattern.** Only prefix-joined exact
names (`${prefix}entries_fts`, `${prefix}source_passages_fts`, their five
suffixes, and the named plain companions) are interpolated into the clear
SQL — mirroring `isRetiredTableName`'s discipline (`fts5Sql.ts:19-21`,
"Only engine-shaped names are ever interpolated into reclamation SQL").
The generic retired-list machinery (`FTS5_RETIRED_TABLES_KEY`) is **not**
reused: live names do not fit the `entries_fts_retired_N` shape, and
module-less `ALTER TABLE ... RENAME` of a vtab is not relied on.

**D3 — report stays honest.** `EraseReport`
(`MaintenanceService.ts:226-245`) gains `ftsOrphansCleared: string[]`
(mirror `retiredUndroppable`) and the `failedStep` union gains
`'fts_orphan_clear'`. Each cleared surface is listed; the step is recorded
via the existing `ok()` helper and emits a new diagnostic
`erase_fts_orphan_cleared` per cleared table. If any clear or the metadata
write fails mid-way: `EraseStepError('erase_fts_orphan_clear', ...)`,
`verified: false`. The existing `erase_orphaned_fts_content` code remains
for the never-expected case where a probed surface is missing but
undeletable.

**D4 — gate placement.** The remediation replaces the two probe-and-throw
blocks inside the existing `!hasStrictDrain()` branch
(`MaintenanceService.ts:781-807`) — strict-drain (FTS5) runtimes are
untouched, and their erasure behavior is unchanged byte-for-byte. The
`canReclaimRetired()` retired-table machinery is untouched.

**D5 — later capable open stays correct.** Path A leaves the vtab row plus
hollowed shells in `sqlite_master`. The next capable open sees
`state='detached'` → `resetAndRearm` renames the vtab to
`entries_fts_retired_N` (`:324`), recreates it empty, and arms a rebuild —
and from then on the renamed table fits `isRetiredTableName`, so the
existing reclaim machinery DROPs it (`Fts5IndexStrategy.ts:464-479`). No
new cross-open protocol is introduced. (Belt-and-braces: even without the
state write, the fast-path probe at `:251-254` classifies hollowed shadows
as corrupt and lands in the same `resetAndRearm` — D1's deterministic
state write just makes it non-accidental.)

**D6 — no consumer changes.** `erase()` and `EraseReport` are exposed only
on `WikiMemory` (`WikiMemory.ts:39,810-812`); react/expo forwards nothing
(grep-verified). The new report field rides the existing re-export.

## Files touched

- `packages/core/src/services/MaintenanceService.ts` — remediation paths
  (D1), report fields + step + diagnostics (D3), gate placement (D4).
- `packages/core/__tests__/eraseFtsSurfaces.test.ts` — flip the F-MAJOR-1
  test (`:166-179`) to assert **verified + cleared**; new tests per the
  test plan.
- `packages/core/__tests__/eraseVacuumCheckpoint.test.ts` — N2 stays
  (already drops FTS tables first); add one Path-B variant if the fixture
  style allows cheaply.
- `apps/docs` — the erasure guide's module-less paragraph (added in #404)
  gains one sentence: on runtimes without FTS5, erase() now clears the
  orphaned index tables itself and completes verified.

No schema migration, no INTENT change (rule 13 already demands verifiable
erasure), no wrapper changes (D6).

## Test plan (acceptance criteria)

Fixture precedent: `eraseFtsSurfaces.test.ts` AC2 (`:67-86`) — plain-table
shadow stand-ins with a canary row; F1 (`:88-109`) — a real
`indexStrategy: 'minisearch'` store; N2 (`eraseVacuumCheckpoint.test.ts:115-138`)
— `{ name: 'unavailable' }` strategy stub.

1. **Path A, canary forensics:** DB created with FTS5 (canary fact),
   reopened with the module absent (shadow stand-ins per AC2 pattern, or a
   real `minisearch` store after detach per F1), then `erase()`:
   completes with `verified: true`, `ftsOrphansCleared` lists every
   cleared table, and the canary is absent from the store file + WAL
   (reuse the canary harness from `specs/forget-erasure/canary-repro.cjs`).
   [V]
2. **Path A determinism:** after Path A erase, `FTS5_STATE_KEY` reads
   `'detached'`; a subsequent FTS5-capable open rebuilds via
   `resetAndRearm` and serves queries. [V]
3. **Path B:** capable runtime, `indexStrategy: 'minisearch'`, orphaned
   queryable vtabs present → `erase()` drops both vtabs (sqlite_master
   check), clears companions, `verified: true`. [V]
4. **Probe failure honesty:** a stub that makes the probe throw a
   non-module error → `erase_fts_orphan_probe_failed`, `verified: false`.
   [V]
5. **Clear failure honesty:** a stub that makes one DELETE reject →
   `erase_fts_orphan_clear`, `verified: false`, report lists the surface
   reached. [V]
6. **FTS5 runtime unchanged:** the existing strict-drain erase suite stays
   green untouched (no behavior change when `hasStrictDrain()`); the
   F-MAJOR-1 flip is the only changed assertion. [V]
7. **Pending-ledger cover:** module-less erase with rows in
   `fts_pending` / passage pending (undrainable) → cleared under Path A,
   no `erase_index_sync_failed`. [V]
8. Diagnostics: `erase_fts_orphan_cleared` emitted per table. [V]
9. Docs build green. [V]

## Rejected alternatives

- **Reuse `FTS5_RETIRED_TABLES_KEY` for orphans** — live names violate the
  `isRetiredTableName` shape; teaching the matcher live names widens the
  interpolation surface (D2). Rejected.
- **Rename the vtab module-less (`ALTER TABLE`) into a retired name** —
  requires the module; the whole point is its absence. Rejected.
- **Clear only `_content`** — `_data/_idx/_docsize` hold postings and doc
  metadata derived from the text; leaving them defeats the canary test and
  a half-hollowed vtab is exactly the corruption case D5 must not depend
  on accidentally. Rejected.
- **Gate on `!hasStrictDrain()` alone** — a stubbed strategy on a capable
  runtime would pass and take the module-less path against a live vtab
  (investigation landmine 1). The queryable probe is the gate. Rejected.

## Release

MINOR (`core-llm-wiki`). Behavior change is the deliverable: erase()
completes verified on module-less/config-MiniSearch runtimes where it
previously always failed; new optional report field; new diagnostic codes.
No migration, no consumer change (D6).

## Non-goals

- No FTS5 re-creation on module-less runtimes (MiniSearch stays the index).
- No change to retired-table reclamation (D4) or to the strict-drain
  erasure path.
- No `compact()`-style public API — this is erase()-internal remediation.
