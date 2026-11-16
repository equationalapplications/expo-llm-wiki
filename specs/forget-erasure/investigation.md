# Investigation — #401: forget must erase (FTS5 secure-delete, chain forget, compact())

**Date:** 2026-11-16 · **Status:** Rev 4 (Opus r1 + Fable r1/r2 findings folded; delta re-present pending)
**Issue:** equationalapplications/expo-llm-wiki#401 · **Repo baseline:** `27f8e5e9` (main after #400, v9.2.0)
**Evidence tags:** [V] = controller-verified against this tree / live driver; [C] = child- or web-reported, not independently reproduced.
**Repro:** `specs/forget-erasure/canary-repro.cjs` — committed, runnable from the repo root; §2 table is its output verbatim. Harness (Fable r2 B1/M1/M2): every scenario runs in a **fresh database file**; "option off" scenarios **assert `ft_config` holds no `secure-delete` row** before the delete; the deleted row carries a **unique probe term**; every scenario ends with `'integrity-check'` + MATCH probes; 300 filler rows push the index into a **multi-segment layout**.

## 1. Summary

The issue's central claim is **correct and reproduced**: after `forget()` plus the documented
hard-delete steps, the deleted fact's text remains recoverable from the database file (scenario
B: canary present after a plain delete + checkpoint, on a multi-segment index). Erasure
requires addressing **four primary retention surfaces in the store file** (§3) **plus the
derived and upstream copies of fact text elsewhere in the store** (§3.5).

**Mechanism finding (Fable r1 B1 → re-measured unconfounded after Fable r2 B1):** the FTS5
`'secure-delete'` option the issue proposes is **unusable as the required mechanism on every
runtime the package supports today** — the upstream merge bug (§5) is unfixed in every released
SQLite. The guaranteed erasure mechanism is **compact-time**: core `PRAGMA secure_delete=ON` +
plain deletes + FTS `'optimize'` or `'rebuild'` at `compact()` + a truncating checkpoint —
measured clean in scenarios F and G **with the option genuinely off** (`ft_config` asserted),
on multi-segment indexes, with green integrity and correct MATCH probes. Scenario H isolates
the pragma as the load-bearing piece: rebuild **without** the pragma leaves the canary in
freed pages. The option remains valuable as an **optional immediate-erasure enhancement**
behind a version gate.

**On VACUUM (Fable r1 M4, measured):** VACUUM drops freed pages from the file, so scenario B′
(plain delete + VACUUM, no pragma, no option) is clean — on the measured layout, where the
deleted row sat in the same segment as its insert (postings removed outright, no delete
markers). This is **measured, not guaranteed**: where a deleted row's postings survive in older
segments under delete markers, term bytes live in live `%_data` pages that VACUUM copies as-is;
only a merge of those segments (or the option) removes them. VACUUM shrinks the file; the
guarantee comes from pragma + merge (`'optimize'`/`'rebuild'`).

## 2. Repro table (live driver: better-sqlite3 13.0.3, bundled SQLite 3.53.4, WAL mode) [V]

Output of `node specs/forget-erasure/canary-repro.cjs` (byte-scan of db file and `-wal`;
`integ` = FTS5 `'integrity-check'`; `deleted-term` = MATCH on the deleted row's unique probe
term; `live-rows` = MATCH on live rows):

| # | Scenario (fresh db each) | Canary in db | wal | integ | deleted-term | live-rows |
|---|---|---|---|---|---|---|
| A | insert + `wal_checkpoint(TRUNCATE)` (baseline) | **present** | clean | ok | `["TARGET"]` | 300 |
| B | plain `DELETE` + checkpoint (pragma off, option off) | **present** | clean | ok | `[]` | 300 |
| B′ | plain `DELETE` + `VACUUM` (pragma off, option off) | clean | clean | ok | `[]` | 300 |
| C1 | FTS5 `'secure-delete'` option only: delete + checkpoint | **present** | clean | ok | `[]` | 300 |
| C2 | scenario C1 continued with `VACUUM` | clean | clean | ok | `[]` | 300 |
| D | `PRAGMA secure_delete=ON` + option: delete + checkpoint | **clean** | clean | ok | `[]` | 300 |
| E | scenario D continued with `VACUUM` | clean | clean | ok | `[]` | 300 |
| F | `PRAGMA secure_delete=ON`, **option off**: delete + `'optimize'` + checkpoint | **clean** | clean | ok | `[]` | 300 |
| G | `PRAGMA secure_delete=ON`, **option off**: delete + `'rebuild'` + checkpoint | **clean** | clean | ok | `[]` | 300 |
| H | pragma **off**, option off: delete + `'rebuild'` + checkpoint | **present** | clean | ok | `[]` | 300 |

Notes [V]:
- **B is the bug**: postings for the deleted rowid are gone (`deleted-term: []`) but the canary
  bytes stay in the freed row-content pages.
- **F and G are the compact-time mechanism proof**, with the option asserted off via `ft_config`.
- **H isolates the pragma**: `'rebuild'` alone purges postings (`deleted-term: []`) but leaves
  the canary in freed pages — `PRAGMA secure_delete=ON` is the load-bearing piece.
- In every run the WAL held no canary because each step ended in a `TRUNCATE` checkpoint;
  hosts without a truncating checkpoint keep old frames in `-wal` (§7 pins this).
- B′ caveat: clean because the deleted row shared its insert's segment (no delete markers);
  §1 scopes the residual risk.

## 3. Primary retention surfaces — the store file (all [V] against this tree)

1. **FTS5 postings survive deletes by design.** `entries_fts` and `source_passages_fts` are
   ordinary-content FTS5 virtual tables (`packages/core/src/services/search/fts5Sql.ts:51-54`,
   `:215-218`). Without the FTS5 `'secure-delete'` option, deletes leave postings in segments
   until merges reclaim them (scenario B, H); nothing in `packages/core/src` sets
   `automerge`/`crisismerge`, so FTS5 defaults apply on the live tables; the only explicit
   `'merge'` targets retired tables (`services/search/Fts5IndexStrategy.ts:446`).
2. **Deleted row content is not zeroed.** The engine never sets `PRAGMA secure_delete` — zero
   hits in `packages/core/src` and the deleting-data guide [V]. Hard deletes (`runPrune`,
   `clearAll` — the `source_ref_index` hard delete at `services/MaintenanceService.ts:642-644`
   and the source-store hard deletes at `:646-649`; the by-source `source_ref_index` delete at
   `:715-716` is a **soft** delete, `softDeleteByEntityAndSourceRef`) leave content bytes in
   freed b-tree pages (scenarios B, H).
3. **Soft-delete retention window.** `forget()` soft-deletes (`EntryRepository.softDelete`,
   `repositories/EntryRepository.ts:561-576`); rows hard-delete only via `runPrune` after
   `retainSoftDeletedFor` (engine default 7 days, `services/MaintenanceService.ts:253`).
4. **WAL/journal residue is host-dependent.** The engine sets no `journal_mode` [V]; hosts that
   enable WAL keep old content in `-wal` frames until a truncating or restarting checkpoint.
   The only checkpoint is `MetadataRepository.vacuum()` (`repositories/MetadataRepository.ts:172-175`),
   reached only via `runPrune({ vacuum: true })` — and it runs **before** the VACUUM with no
   trailing checkpoint (Fable r1 m2: in WAL mode VACUUM writes the rebuilt file through the
   WAL, so post-VACUUM the main file still holds pre-VACUUM pages until a later checkpoint).
   Rollback-journal hosts hold the same residue in `-journal` until it is deleted at commit.

Additionally, the supersession chain surfaces: `entries.superseded_by` / `superseded_at`
(`db/schema.ts:38-39`, partial index `:309-311`).

## 3.5 Derived and upstream copies of fact text (Opus r1 B1 + Fable r1 M1) — the census

Every table whose text columns can hold fact content **or fact-derived/identifying data**, with
what `forget()` does today and what the spec must decide:

| Copy | Anchor | Holds | Today | Spec decision |
|---|---|---|---|---|
| `entries` (+ tasks) title/body | `db/schema.ts:8-9` | fact text | soft-deleted; hard-deleted by prune | primary surface; §3 items 2-3 |
| `entries.embedding` / `embedding_blob` | `db/schema.ts:20-21` | **no text, but derived from text** (vectors) | soft-deleted with the row; hard-deleted by prune; external removals via durable-vector-removal | explicit "no text, but derived" row (Fable r1 M1) |
| embedding-failure markers | `db/schema.ts:33-35` | ids + error state, no text | with the row | no text to erase |
| `events` | `db/schema.ts:124-128` (`summary TEXT NOT NULL`) | **fact text** — the librarian rebuilds facts from them | `forget({entryId})` keeps events; only `clearAll + includeEvents` hard-deletes (guide lines 207-216) | must-erase path or scoped promise (below) |
| `outbox` | `db/schema.ts:156-162` (`payload TEXT` at `:162`) | **fact text** — unacked rows hold it (guide 218-220) | left in place | guide already instructs hosts to drain (`markOutboxEventsProcessed()`); documented as a host step |
| `source_documents.text` | `db/schema.ts:74` (70-72 are id/entity_id/source_ref) | **fact/source text** | hard-deleted only under `sourceRef`/`sourceHash` selectors (`MaintenanceService.ts:687-701`); **`forget({entryId})` leaves it on disk** | must-erase gap for entryId-forgets |
| `source_passages` | `db/schema.ts:68` — **offsets only, no text stored** ("Passage text is not stored: offsets … slice source_documents.text") | no text; identifies source spans | hard-deleted with the source-store block | covered by the source_documents decision |
| `source_passages_fts` | virtual table | **indexed source text** | rebuilt from the store | covered by the same decision + §3.1 |
| entity summary | `meta.value` under `entitySummaryMetaKey` (`MaintenanceService.ts:664`) | summarized fact content | deleted only on `clearAll` | same decision shape as events |
| entity ontology manifest | `entity_manifests.manifest_json` (`db/schema.ts:144-149`; guide 221-224 — "node and edge types learned from the entity's facts") | fact-**derived** type names, not fact text | wipe leaves it (guide) | document as left (Fable r1 M1) |
| `entries.source_ref` / `source_pointer`, `source_ref_index.source_ref` | entries table; source_ref_index | **no fact text, but identifying data** (filenames, URLs) | pointer index rows hard-delete on source wipes; entry rows soft-delete | spec decides/document (Fable r1 M1) |
| graph edges | `db/schema.ts:112-116` | no — id/type columns only [V] | deleted on `clearAll` | no text to erase |
| graph nodes | stored as entries (facts) | — | covered by entry deletion | no separate surface |
| `vector_removals` ledger | `db/schema.ts:177-185` | no — ids/timestamps only [V] | retained by design (durable-vector-removal spec) | no text to erase |
| export files | `ImportExportService` dumps | fact text, outside the store | — | document (guide already warns re-import brings data back) |

**Consequence for §7:** the canary acceptance test must ingest through the public write path
(`remember` `WikiMemory.ts:1163` / `ingestDocument` `:1177`), not a raw FTS insert — otherwise
it can "pass" by skipping the event copy. The spec must scope the erasure promise per copy
above, explicitly.

## 4. Corrections to the issue's premises

- **SQLite floor is 3.42.0, not 3.44.** The FTS5 `'secure-delete'` option shipped in 3.42.0
  (release history). Once a table has had rows deleted under the option, its FTS5 file format
  moves to version 5 and older FTS5 builds cannot read it ("invalid fts5 file format (found 5,
  expected 4)") [C-web]. Experiment D read the table fine on 3.53.4 [V].
- **The FTS5 option alone does not erase row content** (C1). Both the option and the core
  pragma are required [C-web].
- **VACUUM (Fable r1 M4, measured):** drops freed pages (B′) but cannot scrub term bytes that
  survive under delete markers in live `%_data` pages; it shrinks the file and is part of the
  compact-time recipe, not the erasure mechanism itself.
- **The option cannot be the required mechanism (Fable r1 B1):** the version gate over the
  known-buggy range (§5) passes **zero supported runtimes today** — better-sqlite3 13.0.3
  bundles 3.53.4 (`packages/core/package.json:69`), and the expo-sqlite peer range
  `^14.0.0 || ^15.0.0 || ^55…^58` (`packages/expo/package.json:70`) all bundle in-range
  releases. The guaranteed mechanism is compact-time (F/G, option asserted off); the option is
  an optional immediate-erasure enhancement behind the gate (§8 Q3).

## 5. Known upstream risks (secure-delete path)

- **Merge bug, directly in the engine's blast radius [C-web, pinned with full URLs]:**
  with secure-delete on, a merge can leave stale postings that resurrect a deleted rowid
  (trigger: delete with the option off, reinsert, merge, delete again with the option on).
  Report (2026-10-22): https://sqlite.org/bugs/info/8cf71b8e652dce27d7037945a381f523971b47eb8a2d0a0e9676066c074daf48 —
  **wrong in 3.46.0, 3.50.2, 3.51.0, 3.53.2 and trunk at report time**; fixed on trunk
  2026-10-26: https://sqlite.org/src/info/0b486e53a4 — **in no released version at
  investigation time** (3.53.4, the Node floor, sits in the range and is not listed as fixed;
  treat as unfixed). The trigger layout arises from **FTS5's default automerge on the live
  tables** — fired by ordinary inserts (nothing in `packages/core/src` sets
  `automerge`/`crisismerge`, so defaults apply [V]); real stores have pre-migration deletes, so
  v18 flipping the option on would recreate the published trigger on the next
  delete-reinsert-merge cycle. (`Fts5IndexStrategy.ts:446` merges **retired** tables, which are
  merge-to-reclaim-then-drop with no later deletes — secondary note only, not the trigger.)
- A second bug affects `detail=none` tables only: report
  https://sqlite.org/bugs/info/e380b6876cc7dfb999b5d06dfba979a74244e7053c3e1d41350b65410a96b0c1,
  fix https://sqlite.org/src/info/2d7df34b62 — **out of scope**: both engine tables use the
  default `detail=full` [V, `fts5Sql.ts:51-54`, `:215-218` specify no detail option].
- Historical: 3.46.1 fixed false-positive integrity-check reports in secure-delete mode
  (release history) [C-web].
- **One-way door (Opus r1 M5):** after the first secure delete the tables are format-5; an app
  rollback, older Expo binary, or desktop tool on an older build then fails to open the index.
  The degrade path must catch the format-5 read error and fall back to the no-FTS path
  (precedent: migration v1 is a no-op for stores without FTS support,
  `db/migrations.ts:12-19`) or rebuild the index.
- **Portability (Fable r1 m5):** verified only on the Node floor [V]. The expo-sqlite peer
  range starts at major 14 (SDK 51), not SDK 58 — any probe/gate must cover the whole range.
  Exact bundled SQLite versions per expo-sqlite major are **not pinned by this investigation**
  (web research did not surface them); additionally FTS on expo-sqlite native builds requires
  the host's `enableFTS` config-plugin opt-in, and web builds need a custom wa-sqlite bundle —
  the no-FTS degrade path must therefore remain first-class. The chosen compact-time mechanism
  does **not** depend on any of this (core pragma + `'optimize'`/`'rebuild'` work wherever FTS5
  itself works; a store without FTS has nothing to optimize).

## 6. Where the fixes land (file:line anchors, this tree)

- **Compact-time erasure mechanism (the guaranteed path, scenarios F/G):**
  - `PRAGMA secure_delete=ON` in `setup()` on the host-provided handle (Opus r1 M3: the engine
    never opens the connection — `createWiki(db, …)` receives a host-opened handle, guide line
    61; `secure_delete` is per-connection), **read the pragma back and surface it**; document
    that host connections writing wiki tables directly must set it themselves (guide §"If your
    app writes to the wiki tables itself", lines 157-166).
  - `compact()` composition, in order (Fable r2 m1): **per-entity prune** with
    `retainSoftDeletedFor: 0` **inheriting runPrune's safety holds** → FTS `'optimize'` or
    `'rebuild'` → `VACUUM` → `wal_checkpoint(TRUNCATE)` **after** the VACUUM (Fable r1 m2:
    `MetadataRepository.vacuum()` checkpoints before, never after). Per-entity prune vs
    store-wide file ops (Fable r1 m3): `runPrune` is per-entity and per-entity-locked
    (`MaintenanceService.ts:249-250`); checkpoint and VACUUM are store-wide.
- **Optional immediate-erasure enhancement:** FTS5 `'secure-delete'` option behind the §5
  version gate — new migration **v18** in `db/migrations.ts` (latest is v17 at `:388`), plus
  init-time set for fresh stores (FTS tables are created lazily by `Fts5IndexStrategy.init`,
  never by `setupDatabase`), and the same for later-created/rebuilt tables (retired-table
  lifecycle, `delistRetired`, passage tables). Refuses (surfaces a warning) outside the gate.
- **Chain forget:** reuse the existing primitive — `EntryRepository.findSupersessionChainIds`
  (`EntryRepository.ts:1085-1116`), recursive CTEs, both directions, capped at
  `HISTORY_MAX_DEPTH = 100` (`TemporalService.ts:9`; used as the product's lineage definition at
  `TemporalService.ts:40`, `:110`). Fable r1 M2: the fan-in behavior the doc worried about is
  already the product's lineage semantics; the new option wires it into `forget()` and surfaces
  the depth cap in the `dryRun` preview.
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
- **Ingest through the public write path** so the event and outbox copies exist (§3.5).
- Scan the **db file, `-wal`, `-journal`, and `-shm`** at every checkpoint of the test.
- `compact()` is the step that runs the erasure mechanism (pragma + optimize/rebuild +
  `wal_checkpoint(TRUNCATE)` after VACUUM); **erasure is guaranteed at `compact()` time, not at
  `forget()` time** (soft-delete window + WAL residue between them).
- F and G are the mechanism proofs [V, option asserted off]; the test reproduces them through
  the engine's public API in a tempdir, on a **multi-segment index** (bulk inserts crossing
  automerge thresholds), not a single-segment fresh index.

## 8. Open questions for the spec (owner input only where product-shaped)

1. **Chain semantics (resolved shape, Fable r1 M2):** reuse `findSupersessionChainIds` (both
   directions, depth cap 100) as the option's walk; `dryRun` preview lists every id the walk
   touches and surfaces the depth cap (a truncated walk must say so). **Fable r2 m3:** the walk
   has **no `deleted_at` filter** (`EntryRepository.ts:1093-1113` walks regardless of
   soft-delete state), while `TemporalService.history()` (`:109`) returns empty for a deleted
   start fact — for chain forget, sweeping soft-deleted ancestors is arguably the desired
   erasure semantics, but the `dryRun` preview must show the walk's actual membership so the
   spec's promise matches it. Open: does the option hard-delete the chain members immediately
   (documented erasure semantics) or soft-delete them into the existing prune flow?
   Recommendation: soft-delete + document that erasure completes at `compact()` (§7).
2. **Can hosts disable `secure_delete`?** Recommendation: always on in `setup()` on the engine's
   handle, no opt-out in v1; hosts' *other* connections must set it themselves (documented).
   Revisit only on a real perf complaint. (Scenario H shows why: without the pragma, even
   `'rebuild'` leaves text in freed pages.)
3. **Immediate-erasure enhancement (re-answered, Fable r1 B1):** ship v18 as OPTIONAL: set the
   FTS5 option only when the runtime passes the version gate (capability ≥3.42 **and** outside
   the known-buggy range, re-checked against the release history at implementation time);
   otherwise skip with a surfaced warning. The compact-time mechanism carries the guarantee on
   every supported runtime; the option only buys erasure-at-delete-time where safe. Format-5
   read errors on old builds fall back to the no-FTS path or rebuild (§5).
4. **`compact()` scope and the undo window (Opus r1 M4 + Fable r1 m3):** `compact()` composes a
   per-entity prune (per-entity lock) with store-wide file operations; it must inherit
   runPrune's holds — no hard-delete of facts whose external-index removal is unconfirmed
   (guide 55-56), keep librarian-unread events unless `includeEvents`-shaped opt-in (guide
   213-216) — and **report what it held back**. **Owner question:** store-wide API with 0-day
   retention (recommended shape), or entity-scoped, and whether the undo-window wipe needs its
   own confirmation knob.

## 9. Not checked by this investigation

- Bundled SQLite version per expo-sqlite major 14/15/55-58 (§5) — web research did not pin
  them; not load-bearing for the chosen mechanism (no version dependency), load-bearing only
  for the optional enhancement's gate, which probes at runtime regardless.
- Performance cost of `'optimize'`/`'rebuild'` on large indexes and of `PRAGMA
  secure_delete=ON` on the hot write path (accepted per issue; consumer gated on host fix
  only; measure at implementation).
- Exact release that will carry the merge-bug fix (§5) — trunk commit exists; re-check the
  release history at implementation time before pinning the version gate's upper bound.
- The census rows marked "spec decides" (§3.5) are inventoried, not decided — the spec owns
  the per-copy scoping.
- B′'s clean result holds for the measured layout (deleted row in its insert's segment); the
  delete-marker-surviving layout is covered by the guarantee path (pragma + merge), not
  measured in isolation (§1).
