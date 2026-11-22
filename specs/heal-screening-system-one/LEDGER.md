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
- [ ] T1.1 Baseline stop-gate. Record: files ___ / tests ___ / typecheck ___ / sha ___
- [ ] T1.2 Bench BEFORE. Prompt chars/tokens ___ ; dry-run estimate ___ ; `--yes` approved? ___ ; measured ___
- [ ] T1.3 `systemOne.ts` union + key
- [ ] T1.4 Codes, severity/message maps, `HealResult` fields, vocabulary test
- [ ] T1.5 Resolvers + exports + resolver tests

Wave 2
- [ ] T2.1 `HEAL_SYSTEM_PROMPT` schema
- [ ] T2.2 Widened parse + carrier + wire compat
- [ ] T2.3 Mode/floor resolution + applied-set seam
- [ ] T2.4 Receipts + changed-id lists + `toEqual` churn. Churned files: ___

Wave 3
- [ ] T3.1 Withheld delete + paired restate test
- [ ] T3.2 Clock-set docs + doc test
- [ ] T3.3 Docstrings, `types.ts:403-409`, ROADMAP Done line, spec Status
- [ ] T3.4 Bench AFTER + PR-body table

Wave 4 (gated on PR #461 resolving)
- [ ] T4.1 Rebase onto post-#461 `main`
- [ ] T4.2 Export-surface lock test (if this lane lands second)
- [ ] T4.3 Final gate + review handoff. Final: files ___ / tests ___ / typecheck ___

## Rule-11 measurements (published with the PR)

| Metric | Before (sha) | After (sha) | Delta |
|---|---|---|---|
| `HEAL_SYSTEM_PROMPT` chars | | | |
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
