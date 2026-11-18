# supersede(): reject an inverted or empty validity interval — ledger

In flight: Task 5 (review ladder, cleanup, ready flip) — Tasks 0–4 done 2026-11-18

- [x] Preflight — pnpm install + workspace build + baseline green — evidence: preflight ran 2026-11-18 ~11:26 ET before any tree change; install Done 5.3s; `pnpm -r --filter './packages/*' build` success; core typecheck exit 0; core test exit 0, 232 files / 2684 tests (SDD dir `preflight-*.log`/`baseline-*.log`, gitignored)
- [x] 1. RED — core + ops regression cases — evidence: commit `60c6614a`; controller cold re-run: exit 1, 6 failed (the expected six) | 28 passed incl. the 2 behavior pins (receipt `task1-red-verify.log`)
- [x] 2. GREEN — guard in supersedeInTx — evidence: commit `0549df3c`; guard verbatim at `TemporalService.ts:46-47` (after cycle check, before writes, D2); targeted 3-file suite 59 green; full core suite 232 files / 2692 green; typecheck exit 0 (controller re-run)
- [x] 3. Docs — JSDoc + guide — evidence: commit `dc6e2212`; JSDoc throws sentence mirrors expire()'s (`WikiMemory.ts:1178`); guide paragraph landed per plan Task 3 in `temporal-facts.md` `## Rules`, then expanded per spec D3.2 by the opus r1 folds (`5ca53e19`: validity-start parenthetical + same-millisecond clause); `pnpm --filter docs build` exit 0 (55 pages)
- [x] 4. Full gate + ledger reconcile — evidence: controller cold-cache run 2026-11-18 11:45 ET: typecheck exit 0 (`task4-typecheck.log`), full core test exit 0 232 files / 2692 tests (`task4-test.log`), docs build exit 0 55 pages (`task4-docsbuild.log`); LEDGER reconciled against disk this commit
- [ ] 5. Review ladder, cleanup, ready flip — evidence: pending

## Discrepancies

- Plan errata `97fb1d9d` (Task 2): pre-existing test `keeps an existing replacement valid_from` pinned a corrupt pre-start supersede (`validFrom: 99` vs start 100 — inverted interval the ratified spec D1 rejects; unfixed tree silently wrote `valid_to` 99 before start 100). Amended per errata to `validFrom: 200` / `valid_to` 200; intent (replacement keeps explicit `valid_from` 42) unchanged. Falsified plan premise: "rest of existing suite is spec-clean under the guard."
- Fable r1 MAJOR folded: `remember.test.ts` and `ontologyStatementKinds.test.ts` superseded with no `validFrom` after `remember()` — same-millisecond calls now throw `invalid_interval` by design (spec D3.2), so both tests pass explicit `validFrom: Date.now() + 1000`.
- Task 3 commit-message deviation: implementer reworded the plan's exact message; controller amended to the plan's exact string and force-pushed with lease (single-writer lane): `fb5a8edf` → `dc6e2212`.
