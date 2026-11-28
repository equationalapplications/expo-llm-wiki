# Source store: the passage count probes the wrong index (issue #489)

Status: Reviewed (owner-approved 2026-11-28, Discord msg `1576081158758998158`)

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
answer. The `entity_id` predicate adds no information.

## Evidence

Reproduction on this machine, 2026-11-28, better-sqlite3, one entity,
5,000 documents, 3 passages per document:

| Query | Plan for the inner probe | Time |
|---|---|---|
| Shipped (both predicates) | `idx_source_passages_entity` | 10,083 ms |
| Fixed (`document_id` only) | `idx_source_passages_doc` (covering) | 7.8 ms |

The issue reporter measured the same shape at other scales (1,000 → 88 ms,
4,000 → 1.4 s, 20,000 → 37 s). `exportStoredSources` is not affected: its
per-document passage query filters on `document_id` and already plans on
the `(document_id, seq)` index.

## Proposed change

`SourceStoreService.listStoredSources` correlates on `document_id` alone:

```sql
(SELECT COUNT(*) FROM ${prefix}source_passages p
  WHERE p.document_id = d.id) AS passage_count
```

The query keeps the same result shape, order (`source_ref COLLATE BINARY`),
and entity isolation. No type changes. No API changes. The engine exports
no new symbols from `src/index.ts`.

To pin the plan without copy-drift, the SQL moves into a small builder
helper, `listStoredSourcesSql(prefix)`, exported from
`SourceStoreService.ts` (not from `src/index.ts`). The prefix is
interpolated, so a builder keeps one source of truth: the method and the
plan test both call it with the same prefix.

One invariant underpins the single-predicate correlation: every engine
write path (`sourceStoreUpsert`, the import path) stamps a passage's
`entity_id` equal to its document's `entity_id`. The schema enforces no
foreign key between the two tables, so the correlation on `document_id`
alone is correct only under this writer invariant. The invariant is stated
here and relied on; enforcing it with a trigger or check is out of scope.

## Scope ruling

The owner ruled 2026-11-28 (Discord): this PR ships the SQL fix and its
tests only. The paged variant (`afterSourceRef`, `limit`) and the point
probe (`hasStoredSource(entityId, ref)`) are out of scope. A follow-up
issue carries them. Rationale: the SQL fix removes the blast radius; the
new API surface needs its own spec cycle against source-store §4/§7.

## INTENT alignment

The change fixes a defect against the shipped source-store spec (§4:
`listStoredSources` returns `sourceRef`, `sourceHash`, `charCount`,
`passageCount`, `storedAt`). The result contract does not change. INTENT
rule 2 (additive result fields) is not implicated. The Curated Thoughts
guard does not read this SQL. No rule contradicts the change.

## Files touched

- `packages/core/src/services/SourceStoreService.ts` — replace the
  correlated subquery's predicate; add the `listStoredSourcesSql(prefix)`
  builder helper.
- `packages/core/__tests__/sourceStoreRead.test.ts` — add the plan test and
  the performance test described below.

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
   must pass without edits: entity isolation, `passageCount` accuracy,
   `passageCount 0` for a source stored with no ingest.
3. **Performance guard.** Open a file-backed database through a dedicated
   handle (`new WikiMemory(openTestDatabase(path), options)` plus its own
   `setup()`). Seed one entity with 5,000 documents and 3 passages per
   document through raw SQL. Call `listStoredSources` once. Assert the
   call returns 5,000 rows in under 500 ms. This scale is the measured
   point, not an extrapolation: the shipped path measures about 10,000 ms
   there (5,000 × 3 probe, 2026-11-28) and the fixed path 7.8 ms. The
   guard runs against the shipped SQL first and its failing time becomes
   ledger RED evidence.
4. **Full suite.** `pnpm test` must pass. `pnpm exec tsc --noEmit` must
   pass with zero errors.

## Rejected alternatives

- **`GROUP BY document_id` joined in code.** The issue offers this shape.
  We rejected it for this PR: it adds a second query, a join map, and
  transactional skew risk between the two reads. The one-predicate
  correlated form plans on the covering index and stays one statement.
- **Paged variant and `hasStoredSource` in this PR.** Rejected per the
  owner ruling above; tracked in the follow-up issue.
- **Drop `passage_count` from the listing.** Rejected: the field is a
  shipped §4 contract; removing it breaks the result shape.

## Errata

- 2026-11-28 — the probe numbers above come from a scratch reproduction,
  not from this repo's benchmark suite. The PR will re-run the same probe
  on the fixed SQL and record the final numbers here.
- 2026-11-28 — owner amendment at approval: the shared SQL ships as a
  builder helper `listStoredSourcesSql(prefix)`, not a module constant,
  because the query interpolates `${prefix}`.
- 2026-11-28 — Opus plan-review r1 folds: the perf guard moved to the
  measured 5,000 × 3 scale (the earlier 2,000-doc figure was
  extrapolation); the EQP pin is named the primary regression guard; the
  entity-pair writer invariant is stated in Proposed change. Full
  adjudication in the lane's r1 dispositions record.
