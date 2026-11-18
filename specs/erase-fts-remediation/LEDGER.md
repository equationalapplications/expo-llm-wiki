# LEDGER — erase() FTS orphan remediation (spec r5)

One checkbox per plan task. Tick only after that task's verification passes.

- [x] E1 — report shape + strategy introspection (`EraseReport.ftsOrphansCleared`, `SearchService` getters) — `86cc97c9`, controller-verified 2026-11-18
- [x] E2 — `_eraseClearFtsOrphans` implementation + `_eraseDrainPassages` rewire (D1–D4) — `8fc5d7ae`, controller-verified 2026-11-18 (F-MAJOR-1 flip expected-red until E3; plan-defect fold: WikiDiagnosticCode union member)
- [x] E3 — Path C tests + F-MAJOR-1 flip + never-FTS clean (AC9) — `94609ab6`, controller-verified 2026-11-18 (companion-in-expectation ruling folded into plan `fe0b0499`)
- [x] E4 — Path A tests + probe/clear honesty branches (AC1, AC4–AC6) — `9023ec92`, controller-verified 2026-11-18 (push readback by controller)
- [x] E5 — Path B tests (AC3) + N2 variant — `89cfa8ed`, controller-verified 2026-11-18 (N2 variant SKIPPED per plan conditional: does not compose cheaply — recorded for PR body)
- [x] E6 — determinism + pending-ledger cover (AC2, AC7, AC8) — `0d927ca4`, controller-verified 2026-11-18. NOTE: the automated AC2 test was ruled unbuildable (two blocked attempts; unreachable fixture state on real SQLite) — AC2's promise moves to the controller's manual module-less canary before merge; AC8 landed. Full core suite run = AC7. Aggregate E6 child spend ≈$1.07 (three attempts; each run under its own cap)
- [x] E7 — docs sentence + diagnostics check (AC10, AC11) — `4f41c2a9`, controller-verified 2026-11-18 (docs build green per child report)
- [x] E8 — full gate (typecheck, build, tests, docs build) — controller-verified 2026-11-18: typecheck/build/docs green, core suite 2654 tests / 231 files passed; worktree clean, branch pushed
