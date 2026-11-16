# Investigation — #401: forget must erase (FTS5 secure-delete, chain forget, compact())

**Date:** 2026-11-16 · **Status:** Rev 2 (Opus r1 findings folded; pre-Fable)
**Issue:** equationalapplications/expo-llm-wiki#401 · **Repo baseline:** `27f8e5e9` (main after #400, v9.2.0)
**Evidence tags:** [V] = controller-verified against this tree / live driver; [C] = child- or web-reported, not independently reproduced.
**Repro:** `specs/forget-erasure/canary-repro.cjs` — committed, runnable from the repo root; §2 table is its output verbatim.

## 1. Summary

The issue's central claim is **correct and reproduced**: after `forget()` plus the documented
hard-delete steps, the deleted fact's text remains recoverable from the database file. Erasure
requires addressing **four primary retention surfaces in the store file** (§3) **plus the
derived and upstream copies of fact text elsewhere in the store** (§3.5) — the canary
acceptance test fails if only the primary surfaces are fixed. The issue's proposed recipe
works at the store level, with corrections (SQLite floor version; the core pragma is required
alongside the FTS5 option; VACUUM shrinks, not erases) verified by experiment.

## 2. Repro table (live driver: better-sqlite3 13.0.3, bundled SQLite 3.53.4, WAL mode) [V]

Output of `node specs/forget-erasure/canary-repro.cjs` (byte-scan of the db file and `-wal`):

| # | Scenario | Canary in db file | Canary in wal |
|---|---|---|---|
| A | insert + `wal_checkpoint(TRUNCATE)` (baseline) | **present** | clean |
| B | plain `DELETE` + checkpoint (≈ current engine behavior after prune hard-delete) | **present** | clean |
| C1 | FTS5 `'secure-delete'` option only; delete + checkpoint (no VACUUM) | **present** (row-content b-tree leaf survives) | clean |
| C2 | scenario C1 state + `VACUUM` | clean (VACUUM drops the dead leaf) | clean |
| D | core `PRAGMA secure_delete=ON` **+** FTS5 option; delete + checkpoint | **clean** | clean |
| E | scenario D + `VACUUM` | clean | clean |

Notes [V]: under D, erasure is complete at the checkpoint step — `VACUUM` is not required for
erasure, only to release pages/shrink the file (D vs E are both clean). Under C1 the option
alone leaves the FTS5 row content (`id UNINDEXED, body` cell) in the table b-tree; only a
VACUUM removes it (C1 vs C2). FTS5 `MATCH` and `'integrity-check'` stay green after secure
deletes. In these runs the WAL never held the canary because every step ran a `TRUNCATE`
checkpoint; hosts without a truncating checkpoint keep old frames in `-wal` (§7 pins this).

## 3. Primary retention surfaces — the store file (all [V] against this tree)

1. **FTS5 postings survive deletes by design.** `entries_fts` and `source_passages_fts` are
   ordinary-content FTS5 virtual tables (`packages/core/src/services/search/fts5Sql.ts:51-54`,
   `:215-218`). Without the FTS5 `'secure-delete'` option, a deleted row's postings remain in
   segments until merges reclaim them; the only explicit `'merge'` targets retired tables
   (`services/search/Fts5IndexStrategy.ts:446`).
2. **Deleted row content is not zeroed.** The engine never sets `PRAGMA secure_delete` — zero
   hits in `packages/core/src` and the deleting-data guide [V]. Hard deletes (`runPrune`,
   `clearAll`, source-pointer wipes — the `source_ref_index` hard deletes at
   `services/MaintenanceService.ts:642-644` and the by-source path at `:712-719`) leave content
   bytes in freed b-tree pages.
3. **Soft-delete retention window.** `forget()` soft-deletes (`EntryRepository.softDelete`,
   `repositories/EntryRepository.ts:560-573`); rows hard-delete only via `runPrune` after
   `retainSoftDeletedFor` (engine default 7 days, `services/MaintenanceService.ts:253`).
4. **WAL/journal residue is host-dependent.** The engine sets no `journal_mode` [V]; hosts that
   enable WAL keep old content in `-wal` frames until a truncating or restarting checkpoint.
   The only checkpoint is `MetadataRepository.vacuum()` (`repositories/MetadataRepository.ts:172-175`),
   reached only via `runPrune({ vacuum: true })`. Rollback-journal hosts hold the same residue
   in `-journal` until it is deleted at commit.

Additionally, the supersession chain surfaces: `entries.superseded_by` / `superseded_at`
(`db/schema.ts:38-39`, partial index `:309-311`). A superseded fact that is forgotten still has
its chain neighbors on disk until separately pruned.

## 3.5 Derived and upstream copies of fact text (Opus r1 B1) — the census

Every table whose text columns can hold fact content, with what `forget()` does today and what
the spec must decide:

| Copy | Anchor | Holds fact text? | Today | Spec decision |
|---|---|---|---|---|
| `entries` (+ tasks) body/title | `db/schema.ts:28-45` | yes | soft-deleted; hard-deleted by prune | primary surface; §3 items 2-3 |
| `events` | `db/schema.ts:124-128` (`summary TEXT NOT NULL`) | **yes** — the librarian rebuilds facts from them | `forget({entryId})` keeps events; only `clearAll + includeEvents` hard-deletes (guide lines 205-216) | must-erase path: erasure recipe must include an event disposition, or the guide must scope the promise to "after the documented steps" (which today means clearAll+includeEvents+prune+vacuum) |
| `outbox` | `db/schema.ts:156-160` (`payload TEXT`) | **yes** — unacked rows hold fact text (guide 218-220) | left in place | guide already instructs hosts to drain (`markOutboxEventsProcessed()`); spec documents it as a host step |
| `source_passages` / `source_documents` | source-store tables | **yes** — stored source text | hard-deleted only under `sourceRef`/`sourceHash` selectors (`MaintenanceService.ts:687-701`); **`forget({entryId})` leaves the fact's source text on disk** | must-erase gap for entryId-forgets; spec decides (erase on chain-forget, document otherwise) |
| entity summary | `meta.value` under `entitySummaryMetaKey` (`MaintenanceService.ts:664`) | yes — summarized fact content | deleted only on `clearAll` | same decision shape as events |
| graph edges | `db/schema.ts:112-116` | no — id/type columns only [V] | deleted on `clearAll` | no text to erase |
| graph nodes | stored as entries (facts) | — | covered by entry deletion | no separate surface |
| `vector_removals` ledger | `db/schema.ts:177-185` | no — ids/timestamps only [V] | retained by design (durable-vector-removal spec) | no text to erase |
| export files | `ImportExportService` dumps | yes, outside the store | — | document (guide already warns re-import brings data back) |

**Consequence for §7 (Opus r1 B1):** the canary acceptance test must ingest through the public
write path (the event-producing path), not a raw FTS insert — otherwise it can "pass" by
skipping the event copy. The spec must scope the erasure promise per copy above, explicitly.

## 4. Corrections to the issue's premises

- **SQLite floor is 3.42.0, not 3.44.** The FTS5 `'secure-delete'` option shipped in 3.42.0
  ("Add the FTS5 secure-delete command", release history, sqlite.org changelog). Once a table
  has had rows deleted under the option, its FTS5 file format moves to version 5 and older
  FTS5 builds cannot read it ("invalid fts5 file format (found 5, expected 4)") [C-web].
  Experiment D read the table fine on 3.53.4 [V].
- **The FTS5 option alone does not erase row content** (C1). Both the option and the core
  pragma are required — the docs' warning that `PRAGMA secure_delete` only scrubs ordinary
  tables pairs with the FTS5 option owning the inverted index [C-web].
- **VACUUM is a file-shrink step, not an erasure step**, once the pragma + option are on
  (D vs E) [V].

## 5. Known upstream risks (secure-delete path)

- **Merge bug, directly in the engine's blast radius [C-web, pinned]:** with secure-delete on,
  a merge can leave stale postings that resurrect a deleted rowid (trigger: delete with the
  option off, reinsert, merge, delete again with the option on). Reported 2026-10-22, sqlite.org
  bugs `8cf71b8e…` / `737cb495…`; **wrong in 3.46.0, 3.50.2, 3.51.0, 3.53.2 and trunk at report
  time**; fixed on trunk 2026-10-26 (commit `0b486e53a4`), **in no released version at
  investigation time**. The engine runs automerges routinely (`Fts5IndexStrategy`), and
  real stores have pre-migration deletes — the trigger layout exists in the wild. The
  migration probe must gate on the SQLite version (both capability ≥3.42 and the known-buggy
  range), and the test plan must cover merge-after-secure-delete with `'integrity-check'`.
- A second bug affects `detail=none` tables only (doclist-index corruption; fixed trunk
  `2d7df34b62`) — **out of scope**: both engine tables use the default `detail=full` [V,
  `fts5Sql.ts:51-54`, `:215-218` specify no detail option].
- Historical: 3.46.1 fixed false-positive integrity-check reports in secure-delete mode
  (release history) [C-web].
- **One-way door (Opus r1 M5):** after the first secure delete the tables are format-5; an app
  rollback, older Expo binary, or desktop tool on an older build then fails to open the index.
  The degrade path must catch the format-5 read error and fall back to the no-FTS path
  (precedent: migration v1 is a no-op for stores without FTS support, `db/migrations.ts:6-12`)
  or rebuild the index.
- **Portability:** verified only on the Node floor (better-sqlite3 → SQLite 3.53.4) [V]. The
  Expo side uses expo-sqlite's bundled SQLite build; its exact bundled version was not pinned.
  The migration must **capability-probe at runtime** (attempt the option insert inside a
  transaction and degrade with a surfaced warning on refusal) rather than assume support.

## 6. Where the fixes land (file:line anchors, this tree)

- Migration: new **v18** in `db/migrations.ts` (latest is v17 at `:388`); set the option on both
  FTS tables when they exist. Because the FTS tables are created lazily by `Fts5IndexStrategy.init`
  (never by `setupDatabase`), **fresh stores get the option at init time** in
  `services/search/Fts5IndexStrategy.ts`, and any later-created/rebuilt table (retired-table
  lifecycle, `delistRetired`, passage tables) must set it too.
- Core pragma placement (Opus r1 M3): **the engine never opens the connection** — `createWiki(db, …)`
  receives a host-opened handle (guide line 61), and `secure_delete` is per-connection. So:
  set `PRAGMA secure_delete=ON` in `setup()` on the provided handle, **read the pragma back and
  surface it**; and document that any host connection that writes to wiki tables must set the
  pragma itself (guide §"If your app writes to the wiki tables itself", lines 157-166) — deletes
  through such a connection leave residue otherwise.
- Chain forget: `WikiMemory.forget()` (`WikiMemory.ts:1089`) → `MaintenanceService.forget()`
  (`MaintenanceService.ts:602`); chain walk on `superseded_by` (§8 Q1 for semantics).
- `compact()`: compose existing primitives — prune with `retainSoftDeletedFor: 0` **inheriting
  runPrune's safety holds**, FTS `'optimize'` (never used today [V]), `wal_checkpoint(TRUNCATE)`,
  `VACUUM` (`MetadataRepository.vacuum()`).
- Docs: `apps/docs/src/content/docs/guides/deleting-data.md` (224 lines) gains the erasure note,
  the host-connection pragma requirement, and the copy census scoping (§3.5).

**Alignment anchors** (quoted; INTENT.md checked before implementation per AGENTS.md):
- INTENT.md:135 — "### 2. Your database stays yours" — the engine writes only under the host's
  prefix; the charter decides what deletion must mean for users.
- INTENT.md:468 — "charter rule 8 promises deletion, and a delete the host's index never heard
  about is not done" — the standing precedent (durable-vector-removal) that erasure claims must
  reach the actual storage surface, not just the API response.

## 7. Acceptance criterion (from the issue, pinned by Opus r1 M2/B1)

Canary-string forensic test: after `forget()` plus the documented steps, the string is absent
from the database file **and** the journal files. Pinned shape:
- **Ingest through the public write path** (`remember`/`ingestDocument`) so the event and outbox
  copies exist (§3.5).
- Scan the **db file, `-wal`, `-journal`, and `-shm`** at every checkpoint of the test.
- `compact()` is the step that runs `wal_checkpoint(TRUNCATE)`; **erasure is guaranteed at
  `compact()` time, not at `forget()` time** (soft-delete window + WAL residue between them).
- Scenario D is the mechanism proof [V]; the test reproduces it through the engine's public API
  in a tempdir.

## 8. Open questions for the spec (owner input only where product-shaped)

1. **Chain direction for the forget option (Opus r1 m3):** `superseded_by` chains fan in —
   several old versions can point at one newer fact, so a two-direction walk sweeps in sibling
   lineages; and forgetting forward deletes the current live fact. Recommendation: walk the
   full lineage reachable from the named fact, document the fan-in semantics, and require the
   `dryRun` preview to list every id the walk touches before deletion.
2. **Can hosts disable `secure_delete`?** Recommendation: always on in `setup()` on the engine's
   handle, no opt-out in v1; hosts' *other* connections must set it themselves (documented).
   Revisit only on a real perf complaint.
3. **Degrade path when the runtime SQLite refuses the option or sits in the known-buggy range
   (§5):** recommend: core pragma always set (supported since 3.2-era); FTS5 option set only
   when version gate passes, with a surfaced warning; format-5 read errors on old builds fall
   back to the no-FTS path or rebuild. Document the degradation in the deleting-data guide.
4. **`compact()` scope and the undo window (Opus r1 M4):** `runPrune` never hard-deletes facts
   whose external-index removal is unconfirmed (guide 55-56) and holds librarian-unread events
   (guide 213-216) — `compact()` must inherit both holds and **report what it held back**. A
   store-wide `retainSoftDeletedFor: 0` also wipes every entity's 7-day undo window in one
   call: **owner question** — store-wide API with 0-day retention (recommended shape), or
   entity-scoped, and whether the undo-window wipe needs its own confirmation knob.

## 9. Not checked by this investigation

- expo-sqlite's actual bundled SQLite version on SDK 58 (§5 portability) — resolved at
  implementation time by the capability probe + CI on the Node floor.
- Performance cost of secure deletes on large indexes (accepted per issue; consumer gated on
  host fix only).
- Exact release that will carry the merge-bug fix (§5) — trunk commit exists; re-check the
  release history at implementation time before pinning the version gate's upper bound.

*(Opus r1 m6 fold: export files are listed in the §3.5 census — copies outside the store;
the guide already warns that re-importing brings data back.)*
