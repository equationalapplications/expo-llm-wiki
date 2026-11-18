# Investigation — #401: forget must erase (FTS5 secure-delete, chain forget, compact())

**Date:** 2026-11-16 · **Status:** Rev 12 — CONVERGED; T4 corrections folded (source_ref_index census row corrected — runPrune never touches the table; retire-tables row added)
**Issue:** equationalapplications/expo-llm-wiki#401 · **Repo baseline:** `27f8e5e9` (main after #400, v9.2.0)
**Evidence tags:** [V] = controller-verified against this tree / live driver; [C] = child- or web-reported, not independently reproduced.
**Repro:** `specs/forget-erasure/canary-repro.cjs` — committed, runnable from the repo root; §2 table is its output verbatim. Harness (Fable r2 B1/M1/M2 + Fable r3 BLOCKER rework): every scenario runs in a **fresh database file**; "option off" scenarios **assert `ft_config` holds no `secure-delete` row** before the delete; the canary is a **single lowercase alphanumeric token** (`zxq7f3a9k`) — byte-identical under the unicode61 **and** porter unicode61 tokenizers — with two per-scenario harness assertions that it is a real, stable term (fts5vocab holds the exact token; pre-delete MATCH returns exactly the TARGET row); every scenario **byte-scans the db file, the `-wal` sidecar, and every `%_data` block separately**, so row-content erasure (`db`) and term-bytes erasure (`postings`) are distinct columns; the `deleted-term` MATCH probe is reported but is **not** byte evidence (FTS5 hides deleted rowids by design); `segpages` counts non-structure `%_data` rows (structure record = id 1, config = id 10; >1 = a non-trivial multi-page index); porter scenarios F2/G2/H2 reproduce F/G/H on the **engine's own tokenizer** (`porter unicode61`); the SQLite version line is `SELECT sqlite_version()` output, not a hard-coded string.

## 1. Summary

The issue's central claim is **correct and reproduced**: after `forget()` plus the documented
hard-delete steps, the deleted fact's text remains recoverable from the database file (scenario
B: canary present after a plain delete + checkpoint, on a multi-segment index). Erasure
requires addressing **four primary retention surfaces in the store file** (§3) **plus the
derived and upstream copies of fact text elsewhere in the store** (§3.5).

**Mechanism finding (Fable r1 B1 → re-measured unconfounded after Fable r2 B1 → re-measured at the
postings level after Fable r3's BLOCKER):** the FTS5 `'secure-delete'` option the issue proposes
is **unusable as the required mechanism on every runtime this investigation could verify** — the
upstream merge bug (§5) is unfixed in every released SQLite we could confirm. The guaranteed
erasure mechanism is
**compact-time**: core `PRAGMA secure_delete=ON` + plain deletes + FTS `'optimize'` or
`'rebuild'` at `compact()` + a truncating checkpoint — measured clean in scenarios
F/G/F2/G2/K/K2
**with the option genuinely off** (`ft_config` asserted), on multi-page indexes (`segpages`
11→7), on **both** the harness tokenizer (unicode61) and the engine's own (`porter unicode61`),
green integrity, and with erasure proven on **both surfaces**: the row-content copy (`db` scan)
AND the term-bytes copy in `%_data` segment pages (`postings` scan). K/K2 measure the spec's
full composed sequence (delete + merge + VACUUM + post-VACUUM checkpoint) as ONE unit — also
clean on both surfaces. **Schema scope (haiku verify):** these scenarios run on a synthetic
single-column FTS table — they prove the *mechanism*, not the engine's schema; the engine-schema
proof is the §7 acceptance test through the public API. Scenario H isolates the pragma:
`'rebuild'` **without** the pragma clears the postings surface but leaves the canary in freed
pages (`db` present). The option remains valuable as an **optional immediate-erasure enhancement**
behind a version gate.

**On VACUUM (Fable r1 M4 → now directly measured, Fable r3):** VACUUM does **not** erase the
deleted fact. Scenario B′ (plain delete + VACUUM, no pragma, no option) leaves the canary on
**both** surfaces: freed row-content pages AND live `%_data` pages carrying the deleted row's
term bytes, which VACUUM copies as-is when it rewrites the file. (The rev-4 B′ "clean" result was
an artifact of the old harness's content-only scan — its canary string could not appear in
tokenized `%_data` bytes at all.) VACUUM shrinks the file; only pragma + a segment merge
(`'optimize'`/`'rebuild'`) scrubs term bytes.

## 2. Repro table (live driver: better-sqlite3 13.0.3, bundled SQLite 3.53.4, WAL mode) [V]

Output of `node specs/forget-erasure/canary-repro.cjs` (`db` = byte-scan of the db file;
`postings` = byte-scan of every `%_data` block; `wal` = byte-scan of `-wal`; `integ` = FTS5
`'integrity-check'`; `segpages` = non-structure `%_data` row count; `deleted-term` = MATCH on the
deleted row's unique probe term — hiding only, not byte evidence; `live-rows` = MATCH on live
rows; u61 = unicode61, porter = `porter unicode61`):

| # | Scenario (fresh db each) | db | postings | wal | integ | segpages | deleted-term | live-rows |
|---|---|---|---|---|---|---|---|---|
| A | insert + `wal_checkpoint(TRUNCATE)` (baseline, u61) | **present** | **present** | clean | ok | 11 | `["TARGET"]` | 300 |
| B | plain `DELETE` + checkpoint (pragma off, option off) | **present** | **present** | clean | ok | 12 | `[]` | 300 |
| B′ | plain `DELETE` + `VACUUM` (pragma off, option off) | **present** | **present** | clean | ok | 12 | `[]` | 300 |
| C1 | FTS5 `'secure-delete'` option only: delete + checkpoint | **present** | clean | clean | ok | 11 | `[]` | 300 |
| C2 | scenario C1 continued with `VACUUM` | clean | clean | clean | ok | 11 | `[]` | 300 |
| D | `PRAGMA secure_delete=ON` + option: delete + checkpoint | clean | clean | clean | ok | 11 | `[]` | 300 |
| E | D's config: delete + `VACUUM` (fresh db) | clean | clean | clean | ok | 11 | `[]` | 300 |
| F | pragma ON, **option off**: delete + `'optimize'` + ckpt (u61) | clean | clean | clean | ok | 7 | `[]` | 300 |
| G | pragma ON, **option off**: delete + `'rebuild'` + ckpt (u61) | clean | clean | clean | ok | 7 | `[]` | 300 |
| H | pragma **off**, option off: delete + `'rebuild'` + ckpt (u61) | **present** | clean | clean | ok | 7 | `[]` | 300 |
| F2 | pragma ON, **option off**: delete + `'optimize'` + ckpt (porter) | clean | clean | clean | ok | 7 | `[]` | 300 |
| G2 | pragma ON, **option off**: delete + `'rebuild'` + ckpt (porter) | clean | clean | clean | ok | 7 | `[]` | 300 |
| H2 | pragma **off**, option off: delete + `'rebuild'` + ckpt (porter) | **present** | clean | clean | ok | 7 | `[]` | 300 |
| K | pragma ON, option off: delete + `'optimize'` + `VACUUM` + ckpt (u61) — **the full compact() composition** | clean | clean | clean | ok | 7 | `[]` | 300 |
| K2 | pragma ON, option off: delete + `'rebuild'` + `VACUUM` + ckpt (u61) | clean | clean | clean | ok | 7 | `[]` | 300 |

Notes [V]:
- **B is the bug, on both surfaces**: the deleted rowid is hidden from MATCH (`deleted-term: []`)
  — that is FTS5 hiding a deleted rowid by design, **not** byte evidence — while the canary
  bytes stay in freed row-content pages **and** in `%_data` segment pages.
- **B′ is NOT clean (measured, Fable r3)**: VACUUM drops freed content pages but copies live
  `%_data` pages as-is; the deleted row's term bytes survive (§1). The rev-4 "clean" B′ was an
  artifact of the old content-only scan.
- **C1/C2 pin the option's own scope**: the option alone scrubs the postings surface (C1
  `postings: clean`) but leaves row content in freed pages (`db` present) — it needs the pragma
  (D) or a VACUUM (C2) for full-file erasure. Both mechanisms need the pragma for full erasure.
- **F/G/F2/G2 (and K/K2) are the compact-time mechanism proof**, with the option asserted off
  via `ft_config`, on both tokenizers, erasure proven on both surfaces; K/K2 measure the spec's
  full composition as one unit. **All scenarios use a synthetic single-column FTS table — they
  prove the mechanism, not the engine schema** (the engine-schema proof is §7's acceptance test
  through the public API).
- **H/H2 isolate the pragma**: `'rebuild'` alone clears the postings surface (new segments carry
  no deleted-term bytes) but leaves the canary in freed pages (`db` present) —
  `PRAGMA secure_delete=ON` is the load-bearing piece for full-file erasure.
- In every run the WAL held no canary because each step ended in a `TRUNCATE` checkpoint;
  hosts without a truncating checkpoint keep old frames in `-wal` (§7 pins this).

## 3. Primary retention surfaces — the store file (all [V] against this tree)

1. **FTS5 postings survive deletes by design — measured directly (Fable r3).** `entries_fts` and
   `source_passages_fts` are ordinary-content FTS5 virtual tables
   (`packages/core/src/services/search/fts5Sql.ts:51-54`, `:215-218`). Without the FTS5
   `'secure-delete'` option, deletes leave the deleted row's term bytes in `%_data` segments —
   measured `postings: CANARY PRESENT` in scenarios B and B′ (surviving even VACUUM) — until
   merges reclaim them; nothing in `packages/core/src` sets
   `automerge`/`crisismerge`, so FTS5 defaults apply on the live tables; the only explicit
   `'merge'` targets retired tables (`services/search/Fts5IndexStrategy.ts:446`).
2. **Deleted row content is not zeroed.** The engine never sets `PRAGMA secure_delete` — zero
   hits in `packages/core/src` and the deleting-data guide [V]. Hard deletes (`runPrune`,
   `clearAll` — the `source_ref_index` hard delete via `sourceRefIndexRepo.deleteByEntityId`
   behind the `sourceRefIndexPresent` guard (`services/MaintenanceService.ts:642-644` — the
   pragma reasoning applies to whatever SQL that repo method issues, not to the call site
   itself) and the source-store hard deletes at `:646-649`; the by-source `source_ref_index`
   delete at `:715-716` is a **soft** delete, `softDeleteByEntityAndSourceRef`) leave content
   bytes in freed b-tree pages (scenarios B, H).
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
| `source_documents.text` | `db/schema.ts:74` (70-72 are id/entity_id/source_ref) | **fact/source text** | rows written **only** by `storeSource` (`SourceStoreService.ts:43-73`, `WikiMemory.ts:1110-1118`) and import (`ImportExportService.ts:180`) — never by `remember`/`ingestDocument` (T3 B1/M1); hard-deleted under `sourceRef`/`sourceHash` selectors (`MaintenanceService.ts:687-701`) **and by `clearAll` for the entity** (`:646-649`, `DELETE FROM source_documents` at `:648`); **`forget({entryId})` leaves it on disk** | spec decides (Fable r3 + T3 B1 + T3 delta B1): GC candidates come from a **durable `source_gc_pending` ledger** fed by every hard-deleting prune, drained by compact with a same-transaction liveness re-check — never by absence; per-document erasure via `sourceRef`/`sourceHash`; **owner question E** on whether last-fact GC should touch host-stored text at all |
| `source_passages` | `db/schema.ts:80-87` — **offsets only, no text stored** ("Passage text is not stored: offsets … slice source_documents.text", comment at `:68`) | no text; identifies source spans | hard-deleted with the source-store block (`:647`) | covered by the source_documents decision |
| `source_passages_fts` | virtual table | **indexed source text** | rebuilt from the store | covered by the same decision + §3.1 |
| entity summary | `meta.value` under `entitySummaryMetaKey` (`MaintenanceService.ts:664`) | summarized fact content | deleted only on `clearAll` | same decision shape as events |
| entity ontology manifest | `entity_manifests.manifest_json` (`db/schema.ts:144-149`; guide 221-224 — "node and edge types learned from the entity's facts") | fact-**derived** type names, not fact text | wipe leaves it (guide) | document as left (Fable r1 M1) |
| `source_ref` / `source_pointer` index | `source_ref_index` | **no fact text, but identifying data** (source_ref strings) | **only `clearAll` hard-deletes registry rows** (`MaintenanceService.ts:643`); the by-source path soft-deletes (`softDeleteByEntityAndSourceRef`, `:715-716` tombstones); **`runPrune` never touches the table** (T4 m2 — the rev-11 claim "erasure completes at compact() prune" was wrong); `forget({entryId})` leaves it untouched | spec decides (T4 m2): compact's GC drain (E=yes path) also deletes the registry row for a drained key when no live entry matches, and sweeps tombstones; document otherwise |
| graph edges | `db/schema.ts:112` (`edge_type` at `:117`) | no fact text; but `edge_type` may hold **fact-derived type names** under an emergent ontology — same category as the manifest row (Fable r3) | deleted on `clearAll` | document as left, same decision shape as the manifest row |
| graph nodes | stored as entries (facts) | — | covered by entry deletion | no separate surface |
| FTS `%_content` / `%_data` shadow tables (`entries_fts_*`, `source_passages_fts_*`) | FTS5 shadow tables | **full copies**: `%_content` stores the indexed title/body/tags text verbatim; `%_data` stores terms + postings (Fable r3) | scrubbed only by the §6 mechanism (or the option); measured in §2 | primary surface; covered by the compact-time mechanism |
| retired FTS tables (`entries_fts_retired_N` + shadow) | rename-retired on corruption reset (`Fts5IndexStrategy.ts:318-335`); reclamation is deadline-bounded best-effort (`:410-452`) | **verbatim fact text** in `%_content` at retirement time, forgotten facts included (T3 M4) | VACUUM copies their shadow tables intact; compact must reclaim to completion before VACUUM | primary surface addition (T3 M4); covered by the §6 reclaim step |
| `vector_removals` ledger | `db/schema.ts:177-185` | no — ids/timestamps only [V] | retained by design (durable-vector-removal spec) | no text to erase |
| VACUUM temporary database file | SQLite temp file during `VACUUM` | can carry pre-VACUUM page images during the rewrite (Fable r3) | deleted at VACUUM commit; residue possible on crash/rollback-journal hosts | document as a crash-window residue; no engine change |
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
- **The FTS5 option alone does not erase row content** (C1, measured): it scrubs the postings
  surface but leaves row content in freed pages — both the option and the core pragma are
  required for full-file erasure [V]. Note also that D/E (option-based) are **not usable in
  production today**: with the §5 merge bug unfixed in every released SQLite, the option cannot
  carry the guarantee on any supported runtime.
- **VACUUM (Fable r1 M4 → measured, Fable r3):** drops freed content pages but copies live
  `%_data` pages as-is, so term bytes under delete markers survive it (B′ measured NOT clean);
  it shrinks the file and is part of the compact-time recipe, not the erasure mechanism itself.
- **The option cannot be the required mechanism (Fable r1 B1):** the version gate over the
  known-buggy range (§5) passes **zero runtimes this investigation could verify** —
  better-sqlite3 13.0.3 (bundles 3.53.4) is a **devDependency pin used by the test harness**
  (`packages/core/package.json:69`, devDependencies block; it is not a runtime floor — the
  engine receives a host-opened handle, so Node hosts run whatever SQLite their app bundles),
  and the expo-sqlite peer range `^14.0.0 || ^15.0.0 || ^55…^58` (`packages/expo/package.json:70`)
  bundles **unverified** per-major SQLite versions [C-web — §9] and none is confirmed outside
  the buggy range. The guaranteed mechanism is compact-time (F/G/K, option asserted off); the
  option is an optional immediate-erasure enhancement behind the gate (§8 Q3).

## 5. Known upstream risks (secure-delete path)

- **Merge bug, directly in the engine's blast radius [C-web, pinned with full URLs]:**
  with secure-delete on, a merge can leave stale postings that resurrect a deleted rowid
  (trigger: delete with the option off, reinsert, merge, delete again with the option on).
  Report (2026-10-22): https://sqlite.org/bugs/info/8cf71b8e652dce27d7037945a381f523971b47eb8a2d0a0e9676066c074daf48 —
  **wrong in 3.46.0, 3.50.2, 3.51.0, 3.53.2 and trunk at report time**; fixed on trunk
  2026-10-26: https://sqlite.org/src/info/0b486e53a4 — **no fixed release could be confirmed
  at investigation time** (3.53.4, the harness pin, sits in the range and is not listed as
  fixed; treat as unfixed). The trigger layout arises from **FTS5's default automerge on the live
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
    app writes to the wiki tables itself", lines 157-166). **Connection-wide scope (Fable r3):**
    the pragma changes delete behavior for **every table on the connection, including the
    host's own tables** (their hard deletes also zero freed pages — a write-cost/behavior change
    outside the engine's prefix), **and it applies to every database ATTACHed on that
    connection** — probed live [V]: an unqualified `PRAGMA secure_delete=ON` set the pragma on
    the attached `aux` db too, and a per-database override (`PRAGMA aux.secure_delete=OFF`)
    changed only `aux` while `main` stayed `ON` — so a host attaching its own file inherits the
    setting unless it overrides per-db (Fable r4 raised, controller-verified). This
    sits in tension with INTENT.md:137-138 ("writes only to tables under a prefix you choose
    and never touches other tables"), so the no-opt-out recommendation (§8 Q2) is an owner
    decision, not a settled call; `secure_delete=FAST` is the cheaper middle option (zeroes
    deleted content with a smaller write pattern) and belongs in the same decision.
  - `compact()` composition, in order (Fable r2 m1; **`compact()` is a new public API — no
    method of that name exists in this tree**): **per-entity prune** with
    `retainSoftDeletedFor: 0` **inheriting runPrune's safety holds** → FTS `'optimize'` or
    `'rebuild'` → `VACUUM` → `wal_checkpoint(TRUNCATE)` **after** the VACUUM (Fable r1 m2:
    `MetadataRepository.vacuum()` — checkpoint `:173`, `VACUUM` `:174` — checkpoints before,
    never after). Per-entity prune vs
    store-wide file ops (Fable r1 m3): `runPrune` is per-entity and per-entity-locked
    (`MaintenanceService.ts:249-250`: signature at `:249`, the per-entity lock acquisition
    `acquireLock('prune', entityId)` at `:250`); checkpoint and VACUUM are store-wide.
  - **Source-store GC:** every prune that hard-deletes facts (standalone `runPrune`, the
    automatic 7-day sweep, and compact's step 1) records the deleted rows'
    `(entity_id, source_ref, source_hash)` keys in a **durable `source_gc_pending` ledger**
    (T3 delta B1: a per-run list is empty when the deletes happened in an earlier prune —
    which is the documented recipe). `compact()` drains the ledger: for each pending key, in
    the same transaction as the deletes, re-check no live entry carries the key (concurrent
    `remember` can revive a key — T3 delta m2) and hard-delete that key's `source_documents`
    row, its `source_passages`, and their FTS rows; keys still live are dropped un-deleted.
    Never collect by absence — `source_documents` is written only by `storeSource` and import,
    so a fact-less stored document is a supported host state and must survive compact (T3
    B1). Documents forgotten via `sourceRef`/`sourceHash` selectors are already hard-deleted
    at forget time, `MaintenanceService.ts:696-701`. **Owner question E** (spec) on
    whether last-fact GC should touch host-stored text at all.
- **Optional immediate-erasure enhancement:** FTS5 `'secure-delete'` option behind the §5
  version gate — **no numbered migration** (T3 M5: `setup()` stamps `schema_version`
  unconditionally, `WikiMemory.ts:450-455`, so a v18 one-shot would permanently mark upgraded
  stores as done while the gate passes no runtime today); instead the gate is evaluated **on
  every open** in `Fts5IndexStrategy.init` / `ensurePassageObjects` / `rearmInTx` via an
  idempotent `ft_config` write. The gate is **closed today** and is
  `sqlite_version() >= <first release containing fix 0b486e53a4>` — never a range (T3 M6:
  range wording admits 3.42.0-3.45.x and 3.53.3/3.53.4). Refuses (surfaces a warning) outside
  the gate.
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

Whole-file absence: after the documented full-wipe path — `clearAll({ includeEvents: true })`
plus the documented host steps (outbox drain) — plus `compact()`, the canary is absent from the
database file **and** the journal files. Fact-path absence (single-fact forget) is scoped to
the fact's own copies — the two tiers are pinned because the copies have different documented
owners (haiku verify2 MAJOR 2; §8 Q5). Pinned shape:
- **Two tiers.** (1) *Fact-path tier*: fixture pinned (T3 B1/M1 — `source_documents` is
  written only by `storeSource` and import; `remember`/`ingestDocument` create no source rows
  **and no events**): **`storeSource({ sourceRef: R, sourceHash, text containing the canary
  })`**, then create **exactly one** canary fact carrying the same `sourceRef`
  (`remember`/`ingestDocument` with a stub provider), and **assert the `source_documents` row
  exists before** the forget (not vacuous). Then single-fact
  `forget({ entryId })` + `runPrune({ retainSoftDeletedFor: 0 })` + `compact()`: canary absent
  from the entry row, all FTS surfaces (db file + `%_data` blocks + WAL/journal) and — via the
  source-store GC — from `source_documents`/`source_passages`. **Second case:** a document
  backing **two** facts: after forgetting one, its `source_documents` row and passages must
  **survive** (GC must not fire while a live fact references it). `events.summary` and the
  entity summary are
  **documented carve-outs** at this tier (they still hold the text until the full-wipe steps —
  §8 Q5). (2) *Full-wipe tier*: **seed every derived copy explicitly and assert each exists
  before the wipe** — an event with a canary `summary` (via `write()`; events arise only from
  `write`/import, never ingestion), an unsent outbox row, an entity summary containing the
  canary. Then `clearAll({ includeEvents: true })` + outbox drain +
  `compact()`, **run hookless** (no vector-removal hook, or a removal-confirmed stub — an
  unconfirmed/failing hook legitimately holds rows back via runPrune's holds): canary absent
  from the whole file (db + `-wal`/`-journal`/`-shm`). Whole-file
  absence claims are made only at the full-wipe tier.
- **The canary is a single lowercase alphanumeric token** (byte-identical under the engine's
  `porter unicode61` tokenizer), verified in-tree via fts5vocab and a pre-delete MATCH, with
  **separate `%_data` block assertions** (Fable r3: a mixed-case/hyphenated canary can only ever
  be found in the `%_content` copy, so a plain byte-scan proves nothing about the postings
  surface).
- **Ingest through the public write path** so the event and outbox copies exist (§3.5).
- Scan the **db file, `-wal`, `-journal`, and `-shm`** at every checkpoint of the test.
- `compact()` is the step that runs the erasure mechanism (pragma + optimize/rebuild +
  `wal_checkpoint(TRUNCATE)` after VACUUM); **erasure is guaranteed at `compact()` time, not at
  `forget()` time** (soft-delete window + WAL residue between them).
- F/G/F2/G2 are the mechanism proofs [V, option asserted off, both surfaces, both tokenizers];
  the test reproduces them through the engine's public API in a tempdir, on a **multi-segment
  index** (bulk inserts crossing automerge thresholds), not a single-segment fresh index.

## 8. Open questions for the spec (owner input only where product-shaped)

1. **Chain semantics (resolved shape, Fable r1 M2):** reuse `findSupersessionChainIds` (both
   directions, depth cap 100) as the option's walk; `dryRun` preview lists every id the walk
   touches and surfaces the depth cap (a truncated walk must say so). **Fable r2 m3:** the walk
   has **no `deleted_at` filter** (walk body `EntryRepository.ts:1093-1113` inside the method
   `:1085-1116`, walks regardless of
   soft-delete state), while `TemporalService.history()` (`:109`) returns empty for a deleted
   start fact — for chain forget, sweeping soft-deleted ancestors is arguably the desired
   erasure semantics, but the `dryRun` preview must show the walk's actual membership so the
   spec's promise matches it. Open: does the option hard-delete the chain members immediately
   (documented erasure semantics) or soft-delete them into the existing prune flow?
   Recommendation: soft-delete + document that erasure completes at `compact()` (§7).
2. **Can hosts disable `secure_delete`?** (amended Fable r3: the pragma is **connection-wide**
   and alters delete behavior/cost on the host's own tables — an INTENT.md:137-138 tension).
   Options: (a) always on, no opt-out in v1, pragma read-back surfaced (prior recommendation);
   (b) always on + an opt-out engine option for hosts who accept the residue; (c) `secure_delete=FAST`
   as the default with `FULL` available. Hosts' *other* connections must set it themselves
   (documented) in every option. **Owner question B — now carries this scope dimension.**
   (Scenario H shows why something is needed: without the pragma, even `'rebuild'` leaves text
   in freed pages.)
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
5. **Events and the entity summary — engine-erased or host-step carve-out?** (haiku verify2
   MAJOR 2.) `events.summary` holds fact text; only `clearAll({ includeEvents: true })`
   hard-deletes events, and the entity summary survives until `clearAll` (§3.5). A single-fact
   forget therefore cannot promise whole-file erasure — §7 pins a two-tier test around this.
   Options: (a) documented carve-out — the guide states the full-wipe steps (current shape,
   recommendation); (b) engine-side scoped event deletion on `forget`; (c) engine-side entity
   summary rewrite. **Owner question D — product-shaped.**

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
