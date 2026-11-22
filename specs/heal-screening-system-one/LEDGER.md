# LEDGER: Step 12, heal screening from System-One (lane A)

Spec: `spec.md` (owner-approved 2026-11-22). Plan: `plan.md`.

Rules:
- Tick a box only after that task's gate passes.
- At the start of each session or wave, reconcile against the disk. If the
  ledger claims work the disk does not show, trust the disk, roll the box
  back, and log it under Reconciliation log.

## Baseline (controller-measured 2026-11-22)

| Field | Value |
|---|---|
| Measured at | lane tip `a39dc80c` (spec-only commits since `206936cc`; still valid at `09f5678b`) |
| Core suite | `cd packages/core && npx vitest run` → **255 files, 3014 tests, all passing, ~72s** |
| Typecheck | `pnpm -r typecheck` → **clean, all packages** |
| Note | In a fresh worktree, run `pnpm -r --filter './packages/*' build` first if `core-okf` fails to resolve |

## Wave runs

| Wave | Rung | Model / effort | Cap (USD) | Actual cost | Verdict | Commits |
|---|---|---|---|---|---|---|
| W0 plan | plan author | Opus 5.5 / low | 1.20 | ~0.95 | plan + ledger written | none (no commits this rung) |
| W1 baseline + leaf surfaces | | | | | | |
| W2 parse / seam / receipts / ids | | | | | | |
| W3 scenario / docs / status / bench-after | | | | | | |
| W4 rebase post-#461 + handoff | | | | | | |

## Task boxes

Wave 1
- [x] T1.1 Baseline stop-gate. Record: files 255 / tests 3014 / typecheck clean (all packages) / sha 61c54728 (code-identical to `09f5678b`; spec-only commits) / wall 75.7s (vitest), 2026-11-22
- [x] T1.2 Bench BEFORE (free measurements only). `HEAL_SYSTEM_PROMPT` = 505 chars (`packages/core/src/prompts.ts`, measured at 61c54728; token count not reported by harness); dry-run `supersession --strategy legacy --dry-run` → 25 scenarios (5 liveSkip skipped), input-token estimate 150,000; `promptVolume.ts` per-call heal-site volume: blocked — an ad-hoc `tsx -e` run of `runPromptVolume` crashed in `new WikiMemory` (`MaintenanceScheduler` options undefined), not pursued without code/bench changes. live run: not run — spend declined by controller 2026-11-22; PR body carries no measured live-run claim
- [x] T1.3 `systemOne.ts` union + key
- [x] T1.4 Codes, severity/message maps, `HealResult` fields, vocabulary test (new `heal receipt vocabulary` describe in `ontologyReceiptVocabulary.test.ts`; no existing test pinned heal maps)
- [x] T1.5 Resolvers + exports + resolver tests

Wave 2
- [x] T2.1 `HEAL_SYSTEM_PROMPT` schema. Churned prompt pins (heal string only): `__tests__/__fixtures__/guidance-golden.json` (3 lines), `__tests__/contextBudgetByteIdentity.test.ts:68`. Gate: full vitest run passes.
- [x] T2.2 Widened parse + carrier + wire compat. `healScreen.test.ts` `wire compat` describe; full vitest run passes
- [x] T2.3 Mode/floor resolution + applied-set seam. `healScreen.test.ts` `screen seam` describe; full vitest run passes
- [x] T2.4 Receipts + changed-id lists + `toEqual` churn. Churned files: `__tests__/healBounding.test.ts` (the no-candidates `toEqual` gained `downgradedIds: [], deletedIds: []`). Keyword-outage early-return test added. Wave-2 vitest: files 256 / tests 3045 passed (baseline 3024 after wave 1 + 21 new); `pnpm -r typecheck` clean. G-fence git diff NOT run by the implementer (git diff needs approval in this rung): controller to run.

Wave 3 exit G-full: vitest files 257 / tests 3054 passed (wave 2: 256 / 3045; +1 file, +9 tests = 1 scenario + 8 doc cases); `pnpm -r typecheck` 0 errors
- [x] T3.1 Withheld delete + paired restate test. `healScreen.test.ts` describe `withheld delete plus paired restatement`; `healScreen.test.ts` 22/22 passed
- [x] T3.2 Clock-set docs + doc test. Docs: `reference/configuration.md` (new `### Heal clocks and auditability` + two `systemOne` rows), `guides/maintenance.md` (Heal paragraph). Doc test `packages/core/__tests__/healScreenDocs.test.ts` (8 cases). `pnpm --filter ./apps/docs build`: 55 pages built
- [ ] T3.3 Docstrings, `types.ts` resolver list, ROADMAP Done line, spec Status. Done: `doRunHeal` header, `types.ts:425-426` one added clause (pin `:403-409` had drifted to 422-427). NOT done: ROADMAP Done line (needs merge date + PR number, which do not exist yet) and spec Status flip (controller cleanup commit after PR exists)
- [x] T3.4 Bench AFTER + PR-body table. Free tier only (controller declined `--yes` spend both passes): `HEAL_SYSTEM_PROMPT` 505 → 664 chars (+159, +31.5%; sha pair `61c54728`→`80565aad`); supersession dry-run unchanged (25 scenarios / 150k estimate). Artifacts: `.sdd/step12/bench-after.json`, `.sdd/step12/pr-body.md`. Live heal-call runs not measured — PR body states this plainly and makes no accuracy claim (INTENT rule 11).

Wave 4 (gated on PR #461 resolving)
- [ ] T4.1 Rebase onto post-#461 `main`
- [ ] T4.2 Export-surface lock test (if this lane lands second)
- [ ] T4.3 Final gate + review handoff. Final: files ___ / tests ___ / typecheck ___

## Rule-11 measurements (published with the PR)

| Metric | Before (sha) | After (sha) | Delta |
|---|---|---|---|
| `HEAL_SYSTEM_PROMPT` chars | 505 (61c54728) | | |
| `HEAL_SYSTEM_PROMPT` tokens (if reported) | | | |
| Heal-call input tokens (bench) | | | |
| Heal-call output tokens (bench) | | | |
| Heal outcome metrics (bench) | | | |

## Controller confirmations pending (plan "Detail decisions" 1-4)

- [ ] D1 lowest VALID confidence wins; unscreened only if none valid
- [ ] D2 `'applied'` receipts omit `confidence`
- [ ] D3 migration `warnOnce` only under resolved `'auto'`
- [ ] D4 guard loop byte-identical; carrier via sibling loop

## Reconciliation log

- 2026-11-22: ledger created. No code changes on disk beyond spec commits
  (HEAD `09f5678b`).
