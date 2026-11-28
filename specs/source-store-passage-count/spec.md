# Source store: the passage count probes the wrong index (issue #489)

**Status:** Implemented (2026-11-28, PR #490).
**Date:** 2026-11-28
**Intent check:** touches INTENT rule 3 (entity scoping — preserved via the
`+entity_id` term; see INTENT alignment) and rule 2 (no schema or result-type
change); source-store §10 stays true for this query.

## Problem

`WikiMemory.listStoredSources(entityId)` runs one SQL query. The query ends
each row with a correlated `COUNT(*)` over `source_passages`. SQLite plans
that inner probe on the `(entity_id)` passage index. Every document then
scans every passage of the entity. The cost is O(documents × passages).

`better-sqlite3` is synchronous. A slow call blocks the host's event loop.
At 20,000 documents the issue reporter measured about 37 seconds. A host
that probes "does this ref exist" through `listStoredSources` spends its
whole request budget on the probe.

## Root cause

The inner subquery carries two predicates:

```sql
(SELECT COUNT(*) FROM llm_wiki_source_passages p
  WHERE p.entity_id = d.entity_id AND p.document_id = d.id) AS passage_count
```

SQLite resolves the inner probe with `entity_id`, because the
`(entity_id)` index exists and matches the first predicate. The plan
(observed in this repo's own probe, 2026-11-28, better-sqlite3, in-memory):

```
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING INDEX llm_wiki_idx_source_passages_entity (entity_id=?)
```

`document_id` already identifies one entity's document. The
`(document_id, seq)` index (`idx_source_passages_doc`, schema.ts) covers the
answer. The `entity_id` predicate adds no information — but it is kept
(with a `+` unary term, see Proposed change) so the query still enforces
source-store §10's isolation rule itself.

## Evidence

Reproduction on this machine, 2026-11-28, better-sqlite3, one entity,
5,000 documents, 3 passages per document:

| Query | Plan for the inner probe | Time |
|---|---|---|
| Shipped (both predicates) | `idx_source_passages_entity` | 10,083 ms |
| Fixed (planning form, `document_id` only) | `idx_source_passages_doc` (covering) | 7.8 ms |
| Fixed (shipped form, `+entity_id` term) | `idx_source_passages_doc` (non-covering) | 11.55 ms |

The shipped form keeps the `entity_id` filter as a `+`-prefixed term — see
Proposed change. These first two rows are the planning-session scratch
figures; the final repo-run numbers (shipped 10,414 ms; fixed 15 ms /
12.55 ms / 10.33 ms covering-form, 11.55 ms / 13.09 ms final
`+entity_id`-term form) are in the Errata at the end of this document and
supersede them.

The issue reporter measured the same shape at other scales (1,000 → 88 ms,
4,000 → 1.4 s, 20,000 → 37 s). `exportStoredSources` is not affected at
issue scales: its per-document passage query filters on both
`entity_id = ?` and `document_id = ?` (`ImportExportService.ts`), one
document per outer row, and orders by `seq` — which the
`(document_id, seq)` index serves, so the probe is expected to stay off
the entity index; its EQP pin joins the #491 cycle.

## Proposed change

`SourceStoreService.listStoredSources` correlates on `document_id` for the
index and keeps the `entity_id` filter as a `+`-prefixed term:

```sql
(SELECT COUNT(*) FROM ${prefix}source_passages p
  WHERE p.document_id = d.id AND +p.entity_id = d.entity_id) AS passage_count
```

The unary `+` on `p.entity_id` is a value no-op in SQLite, but the planner
cannot use that term for index selection — so the probe stays on
`idx_source_passages_doc` while the query still filters foreign-entity
passages out of the count itself (source-store §10 stays literally true;
no writer invariant is relied on for isolation).

The query keeps the same result shape, order (`source_ref COLLATE BINARY`),
and entity isolation. No type changes. No API changes. The engine exports
no new symbols from `src/index.ts`.

To pin the plan without copy-drift, the SQL moves into a small builder
helper, `listStoredSourcesSql(prefix)`, exported from
`SourceStoreService.ts` (not from `src/index.ts`). The prefix is
interpolated, so a builder keeps one source of truth: the method and the
plan test both call it with the same prefix.

An isolation pin test plants a passage with a foreign `entity_id` on this
entity's document through raw SQL (a writer-invariant violation the schema
does not prevent) and asserts it is not counted.

## Scope ruling

The owner ruled 2026-11-28 (Discord): this PR ships the SQL fix and its
tests only. The paged variant (`afterSourceRef`, `limit`) and the point
probe (`hasStoredSource(entityId, ref)`) are out of scope. Follow-up issue
#491 carries them. Rationale: the SQL fix removes the blast radius; the
new API surface needs its own spec cycle against source-store §4/§7.

## INTENT alignment

The change fixes a defect against the shipped source-store spec (§7:
`listStoredSources` returns `sourceRef`, `sourceHash`, `charCount`,
`passageCount`, `storedAt`; §4 names the call). The result contract does
not change. INTENT
rule 2 ("Your database stays yours" — the schema only ever grows) is not
implicated: no schema change. INTENT rule 3 ("one
database, many memories, never mixed" — every read is scoped to one
`entityId`) IS touched: the fix removes the bare `entity_id` equality that
let the planner pick the entity index. The shipped form keeps the filter
as a `+`-prefixed term the planner cannot index on, so the query still
excludes other entities' passages itself and source-store §10 ("every
query on them filters by it in the `WHERE` clause … a read for one entity
can never return another entity's passage") stays literally true for this
query, without amending that implemented spec. (Repo-wide, §10's letter
already has a pre-existing exception — `MiniSearchIndexStrategy` reads the
store tables by id inside an entity-scoped loop; noted for the #491
cycle.) The Curated Thoughts guard does not read
this SQL. No rule contradicts the change.

## Files touched

- `packages/core/src/services/SourceStoreService.ts` — replace the
  correlated subquery's predicate; add the `listStoredSourcesSql(prefix)`
  builder helper.
- `packages/core/__tests__/sourceStoreRead.test.ts` — add the plan test,
  the counting regression tests (including the foreign-`entity_id`
  isolation pin), and the performance test described below.

## Test plan

1. **Plan pin (deterministic; the primary regression guard).** Build the
   store through the test file's `setup()` helper (tables and indexes
   exist only after `wiki.setup()`). Seed one entity with documents and
   passages through `storeSource`. Run `EXPLAIN QUERY PLAN` over
   `listStoredSourcesSql(PREFIX)` through the adapter's `getAllAsync`,
   binding the entity parameter (`[E]`) — the SQL carries a `?`. Assert
   the plan names `idx_source_passages_doc`. Assert the plan does not
   name `idx_source_passages_entity`.
2. **Behavior unchanged.** The existing `sourceStoreRead.test.ts` suite
   must pass without edits: entity isolation, `passageCount` accuracy on
   its single-passage fixtures. Note what the existing suite does NOT
   cover: it has no document with zero passages and none with several
   passages per document (the test titled "passageCount 0" asserts
   `passageCount: 1`). The new counting tests below close that gap.
3. **Counting regression tests.** Written before the fix. Two documents
   inserted through raw SQL — 0 and 3 passage rows — assert
   `listStoredSources` returns passage counts `[0, 3]`. These pass
   against the shipped SQL; they fail a wrong correlation (for example,
   counting every passage of the entity).
4. **Isolation pin.** Plant a passage with a foreign `entity_id` on this
   entity's document through raw SQL (a writer-invariant violation the
   schema does not prevent) and assert the listing does not count it.
   This fails the planning form's bare `document_id`-only correlation and
   passes the shipped `+entity_id`-term form.
5. **Performance guard.** Open a file-backed database through a dedicated
   handle (`new WikiMemory(openTestDatabase(path), options)` plus its own
   `setup()`). Seed one entity with 5,000 documents and 3 passages per
   document through raw SQL. Call `listStoredSources` once. Assert the
   call returns 5,000 rows in under 500 ms. This scale is the measured
   point, not an extrapolation: the shipped path measures about 10,000 ms
   there (5,000 × 3 probe, 2026-11-28) and the fixed path about 15 ms
   (final figures in the Errata; the guard's RED run against the
   shipped SQL was captured before the fix landed and is recorded there).
6. **Full suite.** `pnpm test` must pass. `pnpm exec tsc --noEmit` must
   pass with zero errors.

## Rejected alternatives

- **`GROUP BY document_id` joined in code.** The issue offers this shape.
  We rejected it for this PR: it adds a second query, a join map, and
  transactional skew risk between the two reads. The correlated form
  plans on `idx_source_passages_doc` and stays one statement.
- **Bare one-predicate correlation (`document_id` only).** Considered — it
  is the fastest shape (covering index) and correct under the engine's
  writer invariant, but it removes the query's self-enforced entity
  filter, contradicting source-store §10's letter. The shipped form keeps
  the filter as a `+`-prefixed term instead, at a measured cost of ~0
  (see Errata, T4-fold numbers).
- **Paged variant and `hasStoredSource` in this PR.** Rejected per the
  owner ruling above; tracked in follow-up issue #491.
- **Drop `passage_count` from the listing.** Rejected: the field is a
  shipped §4 contract; removing it breaks the result shape.

## Errata

- 2026-11-28 — final repo-run numbers at 5,000 docs × 3 passages
  (replacing the planning-session scratch figures above — the Evidence
  table and the Test plan's performance-guard step; shipped-path figure
  measured against the pre-fix SQL, fixed-path figures against PR #490's
  `listStoredSourcesSql`): **shipped 10,414 ms** (file-backed, T3 guard
  RED run in vitest); **fixed 15 ms** (file-backed, T4 guard run in
  vitest); **fixed 12.55 ms cold / 10.33 ms best-of-3** (in-memory,
  better-sqlite3 probe mirroring the shipped schema DDL and indexes;
  EQP confirms `SEARCH p USING COVERING INDEX llm_wiki_idx_source_passages_doc`).
  The planning-session 7.8 ms in-memory figure is superseded by these.
- 2026-11-28 — Tier-4 review fold (M1): the shipped predicate is now
  `WHERE p.document_id = d.id AND +p.entity_id = d.entity_id` — the bare
  one-predicate form contradicted source-store §10's letter ("every query
  on them filters by it in the `WHERE` clause"). The `+` unary term is a
  value no-op but keeps the entity predicate out of index selection, so the
  probe stays on `idx_source_passages_doc` (EQP, in-memory probe,
  better-sqlite3: `SEARCH p USING INDEX llm_wiki_idx_source_passages_doc
  (document_id=?)` — no longer COVERING) and the query again excludes
  foreign-entity passages itself. Re-measured at 5,000 docs × 3 passages,
  in-memory: **11.55 ms cold / 13.09 ms warm** — within noise of the
  covering-index form. The plan pin and the vitest file-backed guard pass
  unchanged; an isolation pin test now plants a foreign-`entity_id`
  passage through raw SQL and asserts it is not counted.
- 2026-11-28 — Tier-4 note (m1/m5, pre-existing, tracked with #491): the
  write path's idempotence `COUNT(*)` and replace `DELETE` in
  `sourceStoreUpsert.ts` carry the same `entity_id = ? AND document_id = ?`
  shape and may plan on the entity index; ~2 ms per call at 15,000
  passages. `MaintenanceService.ts`'s per-document passage `DELETE`
  (`entity_id = ? AND document_id IN (SELECT …)`) shares the family, as
  does `exportStoredSources`'s passage probe above. The
  `MiniSearchIndexStrategy` store-table reads (by id inside an
  entity-scoped loop) carry the same writer-invariant reliance. EQP
  pins for those statements belong to the #491 cycle, as does an
  executed-SQL capture of the listing pin (recording-adapter pattern of
  `edgeQueryPlans.test.ts`) so the pin follows the statement the method
  runs, not just the builder. Also for that
  cycle: this PR's perf-guard fixture seeds 12-character texts, so it
  does not exercise the overflow-chain cost real long documents pay on
  row-layout grounds (bounded by the 5,000,000-character default budget;
  predates this PR).
- 2026-11-28 — owner amendment at approval: the shared SQL ships as a
  builder helper `listStoredSourcesSql(prefix)`, not a module constant,
  because the query interpolates `${prefix}`.
- 2026-11-28 — Opus plan-review r1 folds (dispositions inlined): the perf
  guard moved to the measured 5,000 × 3 scale (the earlier 2,000-doc
  figure was extrapolation); the EQP pin is named the primary regression
  guard; the entity-pair writer invariant was stated in Proposed change
  (superseded by the Tier-4 fold above — the shipped predicate now
  enforces the pair itself).
