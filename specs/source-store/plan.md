# Plan — source store (specs/source-store/spec.md, PR #396)

Binding authority: `specs/source-store/spec.md` (spec wins on detail;
`INTENT.md` wins on intent). Section references below (§N) are spec
sections. Conventional commits name the spec section fulfilled. The lane is
SINGLE-PR: spec + plan + implementation land on this branch, cleanup commit
last, `gh pr ready` after.

## Gates (canonical, from repo AGENTS.md + package.json)

- Unit/type gates: `pnpm test` at repo root (runs every package except
  integration, then integration without the two embedding suites).
- `pnpm typecheck`.
- Baseline: recorded in LEDGER.md once the baseline run completes
  (`.superpowers/sdd/source-store/` holds the logs). Expected-count deltas
  are computed from the recorded baseline per task.

## Stage A — foundation

### Task 1 — schema + migration v17 (spec §3, test items 2–3)
`packages/core/src/db/schema.ts`: every-open DDL for `source_documents`
and `source_passages` per the v9 pattern (CREATE TABLE IF NOT EXISTS,
UNIQUE indexes incl. entity_id per §3; source_documents two plain UNIQUE
indexes; source_passages no UNIQUE). `packages/core/src/db/migrations.ts`:
append migration v17 — pre-check aborts (actionable error, before any
write) when either table exists with rows or a column set differing from
§3; empty expected-state tables pass (the every-open DDL creates them
empty first, `db/migrations.ts:175`); idempotent no-op backfill; fresh
installs stamp v17.
Tests: copy the `migration9.test.ts` pattern — fresh stamp, old-DB
migrates, idempotent on no-sources DB, abort-on-rows and abort-on-column-
mismatch fire before any write; additivity test asserting no column added
to the CT nine-table guard list.
Gates: `pnpm --filter @equationalapplications/core-llm-wiki test`,
`pnpm typecheck`.

### Task 2 — the `store` operation type (spec §10, §7; test item 7)
`packages/core/src/types.ts`: `WikiBusyOperation` gains `'store'`.
`packages/core/src/services/JobManager.ts`: new `OperationType` `store` on
the `${prefix}:${entityId}:store` key; conflicts with ingest, import,
prune, librarian, heal, ontologyBackfill, reembed, forget, and any other
store of the same entity — BOTH directions (the switch's per-operation
`else if` chains each gain a store check; `global_reembed`'s key-suffix
match gains its `:store` line; `global_import` is a separate case).
Busy behavior stays the engine-wide throw (`WikiBusyError`, no wait) —
§7's stated exception.
Tests: a store that races a maintenance op on the same entity throws
`WikiBusyError`; two concurrent stores serialize; a store while an ingest
is active throws.
Gates: as Task 1.

### Task 3 — hasher + diagnostic codes (spec §3, §9)
`packages/core/src/utils/sha256.ts`: new pure SHA-256, no dependency
(mirrors `packages/okf/src/sha256.ts`). `packages/core/src/types.ts`:
`WikiDiagnosticCode` gains `source_store_source_too_large`,
`source_store_budget_exceeded`, `source_store_hash_mismatch`,
`source_store_duplicate_hash`, `source_store_text_not_storable`;
`WikiDiagnosticOperation` gains the store's operation value (`types.ts:858`
/ `types.ts:889` are the existing registries).
Tests: SHA-256 known vectors + empty-input vector; codes appear in the
unions (type-level).
Gates: as Task 1.

## Stage B — the store service

### Task 4 — store write path (spec §5, §7 storeSource, §9 budget; test items 4, 7)
`packages/core/src/services/SourceStoreService.ts` (new): `storeSource`
per §7/§8 — wrong-shaped `sourceHash` throws (invalid argument, matching
`IngestionService.ts:127-128` convention); lone surrogate / embedded NUL
refuse `source_store_text_not_storable`; same-pair no-op when
`text_hash` matches, `source_store_hash_mismatch` refusal when text
differs; duplicate-hash check against `source_documents` UNIQUE index AND
live rows of `source_ref_index` (partial on `deleted_at IS NULL` —
forgotten tombstones block nothing); budget check inside the write
transaction under the per-entity `store` lock (§9); `charCount`,
`passageCount`, `storedAt` results. Hard delete on changed-copy replace
(§5). UTF-16 code-unit counting throughout.
`packages/core/src/services/MaintenanceService.ts`: `forget` and
`clearAll` delete store rows in the existing transaction.
Tests: refusal matrix incl. cross-table duplicate, tombstone negative
case, mismatch re-store, budget exceed inside transaction, concurrent
store budget pin (item 7), surrogate/NUL refusals.
Gates: as Task 1.

### Task 5 — store read paths + listSourceRefs.stored (spec §4; test items 4, 6)
`SourceStoreService`: `getStoredSource` (text as handed + charCount +
storedAt, or null), `listStoredSources` (incl. stored-without-ingest).
`listSourceRefs` three-state `stored` field keyed on
`(sourceRef, sourceHash)`: `{ charCount }` exact pair; `{ charCount,
staleHash: true }` ref held under a different hash; `null` nothing for
the ref — including a forgotten ref, which stays listed with `stored:
null` (forget removes store rows, not the ref's facts).
Tests: three-state matrix, stale-hash after changed copy, forgotten ref
stays listed (item 6), stored-without-ingest listing.
Gates: as Task 1.

## Stage C — indexing + search

### Task 6 — passage index on both strategies (spec §6; test item 5)
`packages/core/src/services/search/fts5Sql.ts`,
`MiniSearchIndexStrategy.ts`, `createIndexStrategy.ts`: the second index
(`source_passages_fts` via the enqueue-and-drain ledger, with the stated
departure — the passage drain reads the one document's text into JS and
slices there, transient memory bounded by `maxCharsPerSource` per
document; MiniSearch fallback over the same slices). Passage cutter per
§3: own offset-tracking pass, at most 12,000 UTF-16 units, whitespace
preferred, never splits a surrogate pair, no trim, no overlap — NOT
`chunkText`.
Gates: as Task 1 (strategy tests pin both paths).

### Task 7 — the `sources` read option (spec §7; test items 4–5)
`packages/core/src/services/RetrievalService.ts` +
`packages/core/src/types.ts`: `read()` option
`sources: { query, maxPassages?, charBudget? }`; additive optional
`MemoryBundle.sources` group of
`{ entityId, sourceRef, sourceHash, seq, startOffset, endOffset,
truncated, text }`; defaults 8 / 4,000 UTF-16 code units; whitespace
window with true offsets + hard-cut fallback (never drop a match for
size); match-position ruling (earliest literal occurrence of any matched
term, ASCII-case-insensitive; passage-start anchor with `truncated:
true` when it cuts); per-entity ranking/caps, never across entities;
absent option = byte-identical bundle.
Tests: emoji/UTF-16 offset fixtures, leading-whitespace and
repeated-substring fixtures, both strategies return right passages, caps
hold, cut windows report `truncated: true`, long-token hard-cut,
two-entity per-entity groups.
Gates: as Task 1.

## Stage D — surfaces

### Task 8 — dump import/export (spec §8; test item 8)
`packages/core/src/services/ImportExportService.ts` +
`packages/core/src/types.ts`: `MemoryDump.entities[id].storedSources?`
(additive; read-result bundle does not carry it); export writes per
entity in scope; import restores rows, re-derives passages, recomputes
`text_hash`, honors §9 limits with the same refusals; per-source
skip-and-list; `importDump` resolves additive
`{ skippedSources: Array<{ sourceRef, code }> }` (was `Promise<void>` —
callers ignoring it unaffected); `merge: false` is wipe-then-write inside
the import transaction, refused sources absent from the new store.
Tests: round-trip, old-dump import no-op, refusal diagnostics at limits,
merge + full-replace semantics, skippedSources populated.
Gates: as Task 1.

### Task 9 — WikiMemory wiring + formatContext (spec §7; test items 1, 5–6)
`packages/core/src/WikiMemory.ts`: public methods `storeSource`,
`getStoredSource`, `listStoredSources`, `listSourceRefs.stored`, the
`read()` `sources` option, wiring (locks, services).
`packages/core/src/utils/formatContext.ts`: prints the group under a
`Sources` heading after the existing groups.
Tests: no-model proof (spy fails if the model hook fires during
storeSource/getStoredSource/listStoredSources/sources-read); link test
(item 6: join after ingest, gone after forget, ref listed `stored:
null`); `formatContext` output.
Gates: as Task 1.

### Task 10 — INTENT rule 5 reword (spec §1)
`INTENT.md`: rule 5's Planned-paragraph reword per spec §1 (keeps the
#377 shipped status and the roadmap cross-reference; removes only the
Planned store commitments). NOTE: INTENT.md sits behind a protection
hook — the controller applies this edit in-session (spec + owner
approval on record); no child dispatch.
Gates: `pnpm typecheck` (docs-only otherwise).

## Stage E — close

### Task 11 — full-suite verification sweep (test items 1–9) + cleanup commit
Run the full canonical gate suite at the implementation head; verify all
nine test-plan items have pins; reconcile the ledger. Cleanup commit (LAST,
pre ready-flip): spec Status Draft → Implemented, delete `plan.md` and
`LEDGER.md`, roadmap step-4 done mark per AGENTS.md. Then `gh pr ready`,
code review ladder on the implementation diff (T1.5 fresh-full → Opus →
Fable per the standing ladder), fix rounds, merge on owner go.
