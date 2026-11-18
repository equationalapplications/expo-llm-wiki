# erase() on module-less runtimes: clear orphaned FTS5 content so erasure completes verified

**Status: Implemented 2026-11-18 (PR #411) — Path A/B/C shipped; Path A preserves fts5's internal rows so a capable re-open rebuilds (canary-verified)**  
**Issue:** equationalapplications/expo-llm-wiki#407 (second half — the remediation; the honesty half shipped in PR #404).  
**Intent check:** INTENT rule 13 ("Erasure is verifiable") — this spec
extends verified erasure to module-less/config-MiniSearch runtimes and
keeps every failure mode honest (D1 honest-failure branches, D3 report);
no other INTENT rule changes; INTENT itself needs no amendment.  
**Investigation:** read-only evidence report 2026-11-17 (subagent, 14 calls, citations below are from `packages/core` @ `1d388b3f`).

## Problem

On a runtime whose SQLite lacks the FTS5 module — or one configured to
`indexStrategy: 'minisearch'` — `wiki.erase()` currently **cannot complete**
whenever orphaned FTS5 tables exist. `_eraseDrainPassages`
(`packages/core/src/services/MaintenanceService.ts:782-812`) probes
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
   nothing ever clears the shadows (`MaintenanceService.ts:799-811`).
4. The retired-table path already proves the clear pattern is safe on a
   module-less runtime: `_eraseReclaimRetired`'s module-less branch
   (`MaintenanceService.ts:846-853`) DELETEs all five suffixes per retired
   table under the pragma and records the name as `retiredUndroppable`.

## The decisions

**D1 — existence gate per surface (vtab OR any shadow), then three
remediation paths.** Per surface, independently: the surface needs
remediation when the vtab row **or any of its five shadow suffixes**
exists in `sqlite_master` (`sourceTableExists`). Checking the vtab name
alone is wrong twice: the shipped probe checks the **shadow**
`${prefix}entries_fts_content`, not the vtab
(`MaintenanceService.ts:799-802` — `:789` checks the pending ledger), and
the orphan fixtures are exactly "shadows without a vtab" — a partial state
in the wild would otherwise be declared clean with `verified: true`. If
**nothing** exists for the surface (a DB that never saw FTS5, or a fully
detached one), no probe, no clear, no `ftsOrphansCleared` entry; erase
proceeds. Otherwise, one probe decides the path — only possible when the
vtab row exists: `SELECT 1 FROM ${prefix}entries_fts LIMIT 1`, errors
classified with the same `/no such module/i` match the codebase already
uses (`MaintenanceService.ts:840`):

- **Path A — vtab present, module-less (`no such module`):** the vtab is
  inert. DELETE the text-bearing rows of every existing shadow suffix of
  `entries_fts` and `source_passages_fts`, plus the
  plain companions that can hold text and are undrainable here — exact
  names `${prefix}fts_pending`, `${prefix}fts_map`,
  `${prefix}source_passages_fts_pending`,
  `${prefix}source_passages_fts_map` (`fts5Sql.ts:57-62`; each gated on
  `sourceTableExists` — a properly detached store has none of them, since
  `detachFts5` drops them: the entries-side companions via
  `fts5LedgerDropSql`, `fts5Sql.ts:157-163`, the passage map/pending via
  `createIndexStrategy.ts:66-73`). Then ensure
  `FTS5_STATE_KEY = 'detached'` in metadata (idempotent; normally already
  set by `detachFts5`) so the next capable open takes the **deterministic**
  rename-retire + rebuild path (`Fts5IndexStrategy.ts:245`
  `resetAndRearm`), not a corruption-driven one.
- **Path B — vtab present and queryable, strategy `instanceof
  MiniSearchIndexStrategy` (config-chosen `indexStrategy:
  'minisearch'`):** `DELETE FROM` a live FTS5 vtab's shadows is corruption
  territory (investigation landmine 1) — but the module is present and the
  MiniSearch choice is a durable host decision, so **DROP the orphaned
  vtabs outright** (`DROP TABLE IF EXISTS ${prefix}entries_fts`, same for
  passages), drop the FTS **triggers — entries-side and passage-side**
  (`fts5LedgerDropSql`, `fts5Sql.ts:157-163`), clear the same four plain
  companions as Path A (existence-gated: `${prefix}fts_pending`,
  `${prefix}fts_map`, `${prefix}source_passages_fts_pending`,
  `${prefix}source_passages_fts_map`), and set
  `FTS5_STATE_KEY = 'detached'` (mirroring `detachFts5`'s effects) so no
  live-ledger writes dangle. If the host ever switches back to fts5, the
  next open sees `'detached'` and rebuilds via `resetAndRearm` — that
  rebuild is a documented consequence, not an accident. (Reachability
  note: on a real config-minisearch store `detachFts5` usually already
  DROPped the vtab and dropped these companions/triggers — the entries
  companions via `fts5LedgerDropSql`, the passage map/pending via
  `createIndexStrategy.ts:66-73` — so Path B covers the early-return and
  passage-ledger-gated edges, `createIndexStrategy.ts:66-79`.)
- **Path C — shadows present, vtab row absent:** nothing to probe (the
  vtab cannot be queried or dropped without the module). The shadows are
  plain tables: DELETE the existing suffixes directly (same suffix set as
  Path A, existence-gated). This is the F-MAJOR-1 fixture shape
  (`eraseFtsSurfaces.test.ts:166-179`) and the partial-detach state.
- **Honest failures:** probe error of any other class (vtab present,
  non-module error) → `erase_fts_orphan_probe_failed` (failedStep
  `index_sync`). Strategy `instanceof UnavailableIndexStrategy` with
  remediation-required surfaces → `erase_fts_index_unavailable`
  (failedStep `index_sync`, `verified: false`): an Unavailable strategy is
  a transient init failure that deliberately preserves the ledger and a
  healthy, queryable index (`UnavailableIndexStrategy.ts:6-10`) — dropping
  it would destroy working state for an outage the next open may recover
  from. Unknown duck-typed strategies are treated the same way: no DROP
  unless the strategy is positively a `MiniSearchIndexStrategy`.

**D2 — exact-name allowlist, never a pattern.** Only prefix-joined exact
names (`${prefix}entries_fts`, `${prefix}source_passages_fts`, their five
suffixes, and the four named plain companions of D1) are interpolated into
the clear SQL — mirroring `isRetiredTableName`'s discipline
(`fts5Sql.ts:19-21`, "Only engine-shaped names are ever interpolated into
reclamation SQL"). Every name is gated on `sourceTableExists` before its
DELETE, so a missing companion (normal after a clean detach) is a no-op,
not an error. The generic retired-list machinery (`FTS5_RETIRED_TABLES_KEY`)
is **not** reused: live names do not fit the `entries_fts_retired_N` shape,
and module-less `ALTER TABLE ... RENAME` of a vtab is not relied on.

**D3 — report stays honest.** `EraseReport`
(`MaintenanceService.ts:226-245`) gains `ftsOrphansCleared: string[]`
(mirror `retiredUndroppable`) and the `failedStep` union gains
`'fts_orphan_clear'` — a deliberate split: probe failures keep the
existing `index_sync` step (they are index-sync-class), while a failed
clear is its own step so hosts can distinguish "could not look" from
"could not clear"; the bare `failedStep` union at
`MaintenanceService.ts:243` gains the new member. Each surface is pushed
to `ftsOrphansCleared` only **after** that surface fully clears; the
step is recorded as `{ step: 'fts_orphan_clear', outcome: 'ok' }` in `report.steps`
when remediation ran (a mid-method throw skips the record) and emits a new diagnostic
`erase_fts_orphan_cleared` per cleared table. If any clear or the metadata
write fails mid-way: `EraseStepError('erase_fts_orphan_clear', ...)`,
`verified: false`. The `erase_orphaned_fts_content` code is RETIRED by this spec: its only
throw site was replaced by the remediation; the honest failures are
`erase_fts_orphan_probe_failed`, `erase_fts_orphan_clear` and
`erase_fts_index_unavailable`.

**D4 — gate placement and ordering.** The remediation replaces the
probe-and-throw blocks inside the existing `!hasStrictDrain()` branch
(`MaintenanceService.ts:782-812`) and **runs before the pending-ledger
throw loop** (`:783-798`): under Paths A/B/C the pending companions are
cleared by the remediation itself, so test 8's "cleared under Path A, no
`erase_index_sync_failed`" holds; after the remediation, the pending-ledger
check re-runs and still throws `erase_index_sync_failed` /
`erase_passage_drain_failed` for any rows that remain (honesty for states
the remediation does not cover, e.g. the `UnavailableIndexStrategy`
failure above). **Dispatch order, stated once:** per-surface existence
gate → strategy check (`instanceof`, consulted only for surfaces the gate
flags for remediation) → vtab probe → path body (clears incl.
companions) → `FTS5_STATE_KEY` write → pending-ledger re-check. The
strict-drain (FTS5) branch is untouched, and its
erasure behavior is unchanged byte-for-byte; the
`canReclaimRetired()` retired-table machinery is untouched.

**D5 — later capable open stays correct.** Path A leaves the vtab row plus
hollowed shells in `sqlite_master`. The next capable open sees
`state='detached'` → `resetAndRearm` renames the vtab to
`entries_fts_retired_N` (`:324`), recreates it empty, and arms a rebuild —
and from then on the renamed table fits `isRetiredTableName`, so the
existing reclaim machinery DROPs it (`Fts5IndexStrategy.ts:464-479`). No
new cross-open protocol is introduced. (As implemented, Path A additionally PRESERVES fts5's internal rows —
`%_data` ids 1 (averages) and 10 (structure) and the `%_config` table;
none hold user text — so the inert vtab stays readable and the capable
re-open's retire path works. The canary in this folder proves the
module-less → capable transition end-to-end.)

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
   Note: the stand-in proves the DELETE SQL; at least one Path A case must
   run against a real SQLite build without FTS5 (or the CI matrix's
   module-less slot) to prove the runtime classification end-to-end. [V]
2. **Path A determinism:** after Path A erase, `FTS5_STATE_KEY` reads
   `'detached'`; a subsequent FTS5-capable open rebuilds via
   `resetAndRearm` and serves queries. [V] manually verified 2026-11-18
   (module-less sqlite3 CLI), see canary-ac2.test.ts + canary-evidence.md —
   not executable in CI
3. **Path B:** capable runtime, orphaned **queryable** vtabs present, and
   the strategy positively a `MiniSearchIndexStrategy` (construct via a
   real config-minisearch store, or an `instanceof`-real stub — the N2
   `{ name: 'unavailable' }` duck-type does NOT qualify) → `erase()` drops
   both vtabs (sqlite_master check), clears companions, sets
   `FTS5_STATE_KEY = 'detached'`, `verified: true`. [V]
4. **Unavailable honesty:** `instanceof UnavailableIndexStrategy` with
   remediation-required surfaces → `erase_fts_index_unavailable`,
   `verified: false`, index tables untouched (sqlite_master unchanged).
   [V]
5. **Probe failure honesty:** a stub that makes the probe throw a
   non-module error → `erase_fts_orphan_probe_failed`, `verified: false`.
   [V]
6. **Clear failure honesty:** a stub that makes one DELETE reject →
   `erase_fts_orphan_clear`, `verified: false`; the failed surface is not
   in `ftsOrphansCleared` (pushed only after full clear, D3). [V]
7. **FTS5 runtime unchanged:** the existing strict-drain erase suite stays
   green untouched (no behavior change when `hasStrictDrain()`); the
   F-MAJOR-1 flip (now Path C) is the only changed assertion. [V]
8. **Pending-ledger cover:** module-less erase with rows in
   `${prefix}fts_pending` / passage pending (undrainable) → cleared under
   Path A before the pending throw re-runs, no `erase_index_sync_failed`;
   a leftover row the remediation did not cover still throws honestly.
   [V]
9. **Path C / never-FTS clean:** shadows without a vtab row (F-MAJOR-1
   shape) → cleared, `verified: true`; a module-less DB that never had
   any FTS tables → `verified: true`, `ftsOrphansCleared: []`, no probe
   thrown. [V]
10. Diagnostics: `erase_fts_orphan_cleared` emitted per table. [V]
11. Docs build green. [V]

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
