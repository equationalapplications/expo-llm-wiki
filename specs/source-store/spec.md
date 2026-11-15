# The source store

**Status:** Draft.
**Date:** 2026-11-14 (Step-0 code reads done 2026-11-14 at `main` `92878cc3`, `packages/core` 9.1.0, schema v16).
**Issue:** [#390](https://github.com/equationalapplications/expo-llm-wiki/issues/390). Roadmap step 4 (`docs/ROADMAP.md`).
**Owner rulings this spec answers:** 2026-11-14 — scope is the store only; `ingestDocument()` does not change; a host that does not use the store sees no change on upgrade. Working memory, extraction that reads from the store, and librarian-replaceable document facts are named exploratory and stay out.
**Intent check:** Rule 1 — the store makes no model call; §No model call. Rule 2 — every schema change is additive; two new tables, no new column on any existing table; §Schema: two new tables, additive. Rule 3 — every new table and read path is row-scoped by `entity_id`; §Entity isolation. Rule 5 — the implementation pull request rewords rule 5; §1. Rule 6 — refusals and cuts produce typed, content-free diagnostics; §Limits and diagnostics. Rule 7 — the store spends no tokens; §No model call. Rule 8 — no dependency is added; §Files touched. Rule 10 — this spec exists before any code. Rule 11 — measurement is cheap targeted tests; §Test plan publishes no accuracy or cost claim.

## Problem

Three hosts hand documents to the engine. The engine turns each document into
facts with `ingestDocument()`, which makes one model call per chunk. The
engine then keeps only the facts. It throws the document text away. A host
that wants its document findable must pay for that extraction. A host that
keeps no copy of the text — Curated Journal is the driving case
(curated-journal#112) — cannot list its sources or read one back at all.

The owner ruled the fix on 2026-11-14: the engine keeps a document's text as
it is, indexes it, and searches it with no model call. A read can return two
labelled groups: facts the librarian wrote, and passages from sources. The
scope is the store only.

## Root cause (with evidence)

The engine has no place that keeps source text. Two reads of the live tree at
`92878cc3` verified every line below.

1. **No text is kept.** `ingestDocument()` chunks the text and makes one model
   call per chunk (`services/IngestionService.ts:173,201`). The chunks are
   inputs only. `db/schema.ts` has no column that holds document text, and a
   grep of `packages/core/src` for `documentText|rawText|raw_text|passage|sourceText|source_text`
   returns nothing.
2. **A source registry already exists.** The `source_ref_index` table
   (`db/schema.ts:54`) with partial UNIQUE `(entity_id, source_hash) WHERE
   deleted_at IS NULL` is the load-bearing sourceRef invariant (v9,
   `db/migrations.ts:155`; class comment `WikiMemory.ts:734`). `hasChanged`
   (`WikiMemory.ts:554`), `pendingSources` (`:649`), `listSourceRefs`
   (`:723`), and `forget({ sourceRef })` (`:1067`) already name a source the
   way all three hosts do: `sourceRef` plus a SHA-256 `sourceHash`.
3. **The chunker is free and exported.** `chunkText` is a pure function
   (`utils/pure.ts:722`), exported at `src/index.ts:17`, with defaults
   12,000 and 400 (`utils/chunkingDefaults.ts:6,16`). It returns
   `{ chunks: string[]; truncated: boolean }` — strings only, no offsets, and
   it throws unless `overlap` is an integer in `[0, maxChunkLength)`
   (`utils/pure.ts:729-733`).
4. **The keyword index is tied to `entries`.** FTS5 lives in `entries_fts`
   (`services/search/fts5Sql.ts:49-66`). Its triggers enqueue into a
   `fts_pending` ledger; a budgeted background drain does the indexing — the
   triggers do not feed FTS5 rows directly. Where FTS5 is missing, MiniSearch
   holds the indexed text in the JavaScript heap with O(total text) memory
   (`services/search/MiniSearchIndexStrategy.ts:14-20`). The `'auto'`
   strategy probes by creating a temp fts5 table **and** running
   `SELECT json_valid('[]')` — it tests FTS5 and json1 together
   (`services/search/createIndexStrategy.ts:35-47`) — and never detaches on a
   transient failure (`:99-102`). Whether expo-sqlite ships FTS5 on a given
   device is not measured; the engine treats it as fallible by design.
5. **A read is one flat bundle.** `read()` returns one `MemoryBundle`
   (`types.ts:1056-1076`) with a single ranked `facts` array. It accepts up to
   100 entity ids and does not group results
   (`services/RetrievalService.ts:47-49,763-777`). Events are not indexed;
   they come back only as a recent-log tail.
6. **Names collapse by design.** `normalizeSourceRef` deletes every character
   outside `[A-Za-z0-9._\- ]` and truncates at 255
   (`utils/pure.ts:907-911`). So `a/b.md` and `ab.md` are one source, and
   `café.md` becomes `caf.md`. This is managed, not latent: a stamped,
   watermark-resumable normalize pass (`db/sourceRefNormalize.ts`) reconciles
   stored refs, and the v9 migration aborts loudly on a live duplicate-hash
   conflict (`db/migrations.ts:178-196`).
7. **Removal is staged, not immediate.** `forget({ sourceRef })` soft-deletes
   entries and the `source_ref_index` row in one transaction
   (`services/MaintenanceService.ts:621,688,706-712`); prune hard-deletes
   entries later, only after vector removal is confirmed, and
   `retainSoftDeletedFor: null` stops that sweep entirely
   (`MaintenanceService.ts:299`). A wipe (`clearAll`) hard-deletes
   `source_ref_index` and leaves no tombstones (`:633-637`).
8. **Export and import have no kind registry.** `exportDump` reads a fixed,
   positionally enumerated set of record sets
   (`services/ImportExportService.ts:89`), and `importDump` imports per
   entity, stripping any field outside the typed bundle (`:65,136`). The OKF
   path allowlist admits only `index.md`, `log.md`, and `facts|tasks` files
   (`packages/okf/src/path-allowlist.ts:1-2`).
9. **Curated Thoughts pins columns.** Its schema guard checks the exact
   column set of nine engine tables at startup and fails on an extra column
   (`curated-thoughts` `src-tauri/src/db/schema_guard.rs:8,203`; test at
   `:238-252`). A new engine **table** passes the guard; a new **column** on
   a listed table fails it until that repo mirrors the column
   (curated-thoughts#353).

## The decisions (the ten questions the issue poses)

The issue names fourteen points to settle. This spec settles them in ten
decision sections; points 13 and 14 are answered inside §Entity isolation
and §Test plan. The owner gates each answer.

### 1. Rule 5 reworded

Rule 5 today says a fact extracted by `ingestDocument()` is stored as
`immutable_document`, and that the planned source store will keep a
document's text (`INTENT.md`, rule 5, Planned paragraph). This pull request
rewords rule 5 to say the store exists, and it must make that edit in the
same pull request that ships the store. Proposed wording:

> ### 5. Documents are immutable sources and facts
>
> A fact extracted by `ingestDocument()` is stored as `immutable_document`.
> The librarian and heal never rewrite it, and the ops librarian refuses to
> supersede it. It leaves only when you call `forget()` or re-ingest the
> same source.
>
> The engine may also keep a document's text in the source store. The store
> keeps the text as the host handed it. The engine never rewrites, summarizes
> or re-chunks stored text into a different shape. Stored text is not
> evidence on its own: evidence quotes live inside the fact records that
> point at the source. Stored text leaves when you call `forget()` on the
> source, when you store a changed copy under the same `sourceRef`, or when
> you wipe the entity. The engine may not edit a document; deleting one at
> your request is not editing.

The Planned paragraph is deleted. The Status line stays Built. This wording
must ride the implementation PR; nobody edits `INTENT.md` in a status-only
pull request.

### 2. No model call, no tokens

The store is keyword-only. The store makes no model call at write time, at
index time, or at read time. Passages are not embedded: no `embed` call
exists on any store path, and no embedding row is written for stored text.
`llm_usage` is untouched by the store. The test plan proves this with a spy
that fails the suite if any model hook fires on a store path. This is the
proof for rules 1 and 7.

### 3. Schema: two new tables, additive

Rule 2 and curated-thoughts#353 fix the shape: new tables only. No column is
added to any existing table, so the Curated Thoughts guard passes without a
mirror. The store adds two tables, following the v9 `add_source_ref_index`
pattern (`db/migrations.ts:153-240`): `CREATE TABLE IF NOT EXISTS`, a
partial UNIQUE index, a pre-check that aborts with an actionable error
before any write, and an idempotent backfill — here a no-op backfill, since
no source text exists on any database today.

- `source_documents` — one row per stored source:
  `id`, `entity_id`, `source_ref`, `source_hash`, `text`, `text_hash`,
  `char_count`, `created_at`, `deleted_at`. Two partial UNIQUE indexes, both
  `WHERE deleted_at IS NULL`: `(entity_id, source_ref)` gives the same
  TOCTOU guard the facts table uses, and `(entity_id, source_hash)` mirrors
  `source_ref_index`, so two refs cannot hold one hash — the same rule
  `ingestDocument()` enforces. `text` holds the document exactly as the
  host handed it. `text_hash` is the engine's own SHA-256 over the UTF-8
  encoding of that exact string; core has no hasher today (a grep finds
  none), so the cycle adds `packages/core/src/utils/sha256.ts`, a pure
  implementation with no dependency — the pattern `packages/okf/src/sha256.ts`
  already uses. The host-supplied `source_hash` stays an opaque, host-owned
  join key: a host may hash file bytes or another text form, and the join to
  facts still works, because both sides carry the host's value.
- `source_passages` — one row per indexable passage:
  `id`, `entity_id`, `document_id`, `seq`, `start_offset`, `end_offset`.
  Passage text is not stored: the engine slices it from `source_documents.text`
  at index and read time, so the text exists once and stays as handed.
  Every offset is a UTF-16 code-unit offset into the text as handed — JS
  `slice` semantics — and the engine never converts one through SQL
  `substr()`, which counts code points and would drift on astral
  characters. The store computes passage boundaries with its own
  offset-tracking pass: it walks the handed text and cuts contiguous
  passages of at most 12,000 UTF-16 units, preferring whitespace boundaries
  the way `safeSlice` does, never splitting a surrogate pair, without
  trimming and without overlap. `chunkText` itself trims its input
  (`utils/pure.ts:727`) and produces overlapping chunks, so it cannot
  supply offsets, and the store does not use it for this pass. A future
  extraction lane can cite `(ref, position)` against `getStoredSource().text`
  with no new cutter.

The migration appends to `MIGRATIONS[]` as v17. `CURRENT_SCHEMA_VERSION` is
derived from the array's last entry (`db/migrations.ts:401-414`), so no
constant is bumped. Old databases migrate by pure DDL; fresh installs stamp
v17 in one transaction. A pre-v9-style runtime guard lets every store call
fail with a typed error instead of crashing on a database that predates v17.

### 4. Naming, and what links the store to the facts

A stored source is named exactly the way a source is named today:
`(entityId, sourceRef, sourceHash)`. `normalizeSourceRef` applies at the
store's API boundary as it does everywhere else. If a host's two file names
normalize to one ref, they are one source; the existing normalize pass and
the partial UNIQUE index already own that rule, and the store inherits it
without new code.

The link to the facts `ingestDocument()` writes is that same pair. The store
changes no fact and no fact row: an `immutable_document` fact already
carries `source_ref` and `source_hash` columns, and the store
keys its rows on the same values, so a read can join the two labelled groups on
`(entityId, sourceRef, sourceHash)` with no new pointer, column or table on
the fact side. `listSourceRefs` reads from `entries`, so its one new
optional result field, `stored: { charCount: number } | null`, decorates
only sources that have facts; the full store listing, including a source
stored with no ingest, is `listStoredSources`. An additive optional field
on a result type is a rule-2 change; the Curated Thoughts guard does not
read result types.

### 5. Removal

`forget({ sourceRef })` and `forget({ sourceHash })` delete the store rows
of that source, hard, in the same transaction that soft-deletes the facts.
Rationale: stored text is not evidence — evidence quotes live inside fact
records and survive as today — so text needs no tombstone, no prune pass and
no vector-removal gate. A hard delete at `forget()` time is a real delete on
every host, including a host that runs prune with `retainSoftDeletedFor:
null` (`MaintenanceService.ts:299`). `clearAll` hard-deletes the store rows
too, like it already hard-deletes `source_ref_index`.

Boundary with issue #386, whose acceptance point 4 freezes
`forget({ sourceRef })` fact semantics: the freeze holds. The store adds a
deletion step for its own rows; it adds no selector, changes no fact
outcome, and does not touch `forget({ eventId })`, which stays #386's lane.
If #386 later lands, deleting the facts of an event does not cascade into
the store, because event facts and stored sources are linked only by
`sourceRef`, which this spec does not change.

Storing a changed copy — same `sourceRef`, new `sourceHash` — hard-deletes
the old text row and its passages, then writes the new text. This mirrors
re-ingest: the engine never keeps two versions of one `sourceRef`'s text.
Storing the same `sourceRef` and same `sourceHash` again is a no-op that
returns the existing state, only when the engine's `text_hash` matches what
is stored; if the text differs under the same declared pair, `storeSource`
refuses with `SOURCE_STORE_HASH_MISMATCH` and changes nothing. A second
`sourceRef` carrying a `source_hash` another live row already holds refuses
with `SOURCE_STORE_DUPLICATE_HASH`, mirroring `ingestDocument()`'s
duplicate-hash rule.

Hard delete extends to the indexes. The passage index is asynchronous: FTS5
keeps its own text copy and the drain lags the transaction. After a
`forget()` or `clearAll()` commit, the store runs the same targeted
post-commit sync `forget` already runs for entries, so `source_passages_fts`
rows and the MiniSearch heap drop the deleted passages. A read returns only
passages whose `source_passages` row is live, so text can never surface from
a stale index even if a drain fails.

### 6. The index

The store runs a second keyword index beside the facts index, on both
strategies, reusing the machinery that exists:

- FTS5: a `source_passages_fts` virtual table fed through the same
  enqueue-and-drain ledger pattern as `entries_fts`, so writes stay budgeted
  and crash-safe. The passage FTS objects — the virtual table, its map and
  ledger, and the triggers — are created by the strategy's init, the way the
  `entries_fts` objects are today, not by `setupDatabase`; they appear in
  Files touched for that reason.
- MiniSearch fallback: a second in-heap instance over the same passage
  slices. `maxTotalChars` bounds one entity's contribution. The instance
  holds every stored entity of the database, so the fallback heap grows with
  the number of stored entities; the MiniSearch overhead multiplier over raw
  text is unmeasured. This spec publishes no heap number (rule 11).
- Strategy selection follows the existing `'auto'` probe unchanged
  (`createIndexStrategy.ts:35-47`); the store adds no probe and no new
  strategy. The probe already tests FTS5 and json1 together, which the drain
  needs.

The spec does not assume expo-sqlite ships FTS5 on any device, because no
device measurement exists (issue #390, "Not checked"). The store works under
both strategies by construction, and the MiniSearch memory bound is the
limits table below, not a measurement claim.

### 7. The read shape

Three new calls on `WikiMemory`, all opt-in:

- `storeSource(entityId, { sourceRef, sourceHash, text })` — store or
  replace a source. `sourceHash` is the host's join key, exactly the value
  it hands `ingestDocument()`; the engine shape-checks it with
  `normalizeSourceHash`, computes `text_hash` itself, and enforces the
  no-op and refusal rules of §5. Text that cannot round-trip — a lone
  surrogate or an embedded NUL — refuses with
  `SOURCE_STORE_TEXT_NOT_STORABLE`. Returns the stored state or a refusal
  diagnostic.
- `listStoredSources(entityId)` — list what is stored:
  `sourceRef`, `sourceHash`, `charCount`, `passageCount`, `storedAt`.
- `getStoredSource(entityId, sourceRef)` — return one source's text as
  handed: `{ sourceRef, sourceHash, text, charCount, storedAt }` or `null`.
- Search rides `read()`: a new optional `read()` option,
  `sources: { query: string; maxPassages?: number; charBudget?: number }`.
  When the option is present, the returned `MemoryBundle` gains an additive,
  optional `sources` field: a labelled array of
  `{ entityId, sourceRef, sourceHash, seq, startOffset, endOffset, text }`,
  ranked, capped by `maxPassages` (default 8) and `charBudget` (default
  4,000 characters) per entity. Ranking and caps are per entity: a
  multi-entity read gets one group per entity, each capped separately, and
  the engine never ranks passages across entities. Every item carries
  `entityId`, so two entities storing the same `sourceRef` stay
  distinguishable in one bundle. When the option is absent, the bundle is byte-identical in
  shape to today: the second labelled group exists only for a host that asks
  for it. `formatContext` prints the group under a `Sources` heading after
  the facts, and only when the group is present.

Rule 2: an optional option plus an optional result field plus three new
methods is additive. A host on today's API sees no change on upgrade.

### 8. Export, import, OKF

`MemoryDump` carries stored sources per entity, under a field distinct from
the read-result `sources`, because `MemoryBundle` serves both shapes:
`entities[id].storedSources?: StoredSourceDump[]`, each entry carrying
`sourceRef`, `sourceHash`, `text`, `text_hash`, `charCount`, `storedAt`,
and its passages. Export writes the field only for entities in the export's
scope; an entity with nothing stored carries none. Import restores the rows
under that entity, re-derives passages from the text, and re-computes
`text_hash`; the import honors the §9 limits and refuses with the same
diagnostics when a dump would exceed them. A `sourceRef` already stored
under the entity is replaced by the dump's copy — the dump is the source of
truth for that ref; other stored sources survive under merge semantics, and
a `merge: false` import replaces the entity's whole store with the dump's.

Older engines: a dump with `storedSources` imported into a 8.x/9.x engine loses
the sources silently, because those importers strip fields outside their
typed bundle. This spec proposes that answer, consistent with the existing
treatment of unknown fields; it adds no version handshake. Rule 6 prefers a
diagnostic over a silent drop, and no diagnostic is possible in an engine
that predates the field, so this loss needs the owner's explicit
acceptance; the controller asks for it at the spec stop. A new
engine importing an old dump sees no `sources` field and stores nothing —
correct, because the old engine stored nothing.

OKF: the store does not touch OKF. `packages/okf/src/path-allowlist.ts` is
not widened; no OKF record kind is added; rule 8's dependency surface and
the OKF round-trip stay as they are. Sources ride the JSON `MemoryDump`
only. If a host later wants sources in OKF markdown, that is a new ruling.

### 9. Limits and diagnostics

Two limits, both configurable, both enforced at `storeSource()`:

- `sourceStore.maxCharsPerSource` — proposed default 200,000 characters
  (about 16 chunks at current defaults).
- `sourceStore.maxTotalChars` — proposed default 5,000,000 characters per
  entity across all stored sources. This bounds one entity's contribution
  to the MiniSearch heap; the fallback's total heap is the sum over stored
  entities (§6).

The defaults are owner-gated; they are refusal guards, not targets. A
refusal produces a typed, content-free diagnostic in the existing registry —
proposed codes `SOURCE_STORE_SOURCE_TOO_LARGE`,
`SOURCE_STORE_BUDGET_EXCEEDED`, `SOURCE_STORE_HASH_MISMATCH`,
`SOURCE_STORE_DUPLICATE_HASH`, and `SOURCE_STORE_TEXT_NOT_STORABLE` — and
stores nothing. The budget check runs inside the write transaction, under
the same per-entity lock `forget()` and `clearAll()` use, so two concurrent
stores cannot both pass the check and exceed the budget. A read that hits
`charBudget` marks the cut on the result. No text is ever dropped silently.

### 10. Entity isolation

Rule 3. Both new tables carry `entity_id`, every query on them filters by it
in the `WHERE` clause, and both partial UNIQUE indexes include it — the same
pattern the nine existing tables follow (`EntryRepository.ts` scopes all 104
of its `entity_id` references this way). Per-entity locking follows
`JobManager`'s `${prefix}:${entityId}:<op>` key convention for store writes.
A read for one entity can never return another entity's passage.

## Files touched

- `packages/core/src/db/schema.ts` — DDL for `source_documents` and
  `source_passages` (every-open DDL, per the v9 pattern).
- `packages/core/src/db/migrations.ts` — migration v17, appended.
- `packages/core/src/services/SourceStoreService.ts` — new service: store,
  list, get, search, remove.
- `packages/core/src/services/MaintenanceService.ts` — `forget` and
  `clearAll` delete store rows in the existing transaction.
- `packages/core/src/services/RetrievalService.ts` — the `sources` read
  option and the labelled group.
- `packages/core/src/services/search/fts5Sql.ts` and
  `MiniSearchIndexStrategy.ts` / `createIndexStrategy.ts` — the second
  index on both strategies.
- `packages/core/src/services/ImportExportService.ts` — the additive
  `storedSources` dump field.
- `packages/core/src/types.ts` — `MemoryBundle.sources?` (read result),
  `MemoryBundle.storedSources?` (dump), option and result types,
  `listSourceRefs` result field.
- `packages/core/src/WikiMemory.ts` — public methods and wiring.
- `packages/core/src/utils/sha256.ts` — new pure hasher, no dependency
  (mirrors `packages/okf/src/sha256.ts`).
- `packages/core/src/diagnostics` (registry) — the refusal codes named in
  §Limits and diagnostics.
- `INTENT.md` — rule 5 reworded, in the same pull request.
- Tests under `packages/core/src/__tests__/`.

No dependency is added. `package.json` is untouched by this cycle.

## Test plan

Rule 11: cheap targeted tests; no accuracy or cost claim is published.

1. **No-model proof.** A spy on the model hook fails if it fires during
   `storeSource`, `getStoredSource`, `listStoredSources`, or a `read()` with
   the `sources` option.
2. **Migration.** Copy the `migration9.test.ts` pattern: fresh install stamps
   v17; an old database migrates by DDL; the migration is idempotent; the
   abort-on-corrupt-precondition path fires before any write.
3. **Additivity.** A test asserts no column was added to any table in
   curated-thoughts' nine-table guard list, so the CT guard passes
   unchanged.
4. **Round-trip.** Store, list, get — text is byte-identical to what was
   handed, including non-ASCII text, an astral-character (non-BMP) fixture,
   and the 255-character ref boundary. Leading-whitespace and
   repeated-substring fixtures pin the offsets against the handed text, and
   an emoji fixture pins UTF-16 offsets across the FTS and MiniSearch paths.
   A wrong-shaped `sourceHash`, a lone surrogate, and an embedded NUL each
   refuse with their typed diagnostics and store nothing. A second ref with
   a duplicate hash refuses. A same-pair re-store with different text
   refuses with `SOURCE_STORE_HASH_MISMATCH`.
5. **Search on both strategies.** The `sources` group returns the right
   passages under FTS5 and under the MiniSearch fallback; budget and
   `maxPassages` caps hold; the cut is marked; a two-entity read returns
   per-entity groups, each capped separately.
6. **Link.** After `ingestDocument()` on a stored `sourceRef`, the read
   joins facts and passages under the same pair; after
   `forget({ sourceRef })`, both groups are gone and
   `listSourceRefs` reports the source as not stored.
7. **Removal.** `forget` hard-deletes store rows under
   `retainSoftDeletedFor: null`; the passage index drops the deleted text
   after the post-commit sync, and a read never surfaces a deleted passage
   even with a stalled drain; a changed copy replaces text; a same-pair
   same-text re-store is a no-op; `clearAll` hard-deletes. A concurrent
   store test pins the budget check inside the transaction.
8. **Export/import.** Round-trip with `storedSources`; an old dump imports
   with no `storedSources` field; refusal diagnostics fire at the limits;
   merge semantics and the `merge: false` full replace hold.
9. **Isolation.** Two entities store the same `sourceRef`; neither read sees
   the other's text.

## Rejected alternatives

- **Store passages with their text in `source_passages`.** Rejected: the
  text would exist twice, and a rewrite of the passage cutter could not
  re-derive it. Slicing from one immutable text row keeps the text as handed.
- **Embed passages.** Rejected: an `embed` call is a model call and spends
  tokens, which rules 1 and 7 forbid for this lane and the owner ruled out.
- **Add a `text` column to `entries`.** Rejected: curated-thoughts#353 fails
  startup on a new column until that repo mirrors it; a new table passes.
- **Soft-delete store rows and let prune hard-delete them.** Rejected: a
  host running prune with `retainSoftDeletedFor: null` never purges, so the
  delete would not be real. Text is not evidence; it needs no tombstone.
- **Widen the OKF path allowlist for sources.** Rejected: it widens a
  charter-guarded surface for no host need named in issue #390, and JSON
  `MemoryDump` already carries the round-trip.
- **Queue the `sources` group behind the cloud contract change.** Rejected
  for this cycle: agent-facing surfaces stay out per the issue's out-of-scope
  ruling; hosts reach the store through the engine API.

## Release

Additive, so semantic-release publishes a minor (next minor after 9.1.0). No
breaking change exists in this cycle; a breaking change would need its own
ruling. The rule 5 reword rides the same pull request, per the roadmap gate.

## Non-goals

Ruled out, named so nobody builds them by accident:

- Extraction that reads from the store (`ingestDocument()` stays unchanged).
- Document facts the librarian may replace.
- Working memory and per-source ageing in the store.
- Agent-facing surfaces: `core-llm-tools`, the MCP `memory_search` pass-
  through, and the cloud contract.
- Any change to what a host on today's API gets on upgrade.
- OKF markdown export of sources.
- A device measurement of expo-sqlite FTS5 availability — named in the
  issue as "not checked"; the store works under both strategies by
  construction, and the gap stays named here rather than closed by a claim.
