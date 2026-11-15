# LEDGER — source store (single-PR lane, PR #396)

Spec: `specs/source-store/spec.md` (head at plan-write: `11e62583`).
Plan: `specs/source-store/plan.md`. Baseline logs:
`.superpowers/sdd/source-store/` (gitignored scratch, absolute path
`/home/kv-thinkpad-t420-ubuntu/code/github/equationalapplications/expo-llm-wiki/.superpowers/sdd/source-store/`).

**Baseline:** GREEN (2026-11-15, run2 after clearing a stale shared
`node_modules/.vitest-cache` — ENOTEMPTY race, environment not code):
`pnpm test` full suite EXIT=0, 286 test files passed / 286, **3253 tests
passed / 3253**, zero failures. Log:
`.superpowers/sdd/source-store/baseline-test-run2.log`. Install:
`pnpm install --frozen-lockfile` clean.

**In flight:** T2 dispatched (JobManager `store` op; Claude Code sonnet/low,
brief `briefs/t2.md`, cap $0.90).

## Tasks

- [x] T1 schema + migration v17 (§3; test items 2–3) — **DONE 2026-11-15**.
      Two runs (t1 stopped on ledger-dirty guard — correct; t1b completed).
      Commit `ddd092d7` (6 files; DDL matches §3 exactly: two plain UNIQUE
      indexes incl. entity_id, no deleted_at, no passage text column;
      v17 pre-check aborts on rows/column-mismatch, empty expected-state
      passes; no-op backfill; CURRENT_SCHEMA_VERSION derives). Version-pin
      cascade folded: sourceRefNormalize/fts5RenameRetire/setupBudget
      16→17 post-migration pins (pre-migration fixtures untouched).
      Controller re-verified: typecheck EXIT=0, core suite 214 files /
      2457 tests EXIT=0 (/tmp/t1-verify-{tc,test}.log). Implementer spend
      $0.3053 (t1) + $0.2569 (t1b).
- [x] T2 `store` OperationType + conflict matrix (§10, §7; item 7) — **DONE
      2026-11-15**. Commit `f72d0b54`: `'store'` in OperationType +
      WikiBusyOperation; `_storeKey`/`_isStoreActiveFor`/lockKeyFns entry;
      store case in acquireLock + isBlocked; BOTH directions wired (14
      `_isStoreActiveFor` refs: prune, librarian/heal/ontologyBackfill,
      reembed key-suffix section, global_import, store itself);
      `releaseLock('store')` clears. New jobManagerStoreLock.test.ts (20
      tests: both-direction WikiBusyError, serialize, different-entity
      non-conflict, entity-wide ingest). Controller re-verified: TC=0,
      215 files / 2477 tests EXIT=0 (/tmp/t2-{tc,test}.log). Spend $0.3802.
- [x] T3 sha256 hasher + diagnostic codes (§3, §9) — **DONE 2026-11-15**.
      Commit `77328e32`: new pure `utils/sha256.ts` (`sha256Hex`, no deps,
      vectors match node crypto — controller verified 'abc' against
      crypto ground truth); five `source_store_*` codes in
      WikiDiagnosticCode; WikiDiagnosticOperation gains `'sourceStore'`
      (camelCase per `externalDeletion` neighbor). 216 files / 2482 tests
      EXIT=0 controller-verified (/tmp/t3-{tc,test}.log). Spend $0.3046.
- [x] T4 store write path — SourceStoreService + Maintenance deletes (§5, §7, §9; items 4, 7) — **DONE 2026-11-15**.
      Commit `ba86744c`: new SourceStoreService (`storeSource` full refusal
      matrix — invalid-arg throw, surrogate/NUL, mismatch no-op rules,
      duplicate-hash vs store + LIVE `source_ref_index` rows with
      `deleted_at IS NULL AND source_ref <> ?`, budget re-read INSIDE the
      write transaction, changed-copy hard delete, `TODO(task-6)` passage
      marker inside the transaction); MaintenanceService forget/clearAll
      hard-delete store rows in existing transactions (6 refs); 13 tests.
      Beyond-brief choices recorded: used registered
      `source_store_source_too_large` (brief typo); config read
      structurally (types.ts off-limits — add `sourceStore` to WikiConfig
      when types.ts next opens, T7/T8); refusals also fire onDiagnostic;
      budget total excludes the replaced copy; forget({sourceHash}) also
      deletes store rows. One timing flake observed (idThreading.test.ts,
      passed alone + on re-run) — watch. Controller re-verified: TC=0,
      217 files / 2495 tests EXIT=0 (/tmp/t4-{tc,test}.log). Spend $0.6004.
- [ ] T5 store read paths + listSourceRefs three-state (§4; items 4, 6)
- [ ] T6 passage index, both strategies (§6; item 5)
- [ ] T7 `sources` read option + offsets/hard-cut (§7; items 4–5)
- [ ] T8 dump import/export + skippedSources (§8; item 8)
- [ ] T9 WikiMemory wiring + formatContext (§7; items 1, 5–6)
- [ ] T10 INTENT rule 5 reword (§1) — controller-applied (protection hook)
- [ ] T11 full-suite sweep + cleanup commit (Status → Implemented, delete plan/LEDGER, roadmap mark)

## Run record

- 2026-11-15 lane pivoted to SINGLE-PR delivery (owner msgs
  `1571548310672769026` / `1571548355681853451`): spec merges together
  with implementation on this branch; ready-flip and cleanup commit are
  last. PR was briefly ready; converted back to draft.
- Deviations: none yet.
