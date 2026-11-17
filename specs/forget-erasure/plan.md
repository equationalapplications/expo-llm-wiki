# Implementation plan — forget-erasure (#404 / issue #401), spec rev 27

Baseline: spec.md rev 27 @ c35d431d (branch `specs/forget-erasure`), worktree
`/mnt/kv-work/build/worktrees/expo-llm-wiki/forget-erasure`. Investigation converged at rev 12.
All owner rulings A–H ratified 2026-11-17 and folded into rev 27; engine INTENT.md rules 12/13
and the Superseded/Forgotten/Gone/Erased glossary are **already amended — do not re-edit them**
(status-line INTENT touches in the implementation PR remain per house rule).

**OWNER GATE: implementation is gated. Nothing in this plan starts until Kurt says go.**
The standing default for execution is a Claude Code subagent driving the worktree, with
dual review (Opus + Fable) after implementation, then `gh pr ready` and a merge-gate ask to Kurt.

Conventions used below: T-numbers map 1:1 to spec sections; each task's acceptance criteria are
drawn verbatim from the spec's Test plan and §2/§3 requirements; each task ends green on
`pnpm -r typecheck` + the unit suite (wall-clock-flake-prone timeouts re-run in isolation per the
known flake signature, spec test 8).

---

## Task breakdown

### T1 — `secure_delete=FULL` pragma foundation (spec §1)
Files: `packages/core/src/db/schema.ts`, `packages/core/src/WikiMemory.ts` `setup()`, guide (T9
owns guide prose; T1 may add the code-comment stub).
- Set `PRAGMA secure_delete=FULL` in `setup()` on the **host-provided handle**; read back after
  setting; warn on refusal. Always on, no opt-out, no option, ever (ruling B).
- Document (comment): the pragma is connection-wide and ATTACH-wide; hosts whose own code writes
  wiki tables must set it too.
Acceptance:
- AC1 (H-mirror, test 2): after `setup()`, flip `PRAGMA secure_delete=OFF` on the same
  connection; `'rebuild'` alone leaves the canary recoverable — pins that `'rebuild'` is
  insufficient without the pragma.
- AC2: setup-time read-back surfaces a warning when the runtime refuses FULL.

### T2 — Lock & fencing: `'erase'` in JobManager (spec §2, lock material; ruling F prerequisite)
Files: `packages/core/src/services/JobManager.ts`, `packages/core/src/types.ts`,
`packages/core/src/services/MaintenanceService.ts`.
- Add `'erase'` to `OperationType` (`JobManager.ts:3-14`) and `WikiBusyOperation`
  (`types.ts:1209-1218`) — prerequisite for the universal pre-check's typing; the union widening
  rides the MINOR with the policy written into the type's JSDoc (ruling F; note `types.ts:1203-1207`
  documents a prior widening as breaking — ruling F supersedes that caution).
- `acquireLock`/`releaseLock` gain an `'erase'` case and a **fourth `owner` parameter**
  (default `'host'`; the third positional `sourceRef?` at `JobManager.ts:190` is not reused).
  Exclude `'erase'` from the `lockKeyFns` map type (`:104-107`) so `releaseLock`'s fallthrough
  (`:322`) cannot index a missing entry. Pin `_eraseKey()` to `` `${prefix}:erase` ``.
- **ONE universal pre-check** beside the `global_import` pre-check (`:193-195`):
  `operation !== 'erase' && !(operation === 'prune' && owner === 'erase') &&
  this.activeMaintenanceJobs.has(this._eraseKey())` → `WikiBusyError('erase', '*')`.
  The `WikiBusyError` construction (`:295-298`) passes `'*'` for `'erase'` too.
- **Mirror in `isBlocked`** (`:332-389`) using the simpler form
  `operation !== 'erase' && this.activeMaintenanceJobs.has(this._eraseKey())`.
- Erase's acquisition rule: `acquireLock('erase', '*')`; the `'erase'` arm mirrors
  `global_reembed`'s any-active refusal (`:236-247`), self-checks first (second concurrent erase →
  `WikiBusyError('erase', '*')`), checks `this.activeIngestJobs.size > 0` via the **separate set**
  (`:243`), and states explicitly that the `:reembed` suffix scan subsumes the global key.
- `MaintenanceService` gains private `_runPrune(entityId, opts, owner)`; public `runPrune` passes
  `owner: 'host'`; the existing distinct-entity walk (`MetadataRepository.ts:186`) gains the
  hard-delete cutoff as an optional parameter or sibling method — host-facing semantics of the
  shared walk unchanged (T4 delta-3 m4).
Acceptance (tests from spec test 3 + §2 tests):
- AC1: erase with N entities hard-deletes in all N.
- AC2: concurrent `storeSource` during erase → `WikiBusyError('erase', '*')`.
- AC3: standalone `runPrune` during erase → `WikiBusyError('erase', '*')`.
- AC4: second concurrent `erase()` → `WikiBusyError('erase', '*')` (self-check).
- AC5: `global_reembed` during erase → `WikiBusyError('erase', '*')`.
- AC6: erase refused at start while a librarian is active → `WikiBusyError('librarian', '*')`.
- AC7: erase refused while a global re-embed is active → `WikiBusyError('reembed', '*')`
  (reverse-direction hardening).
- AC8 (isBlocked mirror): `write()` during erase neither advances nor rolls back the memory
  checkpoint.

### T3 — erase() prune core: steps 0, 1, 1b (spec §2; rulings A, B, G)
Files: `packages/core/src/services/MaintenanceService.ts`,
`packages/core/src/repositories/MetadataRepository.ts` (walk widening), `EntryRepository.ts` (none
here).
- **Step 0** (ruling B, T4 delta-8 MAJOR-1): read `PRAGMA secure_delete` on the connection; if not
  `1`, re-assert + read back, else fail with `erase_secure_delete_off`, erasure marked
  **unverified**. Report includes pragma state and `sqlite_version()` (GDPR §8-B).
- **Step 1**: per-entity prune with `retainSoftDeletedFor: 0` **and `retainEventsFor: null`**
  (events kept; the event-retention block never runs, so holds reporting covers **external-removal
  holds only**, `MaintenanceService.ts:397-401`). Enumerate **soft-deleted tasks too** (T4
  MAJOR-2) via the widened shared walk, not a UNION. Holds caught per entity
  (`PrunePartialFailureError` semantics) — erase continues and reports holds per entity; a
  per-entity `'prune'` `WikiBusyError` **skips** with a diagnostic (defense-in-depth, not expected
  to fire under the start refusal). Step 1 runs with `vacuum: false`.
- **Step 1b** (ruling G, store-wide, T4 delta-7 MAJOR-1): one statement
  `DELETE FROM source_ref_index WHERE deleted_at IS NOT NULL`, **only after a
  `sourceRefIndexPresent(tx)` probe** (skip with a diagnostic when absent — pre-v9 store).
- **`runPrune` gains `opts.syncedIds?: string[]`** (output-array pattern like `deletedKeys`),
  filled before `PrunePartialFailureError` throws; contract = superset of hard-deleted ids; step 6
  consumes it best-effort (containment, not equality).
Acceptance:
- AC1 (test 3): unconfirmed external removal → erase hard-deletes nothing held, reports holds.
- AC2 (test 3): event count unchanged after erase (`retainEventsFor: null`); no
  `event_retention_held` diagnostic.
- AC3 (test 3, step 0): flip the pragma OFF after setup → erase fails with
  `erase_secure_delete_off`, marked unverified, never a false success.
- AC4 (test 5, task-only): forget tasks only + erase → task rows gone from the file.
- AC5 (step 1b, ruling G): `forget({ sourceRef: R })` + `erase()` → no `source_ref_index` row
  carrying `R`, live or tombstoned; **variant**: `forget({ sourceRef: R })` → standalone
  `runPrune` → `erase()` → same assertion (entity unenumerated; store-wide 1b still cleans it).
- AC6 (T3 delta-8 m1): a hold and a successful delete in the same erase — step 6 receives a
  superset of the deleted ids.
- AC7: pre-v9 store without `source_ref_index` → step 1b skips with a diagnostic, erase proceeds.

### T4 — FTS surfaces: steps 3, 4 (+ fallback), 7 (spec §2)
Files: `packages/core/src/services/SearchService.ts`,
`packages/core/src/services/search/Fts5IndexStrategy.ts`,
`packages/core/src/services/MaintenanceService.ts` (module-less fallback lives **beside erase**
there, not in Fts5IndexStrategy — T4 delta-7 MAJOR-2).
- **Step 3**: surfaced, `syncChain`-chained drain variant on `SearchService` (never a bare
  `indexStrategy.drainPassages`), no deadline, errors surfaced. Fail-and-report only when
  `passagesDisabled` **and** `source_passages_fts_pending` has rows; otherwise warn + continue.
- **Step 4**: retired-table reclaim to completion (`DROP` + delist), no deadline, failures
  surfaced; required whenever retired tables exist even if `entries_fts` is missing. On a
  module-less runtime: `DELETE FROM` each retired table's shadow tables (`_content`, `_data`,
  `_idx`, `_docsize`, `_config`) under the pragma, keep the name listed, surface
  `erase_retired_vtab_undroppable`; a later FTS5-capable open completes the `DROP` (the
  `SQLITE_CORRUPT_VTAB` hollowed-shell exit is **designed** — do not "fix" it).
- **Step 7**: FTS `'optimize'` on both FTS tables when they exist, after `syncEntries`;
  `erase({ rebuild: true })` escape hatch.
- **Step 4 re-run after step 6** (cheap when empty); assert no `entries_fts_retired_*` exists when
  erase returns.
Acceptance:
- AC1 (test 7 / M4): forced corruption reset leaves a retired table → forget + erase reclaims it
  to completion; whole-file scan clean.
- AC2 (module-less): no-FTS runtime with `entries_fts_retired_N` present → shadow tables empty,
  name still listed, diagnostic surfaced.
- AC3: `syncEntries` resolving `false` (ledger drain failed) is a **failed step** (T4 m3).

### T5 — Wrapped VACUUM, checkpoints, syncEntries, optimize tail: steps 5, 6, 8 (spec §2)
Files: `packages/core/src/services/MaintenanceService.ts` (`_wrappedVacuum()`),
`packages/core/src/repositories/MetadataRepository.ts`.
- `_wrappedVacuum()` private method in `MaintenanceService` (NOT `MetadataRepository.vacuum()` —
  layering cycle): `resetNormalizeWatermarks` → `vacuum()` → `restartRebuildAfterVacuum`; called by
  both `runPrune` and `erase`.
- `MetadataRepository.vacuum()` gains **only** the post-VACUUM `wal_checkpoint(TRUNCATE)`;
  **both** checkpoints (existing pre + new post) run via `getFirstAsync`; `busy !== 0` or
  `log !== checkpointed` → surfaced step failure `erase_checkpoint_incomplete`, erasure marked
  unverified (T4 delta-3 MAJOR-1). Non-WAL `(0,-1,-1)` passes as complete — do not "fix" to
  `log === 0`.
- **Step 6**: `syncEntries` for the `syncedIds` superset immediately after VACUUM (do not
  deduplicate against step 1's internal pass); treats `false` as failed step.
- **Step 8**: `wal_checkpoint(TRUNCATE)` last.
Acceptance:
- AC1 (test 3): two-connection fixture (second reader holds a read open) → erase surfaces
  `erase_checkpoint_incomplete` instead of success.
- AC2 (test 7 / M3): erase while FTS rebuild state is `rebuilding` → watermark reset + rebuild
  restart correct (VACUUM renumbering never survives a watermark).

### T6 — erase() orchestration + report shape (spec §2 composition; GDPR §8 report)
Files: `packages/core/src/services/MaintenanceService.ts`, `packages/core/src/WikiMemory.ts`.
- Compose steps 0→1→1b→(2 absent — no GC, ruling E)→3→4→5→6→(4 re-run)→7→8. Each step surfaces
  errors; a failed step fails the erase and reports where it stopped (T3 M7) — never a false
  success. Unfenced-write racing step 5 → deterministic, **reported, retryable** step-5 failure.
- Erase **awaits the full `syncChain`** at step 3's passage drain.
- **Erase report shape** (ratified rev 27): runtime + `sqlite_version()`, pragma state, every
  step's outcome, skipped entities, external holds, verified/unverified. INTENT rule 13.
- Public `wiki.erase()` + `erase({ rebuild: true })` on `WikiMemory`.
Acceptance:
- AC1 (§2 test): a `write()` racing erase's step 5 surfaces the deterministic step-5 failure
  rather than success.
- AC2: report carries `sqlite_version()` + pragma state + per-step outcomes (assert fields).

### T7 — Chain forget: `forget({ entryId, includeChain: true })` (spec §3)
Files: `packages/core/src/repositories/EntryRepository.ts`,
`packages/core/src/services/MaintenanceService.ts`, `packages/core/src/WikiMemory.ts` (typing).
- Depth-aware `findSupersessionChainIds` variant (cap `HISTORY_MAX_DEPTH = 100`, `maxDepth + 1`
  probe or depth-returning CTE) for truncation detection; no `deleted_at` filter.
- `ForgetParams.includeChain?`; chain ids soft-deleted into the prune flow, added to
  `deletedEntryIds` so sync/drain/backstop cover them (`MaintenanceService.ts:730-743`, drain
  `:754`).
- **Dry-run lift**: `forgetDryRun` accepts `entryId` **only when** `includeChain` is set (taskId
  stays rejected, `MaintenanceService.ts:875-877`); returns `chainEntryIds` + `truncated: true`
  with the depth-cap notice. `ForgetResult` gains `chainEntryIds`/`truncated` (additive, minor-safe).
- Doc: walk is not the connected component (fan-in A→C←B reaches C, not B); forward walk deletes
  the live current fact; composes only with `entryId`; must not box the future `forget({ eventId })`
  selector (#386).
Acceptance (test 4):
- AC1: fan-in fixture — forgetting A reaches C, not B.
- AC2: dry-run lists exactly the walked ids; `truncated` + cap notice on truncation.
- AC3: real run soft-deletes the chain; erasure completes after `erase()`.

### T8 — Ratified rev-27 GDPR additions (spec §2/Release/GDPR §8)
Files: `packages/core/src/WikiMemory.ts`, `ImportExportService.ts`, `packages/core/src/db/migrations.ts` (**no
new migration — none, ever**, rulings C+E).
- `exportDump` gains `includeForgotten` (default `false` — exports exclude forgotten rows unless
  the caller asks for a backup dump).
- `getRetentionPolicy()` — reads the host's declared retention back.
- **Tombstone-wins import guard**: an import whose dump carries a `deleted_at` tombstone for a
  live ref keeps the tombstone (forget wins over re-ingest).
Acceptance:
- AC1: `exportDump()` excludes forgotten rows by default; `includeForgotten: true` includes them.
- AC2: import with tombstone for a live ref → ref stays tombstoned (forget wins).
- AC3: `getRetentionPolicy()` returns the configured retention declaration.

### T9 — Docs, JSDoc policy, INTENT status lines (spec §6, Release, ruling D)
Files: `apps/docs/src/content/docs/guides/deleting-data.md`, `packages/core/src/types.ts`,
`INTENT.md` (status lines only — rules 12/13 + glossary already amended upstream).
Guide gains: erasure recipe (`forget` → `erase()`, **no standalone `runPrune`**), erase-time-not-
forget-time scoping with the `pruneSupersededAfter` caveat (enumerated entities only, T4 m5),
stored-documents-survive-erase + `forget({ sourceRef })` as their erasure path (ruling E; host
calls it per document on an erasure request), host-connection pragma requirement, copy census
(events kept unless `clearAll({ includeEvents: true })`; drain the outbox; manifest stays; exports
bring data back), VACUUM temp-db residue window (`PRAGMA temp_store=MEMORY` guidance), no-opt-out
`secure_delete=FULL` statement, ruling D sentences (events follow host `retainEventsFor`), and the
"handling an erasure request" recipe naming `forget({ eventId })` (#386) as prerequisite.
`types.ts`: `WikiBusyOperation` JSDoc records ruling F's minor-riding policy.
`INTENT.md`: status lines touched by this behavior (implementation PR per house rule).
Acceptance:
- AC1: guide contains every §6 sentence listed above; no standalone-prune step in the recipe.
- AC2: JSDoc policy present at `WikiBusyOperation`.

### T10 — Acceptance test suite + gates (spec Test plan 1–8)
Files: new test files under the core test tree; `canary-repro.cjs` stays the harness reference.
- **Test 1 (acceptance criterion)**, two tiers, canary = single lowercase alphanumeric token
  (byte-identical under `porter unicode61`):
  - Fact-path tier: `ingestDocument` stub-provider fixture (writes `source_ref_index`, **never
    `source_documents`**, no `storeSource`), 300+ filler facts, then the documented recipe
    `forget({ entryId })` → `erase()` (exact-recipe variant, T4 delta-3 m5) — whole-file absence
    (db, `-wal`, `-journal`, `-shm`, every `%_data` block). Also run with explicit
    `runPrune(entityId, { retainSoftDeletedFor: 0, retainEventsFor: null })` between forget and
    erase. Mirror scenarios F and G (optimize and rebuild variants; K/K2 composed-sequence).
  - Full-wipe tier: seed event `summary` canary (`write()`), unsent outbox row, entity summary;
    `clearAll({ includeEvents: true })` + outbox drain + `erase()`, hookless — whole-file absence.
  - Source-document tier (T4 delta MAJOR-3): `storeSource` canary text (no facts) → forget +
    erase → document survives; then `forget({ sourceRef: R })` + erase → whole-file clean.
  - B1 regression (ruling E): `storeSource`-only document with zero facts survives `erase()`;
    **every** stored document survives erase.
- Test 2 (H-mirror) — landed with T1 AC1.
- Test 3 (holds/step 0/events) — landed with T3/T5 ACs.
- Test 4 (chain) — landed with T7 ACs.
- Tests 5–7 — distributed to T3/T4/T5 as pinned above.
- Baseline gates: `pnpm -r typecheck`; unit suite
  (`pnpm -r --filter=!@equationalapplications/integration-llm-wiki test`); flake-prone timeouts
  re-run in isolation.
Acceptance:
- AC1: canary absent from every surface at every tier that claims whole-file absence.
- AC2: typecheck + unit suite green (documented flake signature excepted).

---

## Implementation order & dependencies

1. **T1** (pragma) — no deps; the erasure guarantee's substrate.
2. **T2** (locks) — no deps on T1; T3 depends on `_runPrune`/`owner` param and the universal
   pre-check; T6 depends on the `'erase'` enum members.
3. **T3** (prune core, steps 0/1/1b, syncedIds) — depends on T2. Provides `syncedIds` for T5.
4. **T4** (FTS steps 3/4/7) — depends on T2 (start refusal fences ingest); independent of T3
   except through orchestration.
5. **T5** (VACUUM/checkpoint/sync tail) — depends on T3's `syncedIds`; `_wrappedVacuum()` shared
   with `runPrune` may land with T3.
6. **T6** (orchestration + report) — depends on T1–T5; composes the full pipeline.
7. **T7** (chain forget) — independent of T3–T6; only needs T1-era soft-delete flow + T3's prune
   path for end-to-end erasure; can run parallel to T4/T5.
8. **T8** (GDPR additions) — independent; parallel-safe anytime.
9. **T9** (docs/JSDoc/INTENT status) — after T6/T8 so prose matches shipped API names.
10. **T10** (acceptance suite + gates) — runs throughout (per-task ACs) and closes the lane with
    the two-tier canary + full gates.

Parallelization: T1 → (T7, T8) and T2 → T3 → (T4 ∥ T5) → T6 → T9 → T10-final.

## Execution & review protocol (standing)

- **Owner gate first**: no implementation task starts until Kurt's explicit go on this plan.
- Implementation runs via a **Claude Code subagent** in this worktree (standing default), T-numbers
  as work units, each task committed separately (`feat(...)`/`test(...)`/`docs(...)` per house
  style) with its ACs green before moving on.
- **Dual review after implementation**: Opus review then Fable review of the full diff (per lane
  convention: effort high, findings adjudicated REAL against source before folding, delta rounds
  until convergence or owner checkpoint).
- After reviews converge: `gh pr ready` on PR #404, then **merge-gate ask to Kurt** — no merge
  without his word.

## Spec ambiguities hit while planning, and resolutions

1. **No prior plan.md convention exists** in this lane tree (only `.superpowers/sdd/forget-erasure/`
   run records + the unrelated #280 final-fix report). Resolution: followed the task brief's stated
   structure (T-numbers ↔ spec sections, ACs from the test plan, owner gate, dual review, PR-ready,
   merge ask).
2. **`_wrappedVacuum()` placement vs `MetadataRepository.vacuum()` scope** could be misread as one
   edit — the spec separates them (wrapper stays in the service; repository gains only the post-
   checkpoint). Plan splits them across T5 with the layering-cycle rationale pinned.
3. **Step-2 (GC) is deliberately absent** from the 8-step numbering after ruling E — the plan does
   not renumber; T6's composition lists "(2 absent — no GC)" to keep the step numbers aligned with
   the spec's citations.
4. **spec.md line 782 contains a duplicated heading** (`## Non-goals## Non-goals` with a repeated
   block) — cosmetic spec defect, not a semantic ambiguity; left untouched in this docs-only plan
   commit and flagged for the next spec touch.
5. **Test distribution**: several spec test-plan items are implemented by multiple tasks (e.g. test
   3 spans T3 and T5). Plan assigns each assertion to exactly one task's ACs; T10 only owns the
   two-tier canary, B1/task-only/source-document tiers, and the baseline gates.
