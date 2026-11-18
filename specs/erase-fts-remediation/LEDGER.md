# LEDGER — erase() FTS orphan remediation (spec r5)

One checkbox per plan task. Tick only after that task's verification passes.

- [x] E1 — report shape + strategy introspection (`EraseReport.ftsOrphansCleared`, `SearchService` getters) — `86cc97c9`, controller-verified 2026-11-18
- [x] E2 — `_eraseClearFtsOrphans` implementation + `_eraseDrainPassages` rewire (D1–D4) — `8fc5d7ae`, controller-verified 2026-11-18 (F-MAJOR-1 flip expected-red until E3; plan-defect fold: WikiDiagnosticCode union member)
- [ ] E3 — Path C tests + F-MAJOR-1 flip + never-FTS clean (AC9)
- [ ] E4 — Path A tests + probe/clear honesty branches (AC1, AC4–AC6)
- [ ] E5 — Path B tests (AC3) + N2 variant
- [ ] E6 — determinism + pending-ledger cover (AC2, AC7, AC8)
- [ ] E7 — docs sentence + diagnostics check (AC10, AC11)
- [ ] E8 — full gate (typecheck, build, tests, docs build)
