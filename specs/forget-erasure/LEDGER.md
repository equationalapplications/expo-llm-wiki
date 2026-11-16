# LEDGER — forget-erasure (#401)

Branch `specs/forget-erasure` · baseline main `27f8e5e9` (v9.2.0) · worktree `/mnt/kv-work/build/worktrees/expo-llm-wiki/forget-erasure` (primary checkout held by PR #402's lane — untouched).
SDD progress ledger (live): `.superpowers/sdd/forget-erasure/progress.md` (gitignored).

| Date | Step | Artifact | Spend |
|---|---|---|---|
| 2026-11-16 | step-0 investigation rev 1-2 + Opus r1 (REQUEST CHANGES, 1B/5M/6m all REAL, folded) | `investigation.md`, reviews/investigation-opus-r1.json | $0.4444 |
| 2026-11-16 | Fable r1 (REQUEST CHANGES: B1 version-gate-passes-nothing, compact-time untested) | reviews/investigation-fable-r1.json | $2.7237 |
| 2026-11-16 | B′/F/G experiments + rev 3 | investigation rev 3 | — |
| 2026-11-16 | Fable r2 delta (REQUEST CHANGES: confounded harness) | reviews/investigation-fable-r2.json | $2.0252 |
| 2026-11-16 | unconfounded harness rewrite + re-run + rev 4 (F/G clean w/ option asserted off; H isolates pragma) | investigation rev 4, canary-repro.cjs | — |
| 2026-11-16 | Fable r3 delta | BLOCKED: Claude API 5-h limit, resets 15:30 ET; retry scheduled | $0.0000 |
| 2026-11-16 | spec rev 1 draft + PR opened (draft) | `spec.md`, this LEDGER | — |

Lane spend so far: **$5.1933** (all step-0; implementation not started).
Baseline gates (worktree): build OK; typecheck OK; unit — core 2565/2566 (idThreading wall-clock flake, 13/13 isolated), mcp-server 135/135, react 76/76, expo 12/12, benchmarks 154/154.
